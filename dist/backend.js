// @bun
// src/core/ports.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var DEFAULT_CACHE_RETENTION = "short";

// src/core/util.ts
function limitOf(limit) {
  return limit === null ? Number.POSITIVE_INFINITY : limit;
}
var TIMER_MAX_MS = 2147483647;
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

// src/core/recall/ports.ts
var EMBED_BATCH_MAX = 256;
var EMBED_TEXT_MAX = 8192;

// src/core/recall/settings.ts
function defaultRecallSettings() {
  return {
    prompt: { lore: true, loreChars: 2400, index: true, indexChars: 3000, indexOff: false, recent: 6, history: true, historyChars: 900 },
    lore: { titleWeight: 4, keyWeight: 3, lines: 2, queries: 6, reads: 8, links: 12 },
    writer: { add: true, drop: true, addEntries: 8, addChars: 12000 },
    chat: { queries: 6, stretchGap: 6, stretchHits: 2, lines: 2, around: 3, trail: 8, gapMinutes: 240, stretchMessages: 40, openingChars: 160, kept: 4 },
    grep: { pieceChars: 2000, ms: 2000, sliceMs: 20 },
    meaning: { enabled: false, callMs: 30000, tokensPerDay: 2000000, batch: 64, textChars: 6000, weight: 0.5, floor: 0.3, matches: 20, usdPerMillion: null },
    chronicle: { pin: true, pinChars: 3000, remind: true, tail: 20, stretchMessages: 60, stretchChars: 36000, estimateSent: 4, estimateWritten: 0.25, estimateRounds: 4 },
    memory: { hits: 8, facts: 20, relations: 12, entities: 30 },
    databanks: { indexChars: 2000000 },
    web: { results: 5, pages: false, pageChars: 3000 }
  };
}
var whole = (title, description, minimum, unit, maximum) => ({ title, description, type: "integer", minimum, ...maximum !== undefined ? { maximum } : {}, ...unit !== undefined ? { "x-unit": unit } : {} });
var amount = (title, description, minimum, maximum) => ({ title, description, type: "number", minimum, maximum });
var flag = (title, description) => ({ title, description, type: "boolean" });
var RECALL_SETTINGS_SCHEMA = {
  title: "Lore and history",
  description: "What the agents are told of the lore and the chat without asking, how their lore and chat tools search and answer, the lore the writer sees, search by meaning, and the chronicle.",
  type: "object",
  properties: {
    prompt: {
      title: "What the prompt already holds",
      description: "Three notes the main agent is given with each request, so most turns need no lookup to know what exists. Each note's wording is a text of its own.",
      type: "object",
      properties: {
        lore: flag("Lore in the prompt", "Tell the main agent which lore entries the prompt holds, and how each got there."),
        loreChars: whole("Lore in the prompt: length", "That list at most. Entries past it are counted.", 200, "characters"),
        index: flag("Lore not in the prompt", "Tell it which entries of the chat's books the prompt doesn't hold: id, title, keys and length, the best match for the latest messages first."),
        indexChars: whole("Lore not in the prompt: length", "That index at most. Entries past it are counted; lore_index lists them all.", 200, "characters"),
        indexOff: flag("List entries switched off", "The index lists the entries you switched off in their books too."),
        recent: whole("Latest messages it is ordered by", "The index is ordered by how well each entry matches this many of the chat's latest messages.", 1, "messages"),
        history: flag("History in the prompt", "Tell it which chat messages the prompt holds word for word, which it doesn't, and what stands in for those."),
        historyChars: whole("History in the prompt: length", "That note at most.", 200, "characters")
      }
    },
    lore: {
      title: "Lore tools",
      type: "object",
      properties: {
        titleWeight: amount("Weight of a title", "How much a query's word counts in an entry's title, against 1 in its text.", 0, 100),
        keyWeight: amount("Weight of a key", "How much a query's word counts among an entry's keys, against 1 in its text.", 0, 100),
        lines: whole("Best lines per hit", "The lines a lore search shows of each entry it found.", 1, "lines"),
        queries: whole("Queries per call", "The queries one lore_search call may carry.", 1, "queries"),
        reads: whole("Entries per read", "The entries one lore_read call may name.", 1, "entries"),
        links: whole("Linked entries listed", "The entries lore_related and lore_about list each way.", 1, "entries")
      }
    },
    writer: {
      title: "The lore the writer sees",
      description: "With write_reply the main agent may add lore entries to the writer's request and take entries out of it, each whole and by its id.",
      type: "object",
      properties: {
        add: flag("Add entries", "The main agent may add entries to the writer's request."),
        drop: flag("Drop entries", "The main agent may take entries Lumiverse activated out of the writer's request."),
        addEntries: whole("Entries added per reply", "The most entries one reply may add.", 0, "entries"),
        addChars: whole("Text added per reply", "The most text the added entries may hold together.", 0, "characters")
      }
    },
    chat: {
      title: "History tools",
      type: "object",
      properties: {
        queries: whole("Queries per call", "The queries one chat_search call may carry.", 1, "queries"),
        stretchGap: whole("A stretch", "Hits no further apart than this many messages are shown as one stretch of the chat.", 0, "messages"),
        stretchHits: whole("Hits per stretch", "The hits a chat search shows of one stretch, so one exchange doesn't fill the page. The rest are counted.", 1, "hits"),
        lines: whole("Best lines per hit", "The lines a chat search shows of each message it found.", 1, "lines"),
        around: whole("Messages around one", "The messages chat_around shows each side of the one asked for, when the call names none.", 0, "messages"),
        trail: whole("Lines of a trail", "The most telling lines chat_about shows of a name or a phrase.", 1, "lines"),
        gapMinutes: whole("A break in the outline", "Without a book or arcs, chat_outline breaks the chat where two messages are this far apart in time.", 1, "minutes"),
        stretchMessages: whole("Messages per outline part", "The messages one part of that outline holds at most.", 2, "messages"),
        openingChars: whole("An outline part's opening", "How much of a part's opening lines that outline shows.", 20, "characters"),
        kept: whole("Chats indexed in memory", "The chats whose search index is kept in memory between turns. A chat past it is indexed again when it is next searched.", 1, "chats")
      }
    },
    grep: {
      title: "Search by text or pattern",
      description: "chat_grep and lore_grep find lines by exact text or by a regular expression. A pattern that could take very long is refused, a line is matched a piece at a time, and a search gives way and stops at its time limit, so no pattern holds LumiAH.",
      type: "object",
      properties: {
        pieceChars: whole("Piece of a line", "A pattern is matched against this much of a line at once. A longer line is matched a piece at a time, each piece overlapping the last by half, so a match up to half this long is found wherever it stands. A longer piece finds longer matches and makes the slowest patterns slower.", 100, "characters", 4000),
        ms: whole("Time for one search", "A search that takes longer stops and tells the agent to narrow it.", 10, "ms", TIMER_MAX_MS),
        sliceMs: whole("Gives way after", "How long a search works at a time before it lets whatever else waits go on: a Stop, another agent.", 1, "ms", TIMER_MAX_MS)
      }
    },
    meaning: {
      title: "Search by meaning",
      description: "With an embedding connection in Lumiverse, a vector is kept for each lore entry and each chat message, so a search also finds what says the same in other words. It is off until you switch it on: it sends the text of the chat's messages and of its lore entries to your embedding provider, and costs what that provider charges.",
      type: "object",
      properties: {
        enabled: flag("Search by meaning", "Keep vectors and merge matches by meaning into lore_search and chat_search. Off, or without an embedding connection, search is by word and nothing is sent to an embedding provider."),
        callMs: whole("Time per embedding call", "An embedding call that takes longer is let go: the search it held goes on by word, and its texts wait for a later try.", 100, "ms", TIMER_MAX_MS),
        tokensPerDay: { title: "Embedded per day", description: "The most tokens embedded in any 24 hours, as estimated. Texts past it wait for the next day.", type: ["integer", "null"], minimum: 0, "x-unit": "tokens", "x-none": "No limit" },
        batch: whole("Texts per call", "The texts one embedding call carries.", 1, "texts", EMBED_BATCH_MAX),
        textChars: whole("Text embedded", "How much of an entry or a message is embedded: its start, this long at most.", 100, "characters", EMBED_TEXT_MAX),
        weight: amount("Weight of meaning", "How much a match by meaning counts beside a match by word: 0 for not at all, 1 for meaning alone.", 0, 1),
        floor: amount("Least similarity", "A text counts as a match by meaning from this similarity to the query up.", 0, 1),
        matches: whole("Matches by meaning per query", "The matches by meaning one query brings to a search.", 1, "matches"),
        usdPerMillion: { title: "Price of embedding", description: "What your embedding model costs. Lumiverse reports no cost for embeddings, so the cost shown is worked out from this.", type: ["number", "null"], minimum: 0, "x-unit": "USD per million tokens", "x-none": "Unknown" }
      }
    },
    chronicle: {
      title: "The chronicle",
      description: "What the story has established, kept in learned/chronicle/ with a citation of the messages each line rests on.",
      type: "object",
      properties: {
        pin: flag("Pin the chronicle", "Give the main agent the top of the chronicle with each request. Lines whose citations match no message of the chat are left out."),
        pinChars: whole("Pinned chronicle: length", "The pinned part at most.", 200, "characters"),
        remind: flag("Remind it to keep the chronicle", "The pinned part ends with a line that says whether the chronicle wants bringing up to date, and how to start the chronicler for it with the reply. Off, the chronicle is kept only when you run the chronicler yourself."),
        tail: whole("Bring up to date after", "The main agent is told to have the chronicle brought up to date once the chat is more than this many messages past it. Under that it starts a job only when a reply changes something the chronicle states.", 1, "messages"),
        stretchMessages: whole("Messages per reader", "The chronicler hands the chat to readers a stretch at a time, each in a session of its own: the messages one reader is given at most.", 1, "messages"),
        stretchChars: whole("Text per reader", "The same stretch in characters at most.", 1000, "characters"),
        estimateSent: amount("Estimate: sent per token of chat", "Before you start a job that learns a chat's story, the Chronicle page says about how much it will take, reckoned from the messages the chronicle doesn't cover yet. This is the prompt tokens such a job sends for each token of chat still to read: readers send their stretch more than once, and the chronicler carries the lines they return. Raise or lower it if your jobs come out differently.", 0, 1000),
        estimateWritten: amount("Estimate: written per token of chat", "For the same estimate: the tokens a job writes for each token of chat still to read.", 0, 1000),
        estimateRounds: amount("Estimate: rounds per stretch", "For the same estimate: the rounds of tool calls each stretch takes, its reader's and the chronicler's share.", 0, 1000)
      }
    },
    memory: {
      title: "Lumiverse's memory",
      type: "object",
      properties: {
        hits: whole("Memories per search", "What memory_search asks the Memory Cortex for at most.", 1, "memories"),
        facts: whole("Facts per entity", "The facts memory_entity shows of a person or a thing.", 1, "facts"),
        relations: whole("Relations per entity", "The relations memory_entity shows.", 0, "relations"),
        entities: whole("Entities named", "The entities memory_entity names when the one asked for isn't known.", 1, "entities")
      }
    },
    databanks: {
      title: "Databanks",
      type: "object",
      properties: {
        indexChars: whole("Documents read in", "The most text of the chat's databank documents read in for databank_search. Documents past it are listed and can be read, and aren't searched.", 1000, "characters")
      }
    },
    web: {
      title: "Web search",
      type: "object",
      properties: {
        results: whole("Results per search", "The results web_search asks your provider for.", 1, "results"),
        pages: flag("Read the pages", "web_search reads the pages it finds too, where the call doesn't say, as many as your Lumiverse setting allows."),
        pageChars: whole("Page text shown", "How much of each page's text web_search shows.", 100, "characters")
      }
    }
  }
};

// src/core/story.ts
var STORY_DEFAULTS = { hidden: "leave_out", from: "lumiverse", newest: "directive" };
var STORY_MEMBERS = ["hidden", "from", "newest"];
var VALUES = {
  hidden: ["leave_out", "include"],
  from: ["lumiverse", "everyone", "replies"],
  newest: ["directive", "leave_out"]
};
function storyValue(member, value) {
  return VALUES[member].includes(value);
}
function storyWordOf(raw) {
  if (!isRecord(raw))
    return {};
  const out = {};
  if (storyValue("hidden", raw.hidden))
    out.hidden = raw.hidden;
  if (storyValue("from", raw.from))
    out.from = raw.from;
  if (storyValue("newest", raw.newest))
    out.newest = raw.newest;
  return out;
}
function storyHolds(words) {
  const { claim, chat, user } = words;
  const settle = (member) => {
    const claimed = claim?.[member];
    if (claimed !== undefined)
      return { value: claimed, by: "claim" };
    const chosen = chat?.[member];
    return chosen !== undefined ? { value: chosen, by: "chat" } : { value: user[member], by: "user" };
  };
  const hidden = settle("hidden");
  const from = settle("from");
  const newest = settle("newest");
  const follows = from.value === "lumiverse";
  const whose = from.value === "lumiverse" ? words.sovereignHand === true ? "replies" : "everyone" : from.value;
  return {
    source: { hidden: hidden.value, from: whose, newest: newest.value },
    by: { hidden: hidden.by, from: from.by, newest: newest.by },
    ...follows ? { sovereignHand: words.sovereignHand } : {}
  };
}

// src/core/text-def.ts
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
  writeReply: "write_reply",
  replyWrite: "reply_write",
  workspaceList: "workspace_list",
  workspaceRead: "workspace_read",
  workspaceGrep: "workspace_grep",
  workspaceWrite: "workspace_write",
  workspaceEdit: "workspace_edit",
  workspaceMove: "workspace_move",
  workspaceDelete: "workspace_delete",
  workspacePin: "workspace_pin",
  skillLoad: "skill_load",
  delegate: "delegate",
  agentMessage: "agent_message",
  jobStart: "job_start",
  jobList: "job_list",
  jobRead: "job_read",
  jobCancel: "job_cancel",
  bookOutline: "book_outline",
  bookRead: "book_read",
  loreRelated: "lore_related",
  loreAbout: "lore_about",
  chatOutline: "chat_outline",
  chatAbout: "chat_about",
  chatAround: "chat_around",
  chronicleCheck: "chronicle_check",
  memorySearch: "memory_search",
  memoryEntity: "memory_entity",
  memoryArcs: "memory_arcs",
  databankList: "databank_list",
  databankSearch: "databank_search",
  databankRead: "databank_read",
  webSearch: "web_search"
};
var FAMILY = {
  chat: "chat",
  lore: "lore",
  preset: "preset",
  session: "session",
  reply: "reply",
  workspace: "workspace",
  skills: "skills",
  agents: "agents",
  jobs: "jobs",
  book: "book",
  chronicle: "chronicle",
  memory: "memory",
  databanks: "databanks",
  web: "web"
};
var toolId = (name) => `tool.${name}`;
var toolArgId = (name, arg) => `tool.${name}.${arg}`;
var v = (name, text, required) => required ? { name, text, required } : { name, text };
var GROUP = {
  runtime: "Every agent",
  stops: "Why an agent stopped",
  main: "Main agent",
  request: "The request, as the main agent reads it",
  writer: "Writer",
  session: "Session",
  agents: "Agents, skills and guidance",
  workspace: "Workspace",
  jobs: "Jobs",
  approval: "Approval",
  side: "Side sessions",
  book: "A story's book",
  recall: "Lore and history",
  tools: "Tools",
  answers: "Tool answers",
  progress: "Progress lines",
  words: "Words"
};
function toolTexts(name, description, args) {
  return [
    { id: toolId(name), group: GROUP.tools, label: `${name}: what it does`, note: `The description of the ${name} tool, as the model is offered it.`, text: description, vars: [] },
    ...Object.entries(args).map(([arg, text]) => ({ id: toolArgId(name, arg), group: GROUP.tools, label: `${name}: ${arg}`, note: `The description of ${name}'s ${arg} argument.`, text, vars: [] }))
  ];
}
var CURSOR_ARG = "Where to go on from: the cursor the last answer gave you. Leave it out to start at the beginning.";
var word = (id, one, many) => ({ id, group: GROUP.words, label: `${one}, ${many}`, note: `The word a count of these takes in answers, notes and stops: for one, then for several, with | between ("1 ${one}", "3 ${many}").`, text: `${one}|${many}`, vars: [] });
var stopText = (id, label, note, text, vars = []) => ({ id, group: GROUP.stops, label, note: `${note} The reason an agent that stopped so gives, in the live view and to whoever started it.`, text, vars });

// src/core/settings.ts
var AGENT = { main: "main", writer: "writer", summarizer: "summarizer" };
var CORE_AGENTS = Object.values(AGENT);
var ADDED_TOOLS = "@added";
var MAIN_TOOLS = [
  TOOL.chatSearch,
  TOOL.chatGrep,
  TOOL.chatRead,
  TOOL.bookOutline,
  TOOL.bookRead,
  TOOL.loreIndex,
  TOOL.loreSearch,
  TOOL.loreGrep,
  TOOL.loreRead,
  TOOL.activeLore,
  TOOL.presetInstructions,
  TOOL.pastTurn,
  TOOL.workspaceList,
  TOOL.workspaceRead,
  TOOL.workspaceGrep,
  TOOL.workspaceWrite,
  TOOL.workspaceEdit,
  TOOL.workspaceMove,
  TOOL.workspaceDelete,
  TOOL.workspacePin,
  TOOL.skillLoad,
  TOOL.delegate,
  TOOL.agentMessage,
  TOOL.jobStart,
  TOOL.jobList,
  TOOL.jobRead,
  TOOL.jobCancel,
  TOOL.writeReply,
  TOOL.chatOutline,
  TOOL.chatAbout,
  TOOL.chatAround,
  TOOL.loreRelated,
  TOOL.loreAbout,
  TOOL.chronicleCheck,
  TOOL.memorySearch,
  TOOL.memoryEntity,
  TOOL.memoryArcs,
  TOOL.databankList,
  TOOL.databankSearch,
  TOOL.databankRead,
  ADDED_TOOLS
];
var SUMMARIZER_TOOLS = [TOOL.chatSearch, TOOL.chatGrep, TOOL.chatRead, TOOL.bookOutline, TOOL.bookRead, TOOL.loreSearch, TOOL.loreRead, TOOL.workspaceList, TOOL.workspaceRead, TOOL.workspaceGrep];
var CORE_TOOLS = [...MAIN_TOOLS, TOOL.webSearch, TOOL.replyWrite, ...Object.values(FAMILY).map((family) => `@${family}`)];
function defaultSettings() {
  const unlimited = { callTokensIn: null, callMs: null, callTools: null, tokensIn: null, tokensOut: null, wallMs: null };
  return {
    reply: { writer: "writer", briefAt: "before_last_user", briefRole: "system", withoutBrief: "write", progress: true, progressChars: 160, writerGuidance: false },
    story: { ...STORY_DEFAULTS },
    agents: {
      [AGENT.main]: { connectionId: null, model: null, effort: "inherit", tools: [...MAIN_TOOLS], toolCalls: "auto", budget: { ...unlimited, callTokensOut: 16000, toolTurns: 24, revisions: 2, concurrency: 4 } },
      [AGENT.writer]: { connectionId: null, model: null, effort: "inherit", tools: [], toolCalls: "auto", budget: { ...unlimited, callTokensOut: 8192, toolTurns: 8, revisions: 1, concurrency: 4 } },
      [AGENT.summarizer]: { connectionId: null, model: null, effort: "inherit", tools: [...SUMMARIZER_TOOLS], toolCalls: "auto", budget: { ...unlimited, callTokensOut: 16000, toolTurns: 12, revisions: 1, concurrency: 4 } }
    },
    turn: { tokensIn: null, tokensOut: null, toolTurns: null, wallMs: null },
    loop: { repeats: 3, clipChars: 6000, thinkingInToolLoops: true, stream: true, charsPerToken: 3.2, retries: 2, retryWaitMs: 2000, answerFloor: 256, warnRounds: 2, cutRoomFactor: 2, cutRoomTokens: 64000 },
    cache: { retention: DEFAULT_CACHE_RETENTION, key: "" },
    connections: { atOnce: null, throttles: {}, toolRefusalMinutes: 60 },
    prices: {},
    session: { summarizeAtTokens: 32000, keepTurns: 3, summaryTokens: 6000, receiptChars: 600, receiptArgChars: 600, rollbackMarginTokens: 8000 },
    tools: { pageChars: 4000, pageItems: 10, lineChars: 300, excerptChars: 400, pieceChars: 600, chatBatch: 200, grepTurns: 40 },
    keep: { prompts: true, transcripts: true, blobChars: 4000000, summaries: 32, promptDays: 30, transcriptDays: 90, spanDays: null, graceHours: 24 },
    trace: { deltaMs: 200 },
    workspace: { fileChars: 200000, files: 400, areaChars: 4000000, pathChars: 200, versions: 10, pinChars: 12000, agentsPinUser: false },
    guidance: { chars: 8000, agentsEdit: false },
    skills: { listChars: 4000 },
    delegation: { depth: 2, atOnce: 3, perRun: 12, grant: "own", fileChars: 12000, asChars: 200, replyHoldChars: 200 },
    jobs: { enabled: true, atOnce: 1, perRun: 3, budget: { tokensIn: 600000, tokensOut: 60000, toolTurns: 60, wallMs: 900000 }, tokensPerDay: 3000000, taskChars: 4000, openingChars: 600, recordWaitMs: 120000, chain: true, delegations: null, dueWaitMs: 60000 },
    approval: { tiers: { read: "allow", write: "allow", external: "allow" }, tools: {}, waitMs: 300000 },
    spend: { tokensPerDay: null, costPerDay: null, cachedWeight: 0.1 },
    extension: { waitMs: 1e4 },
    recall: defaultRecallSettings()
  };
}
var limit = (title, description, unit, minimum = 1) => ({ title, description, type: ["integer", "null"], minimum, "x-unit": unit, "x-none": "No limit" });
var whole2 = (title, description, minimum, unit, maximum) => ({ title, description, type: "integer", minimum, ...maximum !== undefined ? { maximum } : {}, ...unit !== undefined ? { "x-unit": unit } : {} });
var flag2 = (title, description) => ({ title, description, type: "boolean" });
var choice = (title, description, options) => ({ title, description, type: "string", oneOf: options.map(([value, name, about]) => ({ const: value, title: name, ...about !== undefined ? { description: about } : {} })) });
var EFFORTS = [
  ["inherit", "As the connection has it", "The connection's own effort; where it sets none, the provider's default."],
  ["off", "Off"],
  ["auto", "Set by the model", "The connection's own effort, as with As the connection has it: for a model that chooses its own."],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Maximum"]
];
var TOOL_CALLS = [
  ["auto", "Native, else as text", "Native tool calls where the connection takes them. Once it refuses them, the tools are described in the prompt and the model writes its calls; native calls are tried again after a time (Connections)."],
  ["native", "Native only", "Always native tool calls. A connection that refuses them fails the call."],
  ["text", "As text", "The tools are described in the prompt and the model writes its calls: for a model that calls tools better that way."]
];
var BUDGET_SCHEMA = {
  title: "Budget",
  description: "What this agent may spend on one message it is sent. A limit that stops it says so in the live view.",
  type: "object",
  properties: {
    callTokensIn: limit("Prompt per call", "The most one call may send, in tokens, as estimated before it is sent. A call past it isn't made. A tool result that would take the next call past it reaches the model cut to the room left, and the rest waits for scratch_read.", "tokens"),
    callTokensOut: whole2("Answer per call", "The most one call may write, its reasoning included (max_tokens). The writer's is the request's own where the request names one.", 1, "tokens"),
    callMs: limit("Time per call", "How long one call may take before it is given up.", "ms"),
    callTools: limit("Tool calls per answer", "The most tools one answer may call. Calls past it aren't run, and the model is told.", "calls"),
    tokensIn: limit("Prompt tokens per agent", "The most all of its calls may send.", "tokens"),
    tokensOut: limit("Answer tokens per agent", "The most all of its calls may write.", "tokens"),
    toolTurns: limit("Tool rounds per agent", "The most answers that call tools. Past it the agent is stopped.", "rounds", 0),
    wallMs: limit("Time per agent", "How long it may work from the moment it is sent its first message.", "ms"),
    revisions: whole2("Revisions", "Messages it may be sent after its first answer.", 0, "messages"),
    concurrency: whole2("Tool calls at once", "How many of one answer's tool calls run at the same time.", 1, "calls")
  }
};
function agentSchema(title, description, noConnection, noModel, tools, toolsOwned = false) {
  return {
    title,
    description,
    type: "object",
    properties: {
      connectionId: { title: "Connection", description: "One of the runtime's connections (Runtime \u2192 Connections) its calls go on. One that is gone leaves it on the default connection.", type: ["string", "null"], format: "connection", "x-none": noConnection },
      model: { title: "Model", description: "A model of that connection to use instead of the connection's own.", type: ["string", "null"], format: "model", "x-none": noModel },
      effort: choice("Effort", "How hard its model reasons on each call.", EFFORTS),
      toolCalls: choice("Tool calls", "How its tools are offered to its model.", TOOL_CALLS),
      tools: toolsOwned ? { title: "Tools", description: "Its tools belong to the extension. You change them on that extension's own pages, not here.", type: "array", items: { type: "string" }, readOnly: true } : { title: "Tools", description: "The tools it is given: each by its name, or @family for every tool of a family, those added to it later too. @added is every tool you added: those of the MCP servers you switched on for agents, and an extension's. scratch_read comes with any of them, for results that come back clipped.", type: "array", items: { type: "string", enum: [...tools] }, uniqueItems: true },
      budget: BUDGET_SCHEMA
    }
  };
}
var price = (title, description) => ({ title, description, type: "number", minimum: 0, "x-unit": "USD per million tokens" });
var CORE_SCOPE = { tools: CORE_TOOLS, agents: [] };
var RULES = [
  ["allow", "Run", "The call runs at once."],
  ["ask", "Ask me", "The call waits for you: approve it once, approve the tool for this chat, or refuse it with a reason the agent is given."]
];
function agentsSchema(scope) {
  return {
    title: "Agents",
    description: "What each agent runs with. What it is and what it is told are its definition's.",
    type: "object",
    properties: {
      [AGENT.main]: agentSchema("Main agent", "Works out what each reply needs, with tools, then briefs the writer or writes the reply itself.", "Your default connection", "The connection's own", scope.tools),
      [AGENT.writer]: agentSchema("Writer", "Writes the reply from the prompt Lumiverse assembled and the main agent's brief. Its sampling and answer length are your preset's. It has no tools unless you give it some; with tools, whatever it writes beside its calls is part of the reply.", "Your default connection", "The connection's own", scope.tools),
      [AGENT.summarizer]: agentSchema("Summarizer", "Summarizes the main agent's notes once they grow past Summarize past (that call takes no tools), and whatever another agent delegates to it. With no connection of its own it runs where the main agent does.", "The main agent's", "The main agent's, or its own connection's", scope.tools),
      ...Object.fromEntries(scope.agents.filter((a) => !CORE_AGENTS.includes(a.id)).map((a) => [a.id, agentSchema(a.label, a.note, "Your default connection", "The connection's own", scope.tools, a.owns?.includes("tools") === true)]))
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
        progress: flag2("Progress lines", "Write what the main agent is doing into the reply's thinking block as it works."),
        progressChars: whole2("Progress line length", "The most characters one progress line holds.", 20, "characters"),
        writerGuidance: flag2("Give the writer your guidance", "Put the guidance your agents are given (yours, the character's, the chat's) beside the brief in the writer's prompt. Off, the writer is sent the prompt as Lumiverse assembled it with the brief alone, and the main agent carries into the brief what of your guidance bears on the prose.")
      }
    },
    story: {
      title: "What counts as the story",
      description: "Which of a chat's messages the agents read as its story. A chat can choose otherwise on Home, and an extension that answers a chat may set it there.",
      type: "object",
      properties: {
        hidden: choice("Messages you hid", "Messages you hid from the prompt in Lumiverse.", [
          ["leave_out", "Leave out", "The agents never read them, and their answers say how many were left out."],
          ["include", "Read them", "The agents read them like any other message."]
        ]),
        from: choice("Whose messages", "Whose messages are the story.", [
          ["lumiverse", "As Lumiverse", "Only the model's replies while Sovereign Hand is on in Lumiverse, everyone's while it is off. Where Lumiverse doesn't say, everyone's."],
          ["everyone", "Everyone's", "Your messages and the model's replies."],
          ["replies", "Replies only", "Only the model's replies. Your messages are directions to the model, not part of the story."]
        ]),
        newest: choice("Your newest message", "With only the model's replies: what the main agent is given of your newest message.", [
          ["directive", "As direction", "It is given to the main agent as the direction for the reply."],
          ["leave_out", "Leave out", "It isn't given: your preset already carries it."]
        ])
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
        repeats: whole2("Loop detector", "An agent that makes the same tool call, on the same state, this many times in a row is stopped.", 2, "calls"),
        clipChars: whole2("Tool results clipped past", "A tool result longer than this reaches the model clipped; scratch_read reads the rest. A tool that bounds its own answer by a setting of its own, meant to be read in one go, is clipped only past that instead.", 200, "characters"),
        thinkingInToolLoops: flag2("Thinking in tool loops", "Let a model reason on calls that offer tools. Turn it off for a connection that fails when a reasoning model's thinking must be sent back after a tool call."),
        stream: flag2("Streaming", "Take every answer as the provider streams it, so a long answer's connection is never idle. The writer's reply streams either way."),
        charsPerToken: { title: "Characters per token", description: "For token estimates made before a provider reports its own count: budgets, and the length of the main agent's notes.", type: "number", minimum: 1, maximum: 8 },
        retries: whole2("Retries", "A model call that fails in passing (a timeout, a rate limit, a provider error in the 500s, a stream that drops, an answer that arrives garbled) is made again up to this many times, each shown in the live view. Never once part of the reply has reached you, and never a call one of your own limits stopped. 0 turns retries off.", 0, "retries"),
        retryWaitMs: whole2("Wait before a retry", "How long to wait before a failed call is made again. The agent's and the turn's time limits still run while it waits.", 0, "ms", TIMER_MAX_MS),
        answerFloor: whole2("Least answer room", "A call isn't made with less room for its answer than this. An agent whose answer tokens (its own, or its turn's) are that close to spent stops and says so, instead of writing an answer that would be cut.", 1, "tokens"),
        warnRounds: whole2("Rounds left warning", "An agent is told when it has this many rounds of tool calls left, so it can finish with what it has. 0 for never.", 0, "rounds"),
        cutRoomFactor: whole2("More room after a cut answer", "When a model's answer runs out of room while it is still thinking, before it writes anything or calls a tool, the call is made once more with its room times this, and the model is told to think briefly and act. 1 gives it the same room.", 1, "times"),
        cutRoomTokens: whole2("Most room after a cut answer", "The most answer room that second go may have.", 1, "tokens")
      }
    },
    cache: {
      title: "Prompt caching",
      description: "Each agent's calls share its prompt with the provider's cache, so a call reads again what the one before it sent at a fraction of the price.",
      type: "object",
      properties: {
        retention: choice("Kept for", "How long the provider keeps an agent's prompt in its cache. A provider that bills for writing to its cache bills a longer keep at more.", [
          ["none", "Not cached", "Every call sends its prompt anew."],
          ["short", "A few minutes", "The provider's own default."],
          ["long", "About an hour", "Where the provider offers it; elsewhere, its own default."]
        ]),
        key: { title: "Cache key", description: "Text put at the head of every agent's prompt. Change it to make a provider's cached prompts miss; leave it empty to send none. The writer's prompt is your preset's alone and never carries it.", type: "string", maxLength: 64 }
      }
    },
    connections: {
      title: "Connections",
      description: "How fast agents may call each connection.",
      type: "object",
      properties: {
        atOnce: limit("Calls at once", "Calls under way at once on any connection whose own throttle sets none. A call past it waits.", "calls"),
        toolRefusalMinutes: limit("Native tools tried again after", "A connection's model that refused native tools is sent them as text for this long; then native tools are tried again. None: until the runtime restarts.", "minutes"),
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
      description: "Per model. Where a provider reports no cost, a call's cost is worked out from these and shown as an estimate. A model priced here goes by this price; one not priced here goes by the provider's published price where the runtime knows it, also an estimate.",
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
        keepTurns: whole2("Recent turns kept whole", "The latest turns that stay as they are after a summary.", 0, "turns"),
        summaryTokens: whole2("Summary length", "How long a summary may be, as its instructions ask.", 100, "tokens"),
        receiptChars: whole2("Receipt length", "How much of each tool result the notes keep of a past turn. past_turn reads the whole.", 0, "characters"),
        receiptArgChars: whole2("Receipt length: arguments", "How much of each tool call's arguments the notes keep of a past turn: a file it wrote or a long brief is kept by its start. past_turn reads the whole.", 0, "characters"),
        rollbackMarginTokens: whole2("After a rollback", "Once you roll a summary back, the notes aren't summarized again until they have grown by this many tokens since, or you ask for it on the Sessions page.", 0, "tokens")
      }
    },
    tools: {
      title: "Tool answers",
      description: "How much one tool answer holds. A longer one comes in pages, each naming the cursor for the next.",
      type: "object",
      properties: {
        pageChars: whole2("Answer length", "The most characters one tool answer holds. Keep it under Tool results clipped past, so answers are paged and not clipped.", 200, "characters"),
        pageItems: whole2("Hits per page", "The most hits or lines one page of a search or a listing shows.", 1, "items"),
        lineChars: whole2("Line length", "A line a grep found is shown at most this long, around what it found.", 40, "characters"),
        excerptChars: whole2("Excerpt length", "A search hit's excerpt, at most.", 40, "characters"),
        pieceChars: whole2("Search piece", "A text is indexed for search in pieces of about this size; a hit shows the piece that matched best.", 100, "characters"),
        chatBatch: whole2("Chat read batch", "Messages read from the chat in one request to Lumiverse.", 1, "messages"),
        grepTurns: whole2("Turns a grep reads", "How many of the main agent's latest turns past_turn searches when no reply is named.", 1, "turns")
      }
    },
    keep: {
      title: "What is kept",
      type: "object",
      properties: {
        prompts: flag2("Exact prompts", "Store each model call's exact prompt, for the live view and the Sessions page."),
        transcripts: flag2("Transcripts", "Store each turn's transcript, for the Sessions page."),
        blobChars: whole2("Texts in memory", "Characters of stored texts the runtime keeps in memory once read.", 0, "characters"),
        summaries: whole2("Summaries in memory", "Summaries the runtime remembers, so a swipe of a turn that summarized makes no second call.", 0, "summaries"),
        promptDays: limit("Prompts kept for", "How long a model call's exact prompt is kept. After it the sweep removes it, and the live view and the Sessions page no longer show that call's prompt.", "days"),
        transcriptDays: limit("Transcripts kept for", "How long a turn's, a job's or a side session's transcript is kept. After it the sweep removes it, and the Sessions page shows that turn without its steps.", "days"),
        spanDays: limit("Summarized turns kept for", "How long the turns a summary replaced are kept after it. After it the sweep removes them, and that summary can no longer be rolled back.", "days"),
        graceHours: whole2("Sweep leaves alone", "A stored text younger than this is never swept: a turn or a job still at work hasn't yet written what refers to it.", 1, "hours")
      }
    },
    trace: {
      title: "The live view",
      type: "object",
      properties: {
        deltaMs: whole2("Live answer every", "While a model's answer streams, the live view is sent what has arrived at most once in this long, so you watch it being written. 0 turns it off: the view then shows each answer once it is whole.", 0, "ms")
      }
    },
    workspace: {
      title: "The workspace",
      description: "The files agents keep: the chat's own, which follow the story as your swipes and edits do; learned/, kept with the chat whatever path it takes; and ~/, yours, shared by all your chats.",
      type: "object",
      properties: {
        fileChars: whole2("File length", "The most characters one file holds. A longer write is refused, and the agent is told to split it.", 1000, "characters"),
        files: whole2("Files per area", "The most files one area holds.", 1, "files"),
        areaChars: whole2("Area size", "The most characters an area's files hold together.", 1000, "characters"),
        pathChars: whole2("Path length", "The most characters a file's path holds.", 20, "characters"),
        versions: whole2("Versions kept", "How many earlier versions of a file its history keeps. An older one can be compared with and restored on the Workspace page.", 0, "versions"),
        pinChars: whole2("Pinned files in context", "The most characters of pinned files an agent is given each turn. Past it the rest are named, with how to read them.", 0, "characters"),
        agentsPinUser: flag2("Agents may pin your own files", "Let an agent pin and unpin files in ~/, your own area. A file pinned there is put in the agent's context in every chat, so off, only you pin there, on the Workspace page.")
      }
    },
    guidance: {
      title: "Guidance",
      description: "Markdown every agent is given as part of its instructions: yours (~/GUIDANCE.md), the character's or the one an extension names, and the chat's (learned/GUIDANCE.md), in that order. The writer and a summary of notes are given none.",
      type: "object",
      properties: {
        chars: whole2("Guidance length", "The most characters of one level an agent is given. A longer file is given cut, and says so.", 100, "characters"),
        agentsEdit: flag2("Agents may edit the chat's guidance", "Let an agent write learned/GUIDANCE.md. Yours and the middle level are never an agent's to write.")
      }
    },
    skills: {
      title: "Skills",
      type: "object",
      properties: {
        listChars: whole2("Skill list length", "The most characters the list of skills takes in an agent's instructions. Past it the rest are left out of the list; skill_load still loads them.", 100, "characters")
      }
    },
    delegation: {
      title: "Delegation",
      description: "An agent handing a task to another agent, which works in a session of its own.",
      type: "object",
      properties: {
        depth: whole2("Depth", "How deep delegation goes. 0: no agent delegates. 1: only the agent a turn starts with. 2: the agents it starts may delegate too. A job's agent stands one deeper than the agent that started the job (you start one at 0), so at 2 a job the main agent starts may delegate, and the agents it hands tasks to may not.", 0, "levels"),
        atOnce: whole2("Sub-agents at once", "How many sub-agents work at the same time in one turn. One started past it waits.", 1, "agents"),
        perRun: limit("Sub-agents per turn", "The most sub-agents one turn may start in all.", "agents"),
        grant: choice("What a sub-agent may be given", "The tools a sub-agent gets are those of its own definition, within this. The agent of a job that an agent starts is given its tools by the same rule.", [
          ["own", "No more than its starter holds", "A tool the agent that starts it doesn't have is left out, so delegating, or starting a job, never reaches further than the agent could itself."],
          ["definition", "Whatever its definition names", "Its definition alone decides."]
        ]),
        fileChars: whole2("Files given with a task", "The most characters of the files a task names that are given with it. Past it the rest are named, with how to read them.", 0, "characters"),
        asChars: whole2("Instance name length", "The most characters of as in delegate and job_start: which one of the many an agent stands for, such as a character. A longer one is refused.", 1, "characters"),
        replyHoldChars: whole2("Hold before a handed-on reply streams", "When an agent hands the reply to another (to_reply in delegate), each of that agent's answers is held until it is this long or ends without a tool call, then it streams. So the line or two it writes before a tool call is never sent; what streamed is never taken back. 0 streams everything at once.", 0, "characters")
      }
    },
    jobs: {
      title: "Jobs",
      description: "An agent's work that goes on after the reply. Only an agent's job_start call or you, on the Jobs page, start one.",
      type: "object",
      properties: {
        enabled: flag2("Jobs", "Off: no job is started, and none that waits is run."),
        atOnce: whole2("Jobs at once", "How many jobs run at the same time. One past it waits its turn.", 1, "jobs"),
        perRun: limit("Jobs per turn", "The most jobs the agents of one turn may start.", "jobs", 0),
        budget: {
          title: "Each job",
          description: "What the agents of one job may spend together.",
          type: "object",
          properties: {
            tokensIn: limit("Prompt tokens per job", "The most all of a job's calls may send.", "tokens"),
            tokensOut: limit("Answer tokens per job", "The most all of a job's calls may write.", "tokens"),
            toolTurns: limit("Tool rounds per job", "The most answers that call tools, over every agent of the job.", "rounds", 0),
            wallMs: limit("Time per job", "How long a job may work from the moment it starts to run.", "ms")
          }
        },
        tokensPerDay: limit("Job tokens per day", "The most tokens all jobs may send and write in any 24 hours. A job that would pass it is stopped, and says so.", "tokens"),
        taskChars: whole2("Task length", "The most characters a job's task holds. A longer one is refused: the agent is told to put the details in a workspace file.", 100, "characters"),
        openingChars: whole2("Report opening", "How much of a finished job's report the main agent is told at its next turn, and the Jobs page lists. job_read reads the whole.", 40, "characters"),
        recordWaitMs: whole2("Wait for a turn to be saved", "A job that ends just as its turn does waits this long for Lumiverse to save that turn's reply before it takes the turn as gone from the chat.", 0, "ms", TIMER_MAX_MS),
        chain: flag2("Jobs may start jobs", "A job's own agents are offered job_start. A job so started may spend no more than is left of the one that started it, and what it spends counts against that one's allowance too. Off: only the agents of a turn or a side session, and you, start jobs."),
        delegations: limit("Delegations per job", "The most sub-agents the agents of one job may start in all. None: no limit of its own, since what a job may spend bounds it. Sub-agents per turn bounds a turn's.", "agents"),
        dueWaitMs: whole2("Wait for jobs due", "How long a turn waits at its start for the jobs started as due by it (due in job_start). The main agent is told of any still running.", 0, "ms", TIMER_MAX_MS)
      }
    },
    approval: {
      title: "Approval",
      description: "Which tool calls wait for your word. A tool's tier says what it may touch: read changes nothing; write changes what LumiAH keeps (workspace files, jobs); external acts outside LumiAH (an extension's tools, MCP servers). As it ships none waits: an MCP server's tools are called once you switch the server on for agents. Choose Ask first for a tier, or for one tool, to approve each call.",
      type: "object",
      properties: {
        tiers: {
          title: "By tier",
          type: "object",
          properties: {
            read: choice("Read tools", "Tools that change nothing.", RULES),
            write: choice("Write tools", "Tools that change what LumiAH keeps.", RULES),
            external: choice("External tools", "Tools that act outside LumiAH.", RULES)
          }
        },
        tools: { title: "By tool", description: "Per tool, over its tier's.", type: "object", "x-keys": "tool", additionalProperties: { ...choice("Calls of this tool", "What happens to a call of it.", RULES), default: "ask" } },
        waitMs: { ...limit("Wait for your word", "How long a held call waits. When it runs out the call is refused, and the agent is told why.", "ms"), "x-none": "Until the turn ends" }
      }
    },
    spend: {
      title: "Spend",
      description: "Caps on what every agent together may spend. A cap that is reached refuses the next model call, in words that name it.",
      type: "object",
      properties: {
        tokensPerDay: limit("Tokens per day", "The most tokens every agent's calls may send and write in any 24 hours, a cached re-read counted at its weight.", "tokens"),
        costPerDay: { title: "Cost per day", description: "The most every agent's calls may cost in any 24 hours. A call whose cost isn't known (its provider reports none and its model has no price) counts as nothing.", type: ["number", "null"], minimum: 0, "x-unit": "USD", "x-none": "No limit" },
        cachedWeight: { title: "What a cached re-read counts as", description: "Against every limit on prompt tokens (per agent, per turn, per job, per day), a prompt token read again from the provider's cache counts as this share of a token, since most providers bill it at about a tenth. Set 1 to count it in full. Spend and every page still show the true counts.", type: "number", minimum: 0, maximum: 1, "x-unit": "of a token" }
      }
    },
    extension: {
      title: "The extension beside LumiAH",
      type: "object",
      properties: {
        waitMs: { ...limit("Wait for the extension", "How long a run waits for one answer of an extension that builds LumiAH into itself (its definitions, its claim on a chat, its rewrite of the writer's request, its hooks). Past it the run goes on without that answer, where it can: without the claim, a run about the chat doesn't start, and without the agent the claim names to lead it, neither does a reply.", "ms"), "x-none": "As long as it takes" }
      }
    },
    recall: RECALL_SETTINGS_SCHEMA
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
  if (value === undefined || schema.readOnly === true)
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
var RETIRED_SETTINGS = [
  ["reply", "warnMs"],
  ["reply", "pendingMs"],
  ["cache", "breakpoints"]
];
function settingsSchema(scope) {
  return { ...SETTINGS_SCHEMA, properties: { ...SETTINGS_SCHEMA.properties, agents: agentsSchema(scope) } };
}
function shapeOf(scope) {
  const defaults = defaultSettings();
  if (!scope)
    return { schema: SETTINGS_SCHEMA, defaults };
  for (const a of scope.agents)
    defaults.agents[a.id] = a.defaults;
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
function newAgentSettings() {
  return clone(defaultSettings().agents[AGENT.summarizer]);
}
function agentRunSchema(tools) {
  return agentSchema("Runs with", "What this agent runs with unless Settings say otherwise.", "Your default connection", "The connection's own", tools);
}
function readAgentSettings(value, tools, fallback, path, problems) {
  return read(agentRunSchema(tools), fallback, isRecord(value) ? value : {}, path, problems);
}

// src/core/texts/agents.ts
var AGENTS_TEXT = {
  summarizer: "agents.summarizer",
  guidance: "agents.guidance",
  guidanceUser: "agents.guidance.user",
  guidanceCharacter: "agents.guidance.character",
  guidanceChat: "agents.guidance.chat",
  guidanceCut: "agents.guidance.cut",
  guidanceCutOwn: "agents.guidance.cut.own",
  guardUser: "agents.guidance.guard",
  guardChat: "agents.guidance.guard_chat",
  skills: "agents.skills",
  skill: "agents.skills.skill",
  skillsMore: "agents.skills.more",
  skillBody: "agents.skill_load.body",
  skillNone: "agents.skill_load.none",
  skillNotYours: "agents.skill_load.not_yours",
  remoteNothing: "agents.remote.nothing",
  choice: "agents.choice",
  task: "agents.task",
  taskFiles: "agents.task.files",
  taskRequest: "agents.task.request",
  taskNewest: "agents.task.newest",
  asLong: "agents.as_long",
  noReply: "agents.delegate.no_reply",
  file: "agents.file",
  fileNamed: "agents.file.named",
  pinned: "agents.pinned",
  answer: "agents.delegate.answer",
  stopped: "agents.delegate.stopped",
  noAgent: "agents.delegate.no_agent",
  notOffered: "agents.not_offered",
  tooMany: "agents.delegate.too_many",
  noFile: "agents.delegate.no_file",
  noHandle: "agents.message.no_handle",
  noHandles: "agents.message.no_handles",
  stoppedSaid: "agents.delegate.stopped.said",
  cut: "agents.cut",
  note: "agents.note",
  wordSkill: "word.skill",
  wordSubAgent: "word.sub_agent"
};
var AGENTS = GROUP.agents;
var ANSWERS = GROUP.answers;
var AGENTS_TEXTS = [
  {
    id: AGENTS_TEXT.summarizer,
    group: AGENTS,
    label: "Summarizer: instructions",
    note: "The summarizer's instructions when another agent delegates to it. The summary of the main agent's notes has instructions of its own (Session: Notes summary).",
    text: [
      "You summarize for another agent. Your task says what: a span of the chat, lore entries, workspace files, or a text given with the task.",
      "Read what the task names with your tools before you write: chat_read for the chat's messages, lore_read for lore entries, workspace_read for files. Don't summarize from a title, an excerpt or what you expect it to say.",
      "Answer with the summary alone, in the order things happened or are written. Keep what the other agent can't work without: names, places, numbers, who knows what, what was promised and what is still open. Leave out how you read it. If there was something you couldn't read, say which and why in one line at the end."
    ].join(`

`),
    vars: []
  },
  { id: AGENTS_TEXT.guidance, group: AGENTS, label: "Guidance: one level", note: "Puts one level of guidance at the head of an agent's instructions, saying whose words they are.", text: `[Guidance {{whose}}. Follow it.]
{{text}}`, vars: [v("whose", "whose guidance it is, as the three texts below say it, or as an extension names its own level", true), v("text", "the guidance file's text", true)] },
  { id: AGENTS_TEXT.guidanceUser, group: AGENTS, label: "Guidance: the user's level", note: "Fills {{whose}} for ~/GUIDANCE.md.", text: "from the user, for every chat", vars: [] },
  { id: AGENTS_TEXT.guidanceCharacter, group: AGENTS, label: "Guidance: the character's level", note: "Fills {{whose}} for the character's guidance file.", text: "from the user, for every chat with {{character}}", vars: [v("character", "the character's name", true)] },
  { id: AGENTS_TEXT.guidanceChat, group: AGENTS, label: "Guidance: the chat's level", note: "Fills {{whose}} for learned/GUIDANCE.md.", text: "for this chat", vars: [] },
  { id: AGENTS_TEXT.guidanceCut, group: AGENTS, label: "Guidance: cut", note: "Stands for a guidance file longer than Guidance length: its start, and where the whole is.", text: `{{text}}
[Cut here, at {{shown}} of {{chars}} characters. The whole is the workspace file {{path}}.]`, vars: [v("text", "the start of the file", true), v("shown", "the characters given"), v("chars", "the file's length"), v("path", "the file's path", true)] },
  { id: AGENTS_TEXT.guidanceCutOwn, group: AGENTS, label: "Guidance: cut, where it is no file", note: "Stands for a level an extension keeps as a text of its own, when that is longer than Guidance length: its start. The rest is in no workspace file.", text: `{{text}}
[Cut here, at {{shown}} of {{chars}} characters. The rest is in no workspace file, so it can't be read from here: work from what is above.]`, vars: [v("text", "the start of the level's text", true), v("shown", "the characters given"), v("chars", "the text's length")] },
  { id: AGENTS_TEXT.guardUser, group: ANSWERS, label: "Guidance an agent can't change", note: "A workspace tool's answer to a change of the user's guidance, or of the middle level's.", text: "Not changed: {{path}} is guidance the user writes for you, and an agent can't change it. If it should change, say what and why in your answer.", vars: [v("path", "the file's path", true)] },
  { id: AGENTS_TEXT.guardChat, group: ANSWERS, label: "The chat's guidance, while agents may not edit it", note: "A workspace tool's answer to a change of the chat's guidance while Settings don't let agents edit it.", text: "Not changed: {{path}} is this chat's guidance, and Settings don't let agents edit it (Agents may edit the chat's guidance). If it should change, say what and why in your answer.", vars: [v("path", "the file's path", true)] },
  { id: AGENTS_TEXT.skills, group: AGENTS, label: "Skills: the list", note: "Follows the instructions of an agent that holds skill_load: the skills it may load.", text: `Skills you can load with skill_load. Each is a procedure written for you: load one when what you are doing is what it is for, and follow it.
{{skills}}{{more}}`, vars: [v("skills", "each skill, as Skills: one skill writes it", true), v("more", "how many more there are, when the list was cut")] },
  { id: AGENTS_TEXT.skill, group: AGENTS, label: "Skills: one skill", note: "One skill in the list, and in skill_load's own list.", text: "- {{id}}: {{name}}. {{description}}", vars: [v("id", "the skill's id, which skill_load takes", true), v("name", "its name"), v("description", "what it is for")] },
  { id: AGENTS_TEXT.skillsMore, group: AGENTS, label: "Skills: more than fit", note: "Ends a list of skills cut at Skill list length.", text: `
({{count}} more aren't listed here: skill_load with no skill lists them all.)`, vars: [v("count", "how many skills were left out", true)] },
  ...toolTexts(TOOL.skillLoad, "Load a skill: a procedure written for you to follow. Give the id of one your instructions list; leave skill out to list every skill there is.", {
    skill: "The skill's id. Leave it out to list the skills.",
    cursor: CURSOR_ARG
  }),
  { id: AGENTS_TEXT.skillBody, group: ANSWERS, label: "skill_load: a skill", note: "What skill_load returns: one page of a skill's body.", text: `[Skill {{id}}: {{name}}, characters {{from}} to {{to}} of {{total}}.]
{{text}}`, vars: [v("id", "the skill's id", true), v("name", "its name"), v("from", "the first character returned"), v("to", "the character after the last one returned"), v("total", "the body's length"), v("text", "the characters read", true)] },
  { id: AGENTS_TEXT.skillNone, group: ANSWERS, label: "skill_load: no such skill", note: "skill_load's answer to an id that names no skill.", text: "There's no skill {{id}}. The skills are: {{skills}}. Give one of those.", vars: [v("id", "the id asked for"), v("skills", "the ids there are", true)] },
  { id: AGENTS_TEXT.skillNotYours, group: ANSWERS, label: "skill_load: a skill for other agents", note: "skill_load's answer to the id of a skill that is offered only to other agents.", text: "The skill {{id}} is for {{agents}}, not for you. The skills you can load are: {{skills}}.", vars: [v("id", "the id asked for", true), v("agents", "the agents it is for, by id", true), v("skills", "the ids of the skills this agent can load")] },
  { id: AGENTS_TEXT.remoteNothing, group: ANSWERS, label: "A tool that runs outside LumiAH and gave nothing", note: "The result of a call to a tool that runs in the extension (its own, or an MCP server's) when what came back holds no result.", text: "{{tool}} gave no result: it runs outside LumiAH, and what came back from there isn't one. Go on without it, or say in your answer what you needed it for.", vars: [v("tool", "the tool", true)] },
  {
    id: toolId(TOOL.delegate),
    group: GROUP.tools,
    label: "delegate: what it does",
    note: "The description of the delegate tool, as the model is offered it.",
    text: `Hand a task to another agent. It works in a session of its own, with its own tools, and sees none of your conversation: only the task you write, the files you name, and what its tools reach. Its answer is this tool's result, and names a handle that agent_message takes to ask it more. Several delegate calls in one answer run at the same time. Delegate what is worth a session of its own (long reading, a second look, work that would crowd your own context); do small things yourself.
The agents you can delegate to:
{{agents}}`,
    vars: [v("agents", "each agent it may delegate to, as An agent to choose writes it", true)]
  },
  { id: toolArgId(TOOL.delegate, "agent"), group: GROUP.tools, label: "delegate: agent", note: "The description of delegate's agent argument.", text: "The agent's id, from the list above.", vars: [] },
  { id: toolArgId(TOOL.delegate, "task"), group: GROUP.tools, label: "delegate: task", note: "The description of delegate's task argument.", text: "What it is to do and what you want back, in full. It knows nothing you don't write here.", vars: [] },
  { id: toolArgId(TOOL.delegate, "files"), group: GROUP.tools, label: "delegate: files", note: "The description of delegate's files argument.", text: "Workspace files to give it with the task, by path. Leave it out for none.", vars: [] },
  { id: toolArgId(TOOL.delegate, "as"), group: GROUP.tools, label: "delegate: as", note: "The description of delegate's as argument, offered where an extension builds LumiAH in.", text: "Which one this agent is to be, where its kind stands for many (a character's id, for one): what it may read and the model it runs on follow from it. Leave it out for none.", vars: [] },
  { id: toolArgId(TOOL.delegate, "to_reply"), group: GROUP.tools, label: "delegate: to_reply", note: "The description of delegate's to_reply argument, offered to an agent that may write the reply itself.", text: "true: its answer is part of the reply, streaming to the user as it is written, after what was released before; this call's result is that answer too. Leave it out for an answer only you read.", vars: [] },
  ...toolTexts(TOOL.agentMessage, "Send a follow-up to an agent you delegated to this turn. It goes on from where it left off, with everything it had read, and its answer is this tool's result.", {
    handle: "The handle that agent's answer named, such as agent_1a2b3c4d.",
    text: "What you want of it now."
  }),
  { id: AGENTS_TEXT.choice, group: AGENTS, label: "An agent to choose", note: "One agent in the lists delegate and job_start give of whom a task can go to.", text: "- {{id}}: {{name}}. {{description}}", vars: [v("id", "the agent's id", true), v("name", "its name"), v("description", "what it is for")] },
  { id: AGENTS_TEXT.task, group: AGENTS, label: "A delegated task", note: "The first message a sub-agent is sent: its task, the files given with it, and the request the turn answers where its definition is given that.", text: "{{task}}{{files}}{{request}}", vars: [v("task", "the task, as the delegating agent wrote it", true), v("files", "the files given with the task, as Files with a task writes them"), v("request", "the turn's request, as The request with a task writes it")] },
  { id: AGENTS_TEXT.taskFiles, group: AGENTS, label: "Files with a task", note: "Follows a delegated task that names files.", text: `

Files given with this task:

{{files}}`, vars: [v("files", "each file, as A file in context writes it", true)] },
  { id: AGENTS_TEXT.taskRequest, group: AGENTS, label: "The request with a task", note: "Follows a delegated task for an agent whose definition is given the whole request.", text: `

For reference, the request this turn answers ({{count}}), as Lumiverse assembled it:

{{request}}`, vars: [v("count", 'how many messages it holds, with the word: "14 messages"'), v("request", "the request, as the main agent reads it", true)] },
  { id: AGENTS_TEXT.taskNewest, group: AGENTS, label: "The newest message with a task", note: "Follows a delegated task for an agent whose definition is given the request, in a chat whose extension shows its agents only the user's newest message.", text: `

For reference, the user's newest message:

{{request}}`, vars: [v("request", "the user's newest message, as the main agent reads it", true)] },
  { id: AGENTS_TEXT.file, group: AGENTS, label: "A file in context", note: "One workspace file put in an agent's context whole: given with a task, or pinned.", text: `[{{path}}: {{chars}} characters, version {{version}}]
{{text}}`, vars: [v("path", "the file's path", true), v("chars", "its length"), v("version", "its version, which a write or an edit of it names"), v("text", "its text", true)] },
  { id: AGENTS_TEXT.fileNamed, group: AGENTS, label: "A file named, not included", note: "Stands for a file that didn't fit the room its setting gives (Files given with a task, Pinned files in context).", text: "[{{path}}: {{chars}} characters, not included here. workspace_read reads it.]", vars: [v("path", "the file's path", true), v("chars", "its length")] },
  { id: AGENTS_TEXT.pinned, group: AGENTS, label: "Pinned files", note: "Leads what an agent is sent first with the workspace files pinned for it.", text: `Your pinned workspace files, as they stand now:

{{files}}`, vars: [v("files", "each file, as A file in context writes it", true)] },
  { id: AGENTS_TEXT.answer, group: ANSWERS, label: "delegate: the agent's answer", note: "What delegate and agent_message return when the agent answered.", text: `{{answer}}

[From {{agent}}, handle {{handle}}. agent_message with this handle asks it more.]`, vars: [v("answer", "the agent's answer", true), v("agent", "the agent's id"), v("handle", "the handle agent_message takes", true)] },
  { id: AGENTS_TEXT.stopped, group: ANSWERS, label: "delegate: the agent stopped short", note: "What delegate and agent_message return when the agent stopped before an answer.", text: `{{agent}} (handle {{handle}}) stopped before it answered: {{reason}}.{{said}}
agent_message with this handle has it go on, if it still may; or go on without it.`, vars: [v("agent", "the agent's id"), v("handle", "the handle agent_message takes", true), v("reason", "why it stopped", true), v("said", "what it had last written, if anything")] },
  { id: AGENTS_TEXT.noAgent, group: ANSWERS, label: "delegate: no such agent", note: "delegate's answer to an id that names no agent it may delegate to.", text: "There's no agent {{agent}} to delegate to. You can delegate to: {{agents}}.", vars: [v("agent", "the id asked for"), v("agents", "the ids there are", true)] },
  { id: AGENTS_TEXT.notOffered, group: ANSWERS, label: "delegate and job_start: an agent left out here", note: "The answer of delegate and job_start, and of a job you start, to a built-in agent the extension LumiAH is built into leaves out.", text: "Not started: {{agent}} isn't offered here, since the extension LumiAH is built into leaves it out. Do the work with the agents there are, or yourself.", vars: [v("agent", "the id asked for")] },
  { id: AGENTS_TEXT.tooMany, group: ANSWERS, label: "delegate: too many sub-agents", note: "delegate's answer once the turn has started every sub-agent Sub-agents per turn allows.", text: "Not started: this turn has started the {{limit}} it may (Sub-agents per turn). Ask one you already have with agent_message, or do it yourself.", vars: [v("limit", 'Sub-agents per turn, with the word: "3 sub-agents"', true)] },
  { id: AGENTS_TEXT.noFile, group: ANSWERS, label: "delegate: no such file", note: "delegate's answer to a file that isn't in the workspace.", text: "Not started: there's no workspace file {{path}}. workspace_list shows what there is. Call delegate again with the right path, or without it.", vars: [v("path", "the path asked for", true)] },
  { id: AGENTS_TEXT.asLong, group: ANSWERS, label: "delegate and job_start: as too long", note: "The answer of delegate and job_start to an as past Instance name length.", text: "Not started: as is {{chars}} characters, and it may be {{limit}} at most (Instance name length). Give the short id.", vars: [v("chars", "its length"), v("limit", "Instance name length", true)] },
  { id: AGENTS_TEXT.noReply, group: ANSWERS, label: "delegate: to_reply without the reply", note: "delegate's answer to to_reply from an agent that doesn't write the reply.", text: "Not started: you don't write this reply, so you can't hand it on. Call delegate without to_reply.", vars: [] },
  { id: AGENTS_TEXT.noHandle, group: ANSWERS, label: "agent_message: no such handle", note: "agent_message's answer to a handle that names none of this turn's agents it started.", text: "There's no agent with the handle {{handle}} among those you started this turn. Your handles: {{handles}}.", vars: [v("handle", "the handle asked for"), v("handles", "the handles there are", true)] },
  { id: AGENTS_TEXT.noHandles, group: ANSWERS, label: "agent_message: nobody to message", note: "agent_message's answer when the agent has delegated to nobody this turn.", text: "You haven't delegated to anyone this turn, so there is nobody to message. delegate starts an agent.", vars: [] },
  { id: AGENTS_TEXT.stoppedSaid, group: ANSWERS, label: "delegate: what a stopped agent had written", note: "Fills {{said}} for an agent that stopped after it had written something.", text: " It had last written: {{text}}", vars: [v("text", "what it had last written", true)] },
  { id: AGENTS_TEXT.cut, group: AGENTS, label: "Why: an answer cut at its length", note: "Why an agent's answer isn't taken as one, when its model stopped at the answer's token limit: the main agent's without write_reply, a sub-agent's.", text: "its answer was cut at its length limit (Answer per call), so it isn't the whole of what it meant to say", vars: [] },
  { id: AGENTS_TEXT.note, group: AGENTS, label: "A note from the user", note: "How something the user says while an agent works reaches it, at the start of its next round.", text: `[The user says, while you work:]
{{text}}`, vars: [v("text", "the user's words", true)] },
  word(AGENTS_TEXT.wordSkill, "skill", "skills"),
  word(AGENTS_TEXT.wordSubAgent, "sub-agent", "sub-agents")
];

// src/core/texts/approval.ts
var APPROVAL_TEXT = {
  refused: "approval.refused",
  refusedReason: "approval.refused.reason",
  timedOut: "approval.timed_out",
  noWay: "approval.no_way",
  failed: "approval.failed",
  unread: "approval.unread",
  unreadWhy: "approval.unread.why"
};
var APPROVAL = GROUP.approval;
var APPROVAL_TEXTS = [
  { id: APPROVAL_TEXT.refused, group: APPROVAL, label: "A call the user refused", note: "The result of a tool call the user refused.", text: "Not run: the user refused this call of {{tool}}. Don't make it again unless they ask for it; go on without it, or say in your answer what you needed it for.{{reason}}", vars: [v("tool", "the tool", true), v("reason", "the user's reason, where they gave one")] },
  { id: APPROVAL_TEXT.refusedReason, group: APPROVAL, label: "A call the user refused: their reason", note: "Fills {{reason}} where the user gave one: on a line of its own, so the user's words end where the text does.", text: `
Their reason: {{reason}}`, vars: [v("reason", "the user's words", true)] },
  { id: APPROVAL_TEXT.timedOut, group: APPROVAL, label: "A call nobody answered for", note: "The result of a tool call that waited for the user's word longer than Wait for your word.", text: "Not run: this call of {{tool}} needs the user's approval, and none came in the {{seconds}} seconds it may wait (Wait for your word). Go on without it, or say in your answer what you needed it for.", vars: [v("tool", "the tool", true), v("seconds", "how long it waited, in seconds")] },
  { id: APPROVAL_TEXT.noWay, group: APPROVAL, label: "A call nobody can be asked about", note: "The result of a tool call that needs the user's approval on a runtime that has no way to ask.", text: "Not run: this call of {{tool}} needs the user's approval, and there is no way to ask them here. Go on without it, or say in your answer what you needed it for.", vars: [v("tool", "the tool", true)] },
  { id: APPROVAL_TEXT.failed, group: APPROVAL, label: "A call the user couldn't be asked about", note: "The result of a tool call that needs the user's approval when asking for it failed.", text: "Not run: this call of {{tool}} needs the user's approval, and asking for it failed ({{error}}). Go on without it, or say in your answer what you needed it for.", vars: [v("tool", "the tool", true), v("error", "why the ask failed", true)] },
  { id: APPROVAL_TEXT.unread, group: APPROVAL, label: "A call whose answer wasn't one", note: "The result of a tool call that needs the user's approval when what came back was neither an approval nor a refusal: nobody gave their word, so the call isn't run.", text: "Not run: this call of {{tool}} needs the user's approval, and what came back was neither an approval nor a refusal, so nobody gave their word for it. Go on without it, or say in your answer what you needed it for.", vars: [v("tool", "the tool", true)] },
  { id: APPROVAL_TEXT.unreadWhy, group: APPROVAL, label: "A call whose answer wasn't one: on the record", note: "What the agent's transcript says of such a call, where a refusal's reason stands.", text: "what came back was neither an approval nor a refusal", vars: [] }
];

// src/core/texts/book.ts
var BOOK_TEXT = {
  head: "book.head",
  span: "book.span",
  message: "book.span.one",
  spanNone: "book.span.none",
  untitled: "book.untitled",
  line: "book.line",
  under: "book.under",
  leaf: "book.leaf",
  read: "book.read",
  noEntry: "book.no_entry",
  coverage: "book.coverage",
  uncovered: "book.coverage.uncovered",
  uncoveredNone: "book.coverage.uncovered.none",
  changed: "book.coverage.changed",
  changedNone: "book.coverage.changed.none",
  changedUnknown: "book.coverage.changed.unknown",
  level: {
    chapter: "word.chapter",
    arc: "word.arc",
    volume: "word.volume"
  }
};
var BOOK = GROUP.book;
var ANSWERS2 = GROUP.answers;
var HEAD = v("head", "the entry, as An entry of the book names it", true);
var BOOK_TEXTS = [
  ...toolTexts(TOOL.bookOutline, "List this chat's book: the summaries LumiBooks keeps of the chat's older messages. A chapter sums up a run of messages, an arc a run of chapters, a volume a run of arcs. Each entry is one line, with the entries it sums up indented under it: the id book_read takes, what it is, its title, the chat messages it spans and its length. The first page opens with the book's coverage: how many of the chat's messages it covers, which messages no chapter covers (there the book is silent), and which changed since they were summarized (there it is out of date). A summary is somebody's reading of the chat, and the chat itself is the source: chat_read reads the messages an entry spans. Give entry to list only the entries under one.", { entry: "An entry's id, as the outline gives it, to list only the entries under that one.", cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.bookRead, "Read one entry of this chat's book whole, by the id book_outline gives: a chapter, an arc or a volume of the summaries LumiBooks keeps of the chat's older messages. A long entry comes a page at a time. A summary is somebody's reading of the chat, not the chat: where the wording or a detail matters, or book_outline says its messages changed since, read the messages it spans with chat_read.", { entry: "The entry's id, as book_outline gives it.", cursor: CURSOR_ARG }),
  {
    id: BOOK_TEXT.head,
    group: BOOK,
    label: "An entry of the book",
    note: "Names an entry wherever the book tools name one: in book_outline's lines and headings, and in book_read's.",
    text: "[{{id}}] {{kind}}: {{title}} \xB7 {{span}}",
    vars: [v("id", "the entry's id, as book_read takes it", true), v("kind", "what it is: a chapter, an arc or a volume, by the word for it"), v("title", "its title, as LumiBooks labels it"), v("span", "the chat messages it spans, as the three texts below say it")]
  },
  { id: BOOK_TEXT.span, group: BOOK, label: "A run of messages", note: "How the book tools write a run of chat messages: the messages an entry spans, and each run the coverage lists.", text: "#{{from}} to #{{to}}", vars: [v("from", "the first message's number", true), v("to", "the last message's number", true)] },
  { id: BOOK_TEXT.message, group: BOOK, label: "A run of one message", note: "As A run of messages, where the run is one message.", text: "#{{index}}", vars: [v("index", "the message's number", true)] },
  { id: BOOK_TEXT.spanNone, group: BOOK, label: "An entry from before this chat", note: "Stands where an entry's messages would, for an entry LumiBooks carried over from another chat: it spans none of this chat's.", text: "from before this chat", vars: [] },
  { id: BOOK_TEXT.untitled, group: BOOK, label: "An entry without a title", note: "Stands where an entry's title would, for one LumiBooks gave no label.", text: "(untitled)", vars: [] },
  { id: BOOK_TEXT.line, group: ANSWERS2, label: "book_outline: an entry", note: "One entry in book_outline's answer.", text: "{{indent}}- {{head}} \xB7 {{chars}} characters", vars: [v("indent", "two spaces for each entry it sits under"), HEAD, v("chars", "its length")] },
  { id: BOOK_TEXT.under, group: ANSWERS2, label: "book_outline: under one entry", note: "Leads book_outline's answer for one entry: the entries under it follow, one line each.", text: "{{head}}. The entries under it:", vars: [HEAD] },
  { id: BOOK_TEXT.leaf, group: ANSWERS2, label: "book_outline: nothing under an entry", note: "book_outline's answer for an entry that sums up no other.", text: "{{head}}. No entry is under it: book_read with entry {{id}} reads its text.", vars: [HEAD, v("id", "the entry's id, as book_read takes it")] },
  {
    id: BOOK_TEXT.read,
    group: ANSWERS2,
    label: "book_read: its answer",
    note: "book_read's answer: an entry, or the part of it a page holds.",
    text: `{{head}} \xB7 characters {{from}} to {{to}} of {{chars}}:
{{text}}`,
    vars: [HEAD, v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "the entry's length"), v("text", "the text", true)]
  },
  { id: BOOK_TEXT.noEntry, group: ANSWERS2, label: "No such entry of the book", note: "The answer of book_read and book_outline to an id that names no entry of the chat's book.", text: "There's no entry {{id}} in this chat's book. book_outline without entry lists its entries, each with the id to give.", vars: [v("id", "the id asked for", true)] },
  {
    id: BOOK_TEXT.coverage,
    group: ANSWERS2,
    label: "book_outline: the coverage",
    note: "Leads book_outline's first page: how the book stands against the chat.",
    text: "Coverage: the book covers {{covered}} of this chat's {{messages}}. {{uncovered}} {{changed}}",
    vars: [
      v("covered", "how many of the chat's messages an entry covers"),
      v("messages", 'how many messages the chat has, with the word: "203 messages"'),
      v("uncovered", "which messages no chapter covers, as the two texts below say it", true),
      v("changed", "which messages changed since they were summarized, as the three texts after those say it", true)
    ]
  },
  { id: BOOK_TEXT.uncovered, group: ANSWERS2, label: "The coverage: messages without a chapter", note: "Fills {{uncovered}} when some of the chat's messages have no chapter.", text: "No chapter covers {{count}} ({{ranges}}), so the book is silent there.", vars: [v("count", 'how many, with the word: "23 messages"'), v("ranges", "the messages, as runs of message numbers, clipped where they are many", true)] },
  { id: BOOK_TEXT.uncoveredNone, group: ANSWERS2, label: "The coverage: no message without a chapter", note: "Fills {{uncovered}} when a chapter covers every message of the chat.", text: "No message is without a chapter.", vars: [] },
  { id: BOOK_TEXT.changed, group: ANSWERS2, label: "The coverage: messages that changed", note: "Fills {{changed}} when some messages changed since LumiBooks summarized them.", text: "{{count}} changed since being summarized ({{ranges}}), so the book is out of date there.", vars: [v("count", 'how many, with the word: "2 messages"'), v("ranges", "the messages, as runs of message numbers, clipped where they are many", true)] },
  { id: BOOK_TEXT.changedNone, group: ANSWERS2, label: "The coverage: no message changed", note: "Fills {{changed}} when every message LumiBooks summarized stands as it did.", text: "None changed since being summarized.", vars: [] },
  { id: BOOK_TEXT.changedUnknown, group: ANSWERS2, label: "The coverage: changes it can't tell", note: "Fills {{changed}} for a book that keeps no hash of the messages it summarized, as LumiBooks' own book for a chat keeps none.", text: "The book keeps no hash of the messages it summarized, so it can't tell whether any changed since.", vars: [] },
  word(BOOK_TEXT.level.chapter, "chapter", "chapters"),
  word(BOOK_TEXT.level.arc, "arc", "arcs"),
  word(BOOK_TEXT.level.volume, "volume", "volumes")
];

// src/core/texts/jobs.ts
var JOBS_TEXT = {
  task: "jobs.task",
  objective: "jobs.objective",
  objectiveFiles: "jobs.objective.files",
  objectiveChat: "jobs.objective.chat",
  objectiveFilesKept: "jobs.objective.files.kept",
  objectiveChatKept: "jobs.objective.chat.kept",
  againNote: "jobs.again.note",
  againOffPath: "jobs.again.off_path",
  whyCutThinking: "jobs.why.cut_thinking",
  resumed: "jobs.resumed",
  resumedPlan: "jobs.resumed.plan",
  resumedKept: "jobs.resumed.kept",
  allowance: "jobs.allowance",
  allowanceIn: "jobs.allowance.in",
  allowanceOut: "jobs.allowance.out",
  allowanceRounds: "jobs.allowance.rounds",
  allowanceTime: "jobs.allowance.time",
  allowanceNone: "jobs.allowance.none",
  spentReport: "jobs.report.spent",
  dayReport: "jobs.report.day",
  spentDay: "jobs.state.spent_day",
  spentPlan: "jobs.report.spent.plan",
  spentSaid: "jobs.report.spent.said",
  spentFiles: "jobs.report.spent.files",
  noChatArea: "jobs.no_chat_area",
  news: "jobs.news",
  newsLine: "jobs.news.line",
  newsMore: "jobs.news.more",
  newsRest: "jobs.news.rest",
  newsNoReport: "jobs.news.no_report",
  dueRunning: "jobs.due.running",
  dueLine: "jobs.due.line",
  dueAs: "jobs.due.as",
  started: "jobs.started",
  whenNow: "jobs.when.now",
  whenAfter: "jobs.when.after_reply",
  off: "jobs.off",
  noAgent: "jobs.no_agent",
  taskLong: "jobs.task_long",
  noTask: "jobs.no_task",
  tooMany: "jobs.too_many",
  tooManyDelegated: "jobs.too_many_delegated",
  noJob: "jobs.no_job",
  notAgain: "jobs.not_again",
  line: "jobs.line",
  none: "jobs.none",
  read: "jobs.read",
  reportPage: "jobs.report",
  noReport: "jobs.no_report",
  cancelled: "jobs.cancelled",
  ended: "jobs.ended",
  byAgent: "jobs.by.agent",
  byUser: "jobs.by.user",
  state: {
    queued: "jobs.state.queued",
    running: "jobs.state.running",
    done: "jobs.state.done",
    failed: "jobs.state.failed",
    cancelled: "jobs.state.cancelled",
    interrupted: "jobs.state.interrupted",
    off_path: "jobs.state.off_path",
    spent: "jobs.state.spent",
    paused: "jobs.state.held"
  },
  paused: "jobs.state.paused",
  whyCancelledByAgent: "jobs.why.cancelled_by_agent",
  whyCancelledByUser: "jobs.why.cancelled_by_user",
  whyInterrupted: "jobs.why.interrupted",
  whyOffPath: "jobs.why.off_path",
  whyOff: "jobs.why.off",
  whyNoAnswer: "jobs.why.no_answer",
  whyStopped: "jobs.why.stopped",
  whyNoRecord: "jobs.why.no_record",
  whyGone: "jobs.why.gone",
  stopOffPath: "stop.off_path",
  stopJobTokens: "stop.job_tokens_day",
  stopJobTokensCall: "stop.job_tokens_day_call",
  stopIn: "stop.job_tokens_in",
  stopOut: "stop.job_tokens_out",
  stopRounds: "stop.job_tool_turns",
  stopTime: "stop.job_time",
  word: "word.job",
  wordCall: "word.call"
};
var JOBS = GROUP.jobs;
var ANSWERS3 = GROUP.answers;
var state = (id, label, text) => ({ id, group: JOBS, label: `A job that is ${label}`, note: "How a job's state is said, to an agent and in a job's line.", text, vars: [] });
var JOBS_TEXTS = [
  {
    id: JOBS_TEXT.objective,
    group: JOBS,
    label: "A long objective",
    note: "The first message of a job the user started on the page: the objective in their words, what the job may spend, and, for an agent that can write files, the plan it is asked for before it works and where it keeps its files.",
    text: [
      `You are running as a job the user started: work that is too long for a reply and ends in none. Nobody reads along, there is no writer to brief and no reply to write: write_reply isn't yours here. The user's objective, in their words:

{{task}}`,
      "{{allowance}} Everything you and the agents and jobs you start spend counts against it, and when it runs out you are stopped where you stand.{{files}}",
      "When you are done, answer with your report: what you did, what you found, and what is left."
    ].join(`

`),
    vars: [v("task", "the objective, as the user wrote it", true), v("allowance", "what the job may spend, as Its allowance writes it", true), v("files", "for an agent that can write files: its plan and where it keeps its files, as A long objective: files writes it (or one of its forms: for the chat's own area, or for a plan its starter keeps); nothing for one that can't")]
  },
  {
    id: JOBS_TEXT.objectiveFiles,
    group: JOBS,
    label: "A long objective: files",
    note: "Fills {{files}} in A long objective for an agent that can write files: the plan it is asked for and where it keeps what it learns.",
    text: [
      " So keep what you learn in files as you go, never only in your head.",
      "Before you work, write your plan to {{plan}}: what you will do with this allowance, where you will read closely, where a summary is enough, and what you will leave out. A smaller allowance means a narrower plan. Keep the plan true as you go: mark what is done, and change it when you change course. Whoever carries this job on, you among them, starts from that file.",
      "Work in learned/ (kept with this chat whatever path its story takes) and ~/ (the user's own, shared by all their chats). You can read the chat's own area (/) and can't change it: it follows the story as swipes and edits do, and you belong to the chat, not to a turn. Keep a plain list of what you have not verified in learned/, beside what you have, and say in your report where your files are."
    ].join(`

`),
    vars: [v("plan", "the plan file's path", true)]
  },
  {
    id: JOBS_TEXT.objectiveChat,
    group: JOBS,
    label: "A long objective: files, with the chat's own area",
    note: "Fills {{files}} in A long objective for a job that may write the chat's own area (an extension starts such a job to prepare a story), where its agent can write files.",
    text: [
      " So keep what you learn in files as you go, never only in your head.",
      "Before you work, write your plan to {{plan}}: what you will do with this allowance, where you will read closely, where a summary is enough, and what you will leave out. A smaller allowance means a narrower plan. Keep the plan true as you go: mark what is done, and change it when you change course. Whoever carries this job on, you among them, starts from that file.",
      "You may write the chat's own area (/), as it stands at the chat's latest reply, and learned/ (kept with this chat whatever path its story takes) and ~/ (the user's own, shared by all their chats). Keep a plain list of what you have not verified beside what you have, and say in your report where your files are."
    ].join(`

`),
    vars: [v("plan", "the plan file's path", true)]
  },
  {
    id: JOBS_TEXT.objectiveFilesKept,
    group: JOBS,
    label: "A long objective: files, with a plan its starter keeps",
    note: "Fills {{files}} in A long objective, in place of A long objective: files, where whoever started the job keeps its plan file with tools of its own (an extension that starts jobs): their words of the plan stand where the agent would be asked to write one.",
    text: [
      " So keep what you learn in files as you go, never only in your head.",
      "{{kept}}",
      "Work in learned/ (kept with this chat whatever path its story takes) and ~/ (the user's own, shared by all their chats). You can read the chat's own area (/) and can't change it: it follows the story as swipes and edits do, and you belong to the chat, not to a turn. Keep a plain list of what you have not verified in learned/, beside what you have, and say in your report where your files are."
    ].join(`

`),
    vars: [v("kept", "what whoever started the job tells its agent of the plan file they keep", true), v("plan", "the plan file's path")]
  },
  {
    id: JOBS_TEXT.objectiveChatKept,
    group: JOBS,
    label: "A long objective: files, with the chat's own area and a plan its starter keeps",
    note: "Fills {{files}} in A long objective, in place of its form for the chat's own area, where whoever started the job keeps its plan file with tools of its own (an extension's prepared start): their words of the plan stand where the agent would be asked to write one.",
    text: [
      " So keep what you learn in files as you go, never only in your head.",
      "{{kept}}",
      "You may write the chat's own area (/), as it stands at the chat's latest reply, and learned/ (kept with this chat whatever path its story takes) and ~/ (the user's own, shared by all their chats). Keep a plain list of what you have not verified beside what you have, and say in your report where your files are."
    ].join(`

`),
    vars: [v("kept", "what whoever started the job tells its agent of the plan file they keep", true), v("plan", "the plan file's path")]
  },
  { id: JOBS_TEXT.againNote, group: JOBS, label: "A job run again", note: "Ends the first message of a job the user ran again from the Jobs page: it is the same job, told what its first run was told, and why that run stopped.", text: "This is the same job run again. Its last run stopped: {{why}}.", vars: [v("why", "why the last run stopped, or how it stands", true)] },
  { id: JOBS_TEXT.againOffPath, group: GROUP.answers, label: "Run again: its reply is gone", note: "Why a job can't be run again from the Jobs page: the reply it was started from is no longer on the chat's path.", text: "Not run again: job {{id}} belongs to a reply that is no longer on the chat's path (it was swiped, edited away or deleted), so it would have no turn to work for. Show that reply again to run it, or start a new job.", vars: [v("id", "the job's id", true)] },
  { id: JOBS_TEXT.resumed, group: JOBS, label: "A job carried on", note: "What a job's agent is sent when the job is carried on from its own session: the user granted it more after its allowance ran out, or resumed it after a restart had found it paused.", text: "This job was stopped and is carried on now, from where you left it. {{allowance}}{{plan}} Then go on.", vars: [v("allowance", "what is left of what the job may spend, as Its allowance writes it", true), v("plan", "where its plan is, as A job carried on: its plan writes it (or its form for a plan its starter keeps); nothing for a job that was asked for none")] },
  { id: JOBS_TEXT.resumedPlan, group: JOBS, label: "A job carried on: its plan", note: "Fills {{plan}} for a job that was asked to keep a plan: one the user started.", text: " Read your plan ({{plan}}) and your files first: they say what is done and what is left.", vars: [v("plan", "the plan file's path", true)] },
  { id: JOBS_TEXT.resumedKept, group: JOBS, label: "A job carried on: a plan its starter keeps", note: "Fills {{plan}} in A job carried on, in place of A job carried on: its plan, for a job whose starter keeps its plan file with tools of its own: their words of the plan.", text: " {{kept}}", vars: [v("kept", "what whoever started the job tells its agent of the plan file they keep", true), v("plan", "the plan file's path")] },
  { id: JOBS_TEXT.allowance, group: JOBS, label: "Its allowance", note: "How a job's agent is told what the job may still spend.", text: "What this job may still spend: {{parts}}.", vars: [v("parts", "each limit, as the four texts below write them, or that there is none", true)] },
  { id: JOBS_TEXT.allowanceIn, group: JOBS, label: "Its allowance: prompt tokens", note: "One part of Its allowance.", text: "{{tokens}} sent to models", vars: [v("tokens", 'the prompt tokens left, with the word: "600000 tokens"', true)] },
  { id: JOBS_TEXT.allowanceOut, group: JOBS, label: "Its allowance: answer tokens", note: "One part of Its allowance.", text: "{{tokens}} written by them", vars: [v("tokens", 'the answer tokens left, with the word: "60000 tokens"', true)] },
  { id: JOBS_TEXT.allowanceRounds, group: JOBS, label: "Its allowance: rounds", note: "One part of Its allowance.", text: "{{rounds}} of tool calls", vars: [v("rounds", 'the rounds left, with the word: "60 rounds"', true)] },
  { id: JOBS_TEXT.allowanceTime, group: JOBS, label: "Its allowance: time", note: "One part of Its allowance.", text: "{{minutes}} minutes of work", vars: [v("minutes", "the minutes left", true)] },
  { id: JOBS_TEXT.allowanceNone, group: JOBS, label: "Its allowance: no limit", note: "Fills Its allowance when the job has no limit of its own.", text: "no limit of its own, only the day's", vars: [] },
  { id: JOBS_TEXT.spentReport, group: JOBS, label: "The report of a job stopped at its allowance", note: "The report of a job its allowance stopped: written by LumiAH, since the job's agent can make no further call.", text: `Stopped at its allowance: {{reason}}.{{said}}{{files}}{{plan}}
Granted more, it carries on from where it stopped.`, vars: [v("reason", "which limit stopped it", true), v("said", "what its agent had last written, if anything"), v("files", "the files it wrote in this run, if any"), v("plan", "where its plan is, for a job that was asked to keep one")] },
  { id: JOBS_TEXT.dayReport, group: JOBS, label: "The report of a job stopped at a day's limit", note: "The report of a job a limit on a day's spend stopped (Job tokens per day, Tokens per day, Cost per day): written by LumiAH, since the job's agent can make no further call. Nothing of the job is lost.", text: `Stopped at a day's limit: {{reason}}.{{said}}{{files}}{{plan}}
Nothing is lost: it carries on from where it stopped. Raise the limit it names in Settings (Job tokens per day is under Jobs; Tokens per day and Cost per day are under Spend), or wait until the last 24 hours count less, then carry it on from the Jobs page.`, vars: [v("reason", "which limit stopped it", true), v("said", "what its agent had last written, if anything"), v("files", "the files it wrote in this run, if any"), v("plan", "where its plan is, for a job that was asked to keep one")] },
  { id: JOBS_TEXT.spentPlan, group: JOBS, label: "A stopped job's report: its plan", note: "Fills {{plan}} for a job that was asked to keep a plan: one the user started.", text: `
Its plan, {{plan}}, says what it did and what is left.`, vars: [v("plan", "the plan file's path", true)] },
  { id: JOBS_TEXT.spentSaid, group: JOBS, label: "A stopped job's report: what it had last written", note: "Fills {{said}}.", text: `
It had last written: {{text}}`, vars: [v("text", "what its agent last wrote", true)] },
  { id: JOBS_TEXT.spentFiles, group: JOBS, label: "A stopped job's report: the files it wrote", note: "Fills {{files}}.", text: `
Files it wrote in this run: {{files}}`, vars: [v("files", "the files' paths", true)] },
  { id: JOBS_TEXT.noChatArea, group: ANSWERS3, label: "A job that belongs to the chat can't change the chat's own area", note: "A workspace tool's answer to a change of the chat's own area by a job the user started.", text: "Not changed: this job belongs to the chat, not to a turn, so it can't change the chat's own area (/), which follows the story as swipes and edits do. Write to learned/ (kept with the chat) or ~/ (the user's own).", vars: [] },
  {
    id: JOBS_TEXT.task,
    group: JOBS,
    label: "A job's task",
    note: "The first message a job's agent is sent.",
    text: `You are running as a job: work started from a chat that goes on after its reply was written. Nobody is waiting on you and nobody reads along. Your task:

{{task}}

When you are done, answer with your report: what you did, what you found, and where you left it (a workspace file's path, if you wrote one). The agent that started you is told how your report opens at its next turn and can read the whole.`,
    vars: [v("task", "the task, as it was given", true)]
  },
  { id: JOBS_TEXT.news, group: JOBS, label: "Jobs that ended", note: "Leads the main agent's turn with the jobs that ended since its last one.", text: `Jobs of this chat that ended since your last turn:
{{jobs}}`, vars: [v("jobs", "each job, as Jobs that ended: one job writes it", true)] },
  { id: JOBS_TEXT.newsLine, group: JOBS, label: "Jobs that ended: one job", note: "One job in Jobs that ended.", text: "- {{id}} ({{agent}}): {{state}}.{{report}}", vars: [v("id", "the job's id", true), v("agent", "the agent it ran as"), v("state", "how it ended"), v("report", "how its report opens and how to read the rest, or why it has none")] },
  { id: JOBS_TEXT.newsMore, group: JOBS, label: "Jobs that ended: a report's opening", note: "Fills {{report}} for a job that left a report.", text: " Its report opens: {{opening}}{{more}}", vars: [v("opening", "how the report opens, ending in \u2026 where there is more of it", true), v("more", "how to read the rest, when there is more")] },
  { id: JOBS_TEXT.newsRest, group: JOBS, label: "Jobs that ended: the rest of a report", note: "Fills {{more}} for a report longer than its opening. The opening already ends in \u2026 there, so this adds none.", text: " (job_read with job {{id}} reads the whole.)", vars: [v("id", "the job's id", true)] },
  { id: JOBS_TEXT.newsNoReport, group: JOBS, label: "Jobs that ended: no report", note: "Fills {{report}} for a job that left none.", text: " {{reason}}", vars: [v("reason", "why it ended as it did", true)] },
  { id: JOBS_TEXT.dueRunning, group: JOBS, label: "Jobs due that still run", note: "Leads the main agent's turn with the jobs started as due by this turn that hadn't ended when it stopped waiting for them (Wait for jobs due).", text: `Jobs due by this turn that haven't ended yet (their work isn't in; job_read reads one once it ends):
{{jobs}}`, vars: [v("jobs", "each job, as Jobs due: one job writes it", true)] },
  { id: JOBS_TEXT.dueLine, group: JOBS, label: "Jobs due: one job", note: "One job in Jobs due that still run.", text: "- {{id}} ({{agent}}{{as}}): {{state}}.", vars: [v("id", "the job's id", true), v("agent", "the agent it runs as"), v("as", "which one it stands for, as Jobs due: for whom writes it; nothing where the job names none"), v("state", "where it stands")] },
  { id: JOBS_TEXT.dueAs, group: JOBS, label: "Jobs due: for whom", note: "Fills {{as}} for a job started with as.", text: " for {{as}}", vars: [v("as", "which one the job's agent stands for", true)] },
  {
    id: toolId(TOOL.jobStart),
    group: GROUP.tools,
    label: "job_start: what it does",
    note: "The description of the job_start tool, as the model is offered it.",
    text: `Start a job: an agent that works on a task on its own after this reply, and reports when it is done. Use it for work too long for one reply and not needed by it: reading the whole chat to write notes, putting workspace files in order. Never for anything this reply depends on: a job's result reaches you at your next turn at the earliest (job_read reads its report sooner).
The agents a job can run as:
{{agents}}`,
    vars: [v("agents", "each agent a job may run as, as An agent to choose writes it", true)]
  },
  { id: toolArgId(TOOL.jobStart, "agent"), group: GROUP.tools, label: "job_start: agent", note: "The description of job_start's agent argument.", text: "The agent's id, from the list above.", vars: [] },
  { id: toolArgId(TOOL.jobStart, "task"), group: GROUP.tools, label: "job_start: task", note: "The description of job_start's task argument.", text: "What it is to do and what its report should say, in full. It knows nothing you don't write here; put long material in a workspace file and name the file.", vars: [] },
  { id: toolArgId(TOOL.jobStart, "when"), group: GROUP.tools, label: "job_start: when", note: "The description of job_start's when argument.", text: "after_reply (the default): it starts once this turn's reply is written. now: it starts at once and runs beside this turn.", vars: [] },
  { id: toolArgId(TOOL.jobStart, "again"), group: GROUP.tools, label: "job_start: again", note: "The description of job_start's again argument.", text: "The id of a job that was interrupted, failed or was cancelled, to start it again with the same agent and task. Give it in place of agent and task.", vars: [] },
  { id: toolArgId(TOOL.jobStart, "as"), group: GROUP.tools, label: "job_start: as", note: "The description of job_start's as argument, offered where an extension builds LumiAH in.", text: "Which one the job's agent is to be, where its kind stands for many (a character's id, for one). Leave it out for none.", vars: [] },
  { id: toolArgId(TOOL.jobStart, "lane"), group: GROUP.tools, label: "job_start: lane", note: "The description of job_start's lane argument, offered where an extension builds LumiAH in.", text: "soon: it goes before every waiting job that isn't. later (the default): it waits its turn behind those.", vars: [] },
  { id: toolArgId(TOOL.jobStart, "due"), group: GROUP.tools, label: "job_start: due", note: "The description of job_start's due argument, offered where an extension builds LumiAH in.", text: "next_turn: the next turn waits for it at its start, for a while, and is told if it still runs. Leave it out for work no turn waits on.", vars: [] },
  ...toolTexts(TOOL.jobList, "List this chat's jobs, the latest first: each with its id, its agent, where it stands and how its report opens.", { cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.jobRead, "Read one job: its task, where it stands, what it spent, and its report in full.", { job: "The job's id.", cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.jobCancel, "Cancel a job that is waiting or running. What it already wrote to the workspace stays.", { job: "The job's id." }),
  { id: JOBS_TEXT.started, group: ANSWERS3, label: "job_start: started", note: "job_start's answer once the job is started.", text: "Started job {{id}} ({{agent}}): {{when}}. You are told how its report opens at your next turn; job_read reads it sooner, and job_cancel stops it.", vars: [v("id", "the job's id", true), v("agent", "the agent it runs as"), v("when", "when it runs, as the two texts below say it")] },
  { id: JOBS_TEXT.whenNow, group: ANSWERS3, label: "job_start: runs now", note: "Fills {{when}} for a job that runs beside the turn.", text: "it runs now, beside this turn", vars: [] },
  { id: JOBS_TEXT.whenAfter, group: ANSWERS3, label: "job_start: runs after the reply", note: "Fills {{when}} for a job that waits for the reply.", text: "it runs once this turn's reply is written", vars: [] },
  { id: JOBS_TEXT.off, group: ANSWERS3, label: "job_start: jobs are off", note: "job_start's answer while Settings switch jobs off.", text: "Not started: jobs are switched off in Settings (Jobs). Do the work in this turn, or leave it.", vars: [] },
  { id: JOBS_TEXT.noAgent, group: ANSWERS3, label: "job_start: no such agent", note: "job_start's answer to an id that names no agent a job may run as.", text: "Not started: there's no agent {{agent}} a job can run as. A job can run as: {{agents}}.", vars: [v("agent", "the id asked for"), v("agents", "the ids there are", true)] },
  { id: JOBS_TEXT.taskLong, group: ANSWERS3, label: "job_start: the task is too long", note: "job_start's answer to a task past Task length.", text: "Not started: the task is {{chars}} characters, and a task may be {{limit}} at most (Task length). Put the details in a workspace file and name the file in a shorter task.", vars: [v("chars", "the task's length"), v("limit", "Task length", true)] },
  { id: JOBS_TEXT.noTask, group: ANSWERS3, label: "job_start: nothing to start", note: "job_start's answer to a call with neither an agent and a task nor a job to start again.", text: "Not started: give agent and task, or again with the id of a job to start again.", vars: [] },
  { id: JOBS_TEXT.tooMany, group: ANSWERS3, label: "job_start: too many jobs", note: "job_start's answer once the turn has started every job Jobs per turn allows.", text: "Not started: this turn has started the {{limit}} it may (Jobs per turn).", vars: [v("limit", 'Jobs per turn, with the word: "3 jobs"', true)] },
  { id: JOBS_TEXT.tooManyDelegated, group: ANSWERS3, label: "delegate: too many sub-agents in a job", note: "delegate's answer once a job has started every sub-agent Delegations per job allows.", text: "Not started: this job has started the {{limit}} it may (Delegations per job). Ask one you already have with agent_message, or do it yourself.", vars: [v("limit", 'Delegations per job, with the word: "3 sub-agents"', true)] },
  { id: JOBS_TEXT.noJob, group: ANSWERS3, label: "No such job", note: "The answer of job_read, job_cancel and job_start to an id that names no job of this chat.", text: "There's no job {{id}} in this chat. job_list lists the jobs there are.", vars: [v("id", "the id asked for", true)] },
  { id: JOBS_TEXT.notAgain, group: ANSWERS3, label: "job_start: a job that can't be started again", note: "job_start's answer to again naming a job that is still waiting, running or paused, or that ended with its report.", text: "Not started: job {{id}} is {{state}}. Only a job that was interrupted, failed, was cancelled, left the chat's path or stopped at its allowance can be started again.", vars: [v("id", "the job's id", true), v("state", "where it stands")] },
  { id: JOBS_TEXT.line, group: ANSWERS3, label: "job_list: one job", note: "One job in job_list's answer.", text: "- {{id}}: {{agent}}, {{state}}, started by {{by}}. Task: {{task}}{{report}}", vars: [v("id", "the job's id", true), v("agent", "the agent it runs as"), v("state", "where it stands"), v("by", "who started it"), v("task", "how its task opens"), v("report", "how its report opens, or why it has none")] },
  { id: JOBS_TEXT.none, group: ANSWERS3, label: "job_list: no jobs", note: "job_list's answer when the chat has none.", text: "This chat has no jobs.", vars: [] },
  { id: JOBS_TEXT.read, group: ANSWERS3, label: "job_read: a job", note: "Heads job_read's answer.", text: `Job {{id}}: {{agent}}, {{state}}, started by {{by}}. Spent {{tokens}} in {{calls}}.{{reason}}
Task: {{task}}`, vars: [v("id", "the job's id", true), v("agent", "the agent it runs as"), v("state", "where it stands"), v("by", "who started it"), v("tokens", 'what it sent and wrote, with the word: "41200 tokens"'), v("calls", 'its model calls, with the word: "12 calls"'), v("reason", "why it ended as it did, where it left no report"), v("task", "its task, whole")] },
  { id: JOBS_TEXT.reportPage, group: ANSWERS3, label: "job_read: the report", note: "One page of a job's report, under job_read's heading.", text: `{{head}}

[Its report, characters {{from}} to {{to}} of {{total}}.]
{{text}}`, vars: [v("head", "the heading, as job_read: a job writes it", true), v("from", "the first character returned"), v("to", "the character after the last one returned"), v("total", "the report's length"), v("text", "the characters read", true)] },
  { id: JOBS_TEXT.noReport, group: ANSWERS3, label: "job_read: no report", note: "Follows job_read's heading for a job that has no report.", text: `{{head}}

It has no report.`, vars: [v("head", "the heading, as job_read: a job writes it", true)] },
  { id: JOBS_TEXT.cancelled, group: ANSWERS3, label: "job_cancel: cancelled", note: "job_cancel's answer.", text: "Cancelled job {{id}}. What it had already written to the workspace stays.", vars: [v("id", "the job's id", true)] },
  { id: JOBS_TEXT.ended, group: ANSWERS3, label: "job_cancel: already ended", note: "job_cancel's answer to a job that has ended.", text: "Job {{id}} had already ended ({{state}}); there is nothing to cancel.", vars: [v("id", "the job's id", true), v("state", "how it ended")] },
  { id: JOBS_TEXT.byAgent, group: JOBS, label: "Started by an agent", note: "Says who started a job, for one an agent's job_start call started.", text: "the {{role}} agent", vars: [v("role", "the definition of the agent that started it", true)] },
  { id: JOBS_TEXT.byUser, group: JOBS, label: "Started by the user", note: "Says who started a job, for one the user started.", text: "the user", vars: [] },
  state(JOBS_TEXT.state.queued, "waiting", "waiting to run"),
  state(JOBS_TEXT.state.running, "running", "running"),
  state(JOBS_TEXT.state.done, "done", "done"),
  state(JOBS_TEXT.state.failed, "failed", "failed"),
  state(JOBS_TEXT.state.cancelled, "cancelled", "cancelled"),
  state(JOBS_TEXT.state.interrupted, "interrupted", "interrupted"),
  state(JOBS_TEXT.state.off_path, "off the path", "stopped: off the chat's path"),
  state(JOBS_TEXT.state.spent, "stopped at its allowance", "stopped at its allowance"),
  state(JOBS_TEXT.spentDay, "stopped at a day's limit", "stopped at a day's limit, with nothing lost"),
  { id: JOBS_TEXT.whyCutThinking, group: JOBS, label: "Why: its answer ran out while it was thinking", note: "A job's reason when its agent's model used all its answer room on thinking and wrote no report.", text: "its agent ran out of answer room while it was still thinking, so it wrote no report (Answer per call, in the agent's settings, is that room). Raise it for this agent, or lower its effort, then run the job again", vars: [] },
  state(JOBS_TEXT.state.paused, "paused, with no run under way", "paused by the user"),
  state(JOBS_TEXT.paused, "paused", "running, paused by the user"),
  { id: JOBS_TEXT.whyCancelledByAgent, group: JOBS, label: "Why: cancelled by an agent", note: "A job's reason when an agent's job_cancel ended it.", text: "the {{role}} agent cancelled it", vars: [v("role", "the definition of the agent that cancelled it", true)] },
  { id: JOBS_TEXT.whyCancelledByUser, group: JOBS, label: "Why: cancelled by the user", note: "A job's reason when the user cancelled it.", text: "the user cancelled it", vars: [] },
  { id: JOBS_TEXT.whyInterrupted, group: JOBS, label: "Why: interrupted", note: "A job's reason when the runtime restarted while it ran.", text: "the runtime restarted while it ran; what it had written to the workspace is kept, and job_start with again starts it again", vars: [] },
  { id: JOBS_TEXT.whyOffPath, group: JOBS, label: "Why: off the path", note: "A job's reason when the turn it belongs to left the chat's active path.", text: "the turn that started it is no longer on the chat's active path (its reply was swiped, edited away or deleted), so it stopped", vars: [] },
  { id: JOBS_TEXT.whyOff, group: JOBS, label: "Why: jobs switched off", note: "A job's reason when it was to run while Settings switch jobs off.", text: "jobs were switched off in Settings before it ran", vars: [] },
  { id: JOBS_TEXT.whyNoAnswer, group: JOBS, label: "Why: no report", note: "A job's reason when its agent ended without an answer and gave no reason of its own.", text: "its agent ended without a report", vars: [] },
  { id: JOBS_TEXT.whyStopped, group: JOBS, label: "Why: the runtime stopped it", note: "A job's reason when the runtime stopped its run and said nothing more.", text: "the runtime stopped it", vars: [] },
  { id: JOBS_TEXT.whyNoRecord, group: JOBS, label: "Why: its turn left no record", note: "A job's reason when the turn that started it ended without leaving a record on its reply (it was stopped, or failed), so the job has no turn to belong to.", text: "the turn that started it left no record on its reply (it was stopped or failed), so the job has no turn to belong to", vars: [] },
  { id: JOBS_TEXT.whyGone, group: JOBS, label: "Why: its agent is gone", note: "A job's reason when the agent definition it runs as was removed or switched off before it ran.", text: "the agent {{agent}} it was to run as is gone or switched off", vars: [v("agent", "the agent definition's id", true)] },
  stopText(JOBS_TEXT.stopOffPath, "A job off the path", "The turn a job belongs to left the chat's active path, so the job stopped.", "the turn this job belongs to is no longer on the chat's active path"),
  stopText(JOBS_TEXT.stopJobTokens, "Job tokens per day spent", "A job's call once the jobs' calls together have sent and written all Job tokens per day allows.", "what jobs sent and wrote in the last 24 hours is counted as {{tokens}} of the {{limit}} Job tokens per day allows (a cached re-read counts as {{weight}} of a token)", [v("tokens", 'what jobs spent in the last 24 hours as the limit counts it, with the word: "3000000 tokens"', true), v("limit", "Job tokens per day", true), v("weight", "What a cached re-read counts as")]),
  stopText(JOBS_TEXT.stopJobTokensCall, "Job tokens per day: the call would pass it", "A job's call whose own prompt would take the jobs' calls past Job tokens per day, though they are under it so far.", "the call would take what jobs sent and wrote in the last 24 hours past Job tokens per day: counted as {{counted}} with it, of the {{limit}} allowed (a cached re-read counts as {{weight}} of a token)", [v("counted", `what jobs spent in the last 24 hours as the limit counts it, with this call's prompt as estimated and the calls under way, with the word: "3004000 tokens"`, true), v("limit", "Job tokens per day", true), v("weight", "What a cached re-read counts as")]),
  stopText(JOBS_TEXT.stopIn, "The job's prompt tokens spent", "A call that would take the job's prompt tokens past Prompt tokens per job.", "the call would take the job's prompt tokens past Prompt tokens per job: counted as {{counted}} of the {{limit}} allowed (a cached re-read counts as {{weight}} of a token)", [v("counted", "the prompt tokens with this call, as the limit counts them"), v("weight", "What a cached re-read counts as"), v("limit", "Prompt tokens per job", true)]),
  stopText(JOBS_TEXT.stopOut, "The job's answer tokens spent", "The job's agents have written all Answer tokens per job allows.", "the job's agents have written its {{tokens}} (Answer tokens per job)", [v("tokens", 'Answer tokens per job, with the word: "60000 tokens"', true)]),
  stopText(JOBS_TEXT.stopRounds, "The job's tool rounds spent", "The job's agents have had every round of tool calls Tool rounds per job allows.", "the job's agents have had its {{rounds}} of tool calls (Tool rounds per job)", [v("rounds", 'Tool rounds per job, with the word: "60 rounds"', true)]),
  stopText(JOBS_TEXT.stopTime, "The job out of time", "The job's time ran out (Time per job).", "the job's time ran out (Time per job)"),
  word(JOBS_TEXT.word, "job", "jobs"),
  word(JOBS_TEXT.wordCall, "call", "calls")
];

// src/core/texts/recall.ts
var RECALL_TEXT = {
  none: "session.none",
  span: "recall.span",
  message: "recall.span.one",
  when: "recall.when",
  state: {
    held: "tool.answer.lore_in_prompt",
    off: "tool.answer.lore_off",
    always: "tool.answer.lore_always"
  },
  prompt: {
    span: "recall.span",
    message: "recall.span.one",
    from: "recall.prompt.from",
    fromUnnamed: "recall.prompt.from.unnamed",
    lore: "recall.prompt.lore",
    loreLine: "recall.prompt.lore.line",
    loreUnnamed: "recall.prompt.lore.unnamed",
    loreMore: "recall.prompt.lore.more",
    loreNone: "recall.prompt.lore.none",
    loreNoneShown: "recall.prompt.lore.none_shown",
    unseen: "recall.prompt.unseen",
    unseenLine: "recall.prompt.unseen.line",
    unseenMore: "recall.prompt.unseen.more",
    unseenAdd: "recall.prompt.unseen.add",
    whyKey: "recall.prompt.why.key",
    whyKeyUnknown: "recall.prompt.why.key_unknown",
    whyVector: "recall.prompt.why.vector",
    whyVectorScore: "recall.prompt.why.vector_score",
    whyConstant: "recall.prompt.why.constant",
    whyUnknown: "recall.prompt.why.unknown",
    whereMessage: "recall.prompt.where.message",
    whereInside: "recall.prompt.where.inside",
    index: "recall.prompt.index",
    indexLine: "recall.prompt.index.line",
    indexOff: "recall.prompt.index.off",
    indexMore: "recall.prompt.index.more",
    indexAdd: "recall.prompt.index.add",
    history: "recall.prompt.history",
    historyNone: "recall.prompt.history.none",
    historyAll: "recall.prompt.history.all",
    historyMissing: "recall.prompt.history.missing",
    stands: "recall.prompt.history.stands",
    standNone: "recall.prompt.history.stands.none",
    stand: {
      book: "recall.prompt.history.stand.book",
      summary: "recall.prompt.history.stand.summary",
      memories: "recall.prompt.history.stand.memories"
    }
  },
  writer: {
    unknown: "recall.writer.refused.unknown",
    ambiguous: "recall.writer.refused.ambiguous",
    held: "recall.writer.refused.held",
    notHeld: "recall.writer.refused.not_held",
    unseen: "recall.writer.refused.unseen",
    off: "recall.writer.refused.off",
    empty: "recall.writer.refused.empty",
    inline: "recall.writer.refused.inline",
    capEntries: "recall.writer.refused.cap_entries",
    capChars: "recall.writer.refused.cap_chars",
    addOff: "recall.writer.refused.add_off",
    dropOff: "recall.writer.refused.drop_off",
    twice: "recall.writer.refused.twice",
    unread: "recall.writer.refused.unread"
  },
  answer: {
    chatSearchNothing: "tool.answer.chat_search_nothing",
    chatGrepNothing: "tool.answer.chat_grep_nothing",
    loreSearchNothing: "tool.answer.lore_search_nothing",
    loreGrepNothing: "tool.answer.lore_grep_nothing",
    chatHit: "tool.answer.chat_hit",
    chatLine: "tool.answer.chat_line",
    chatMessage: "tool.answer.chat_message",
    chatRead: "tool.answer.chat_read",
    chatNoMessage: "tool.answer.chat_no_message",
    chatEmpty: "tool.answer.chat_empty",
    chatNoStory: "tool.answer.chat_no_story",
    chatLeftOut: "tool.answer.chat_left_out",
    chatLeftHidden: "tool.answer.chat_left_out.hidden",
    chatLeftDirections: "tool.answer.chat_left_out.directions",
    chatLeftOne: "tool.answer.chat_left_one",
    chatLeftOneHidden: "tool.answer.chat_left_one.hidden",
    chatLeftOneDirection: "tool.answer.chat_left_one.direction",
    chatAllLeftOut: "tool.answer.chat_all_left_out",
    loreBook: "tool.answer.lore_book",
    loreEntry: "tool.answer.lore_entry",
    loreHit: "tool.answer.lore_hit",
    loreLine: "tool.answer.lore_line",
    loreRead: "tool.answer.lore_read",
    loreNoEntry: "tool.answer.lore_no_entry",
    loreNoBook: "tool.answer.lore_no_book",
    loreNoBooks: "tool.answer.lore_no_books",
    loreAmbiguous: "tool.answer.lore_ambiguous",
    activeEntry: "tool.answer.active_entry",
    activeNone: "tool.answer.active_none",
    activeUnseen: "tool.answer.active_unseen",
    queryHead: "tool.answer.query_head",
    queryMore: "tool.answer.query_more",
    hitLine: "tool.answer.hit_line",
    hitAbove: "tool.answer.hit_above",
    byWords: "tool.answer.by_words",
    byMeaning: "tool.answer.by_meaning",
    byBoth: "tool.answer.by_both",
    fieldTitle: "tool.answer.field.title",
    fieldKey: "tool.answer.field.key",
    fieldText: "tool.answer.field.text",
    wordOnly: "tool.answer.word_only",
    badPattern: "tool.answer.bad_pattern",
    patternNested: "tool.answer.bad_pattern.nested",
    patternBack: "tool.answer.bad_pattern.back",
    patternLong: "tool.answer.bad_pattern.long",
    patternMany: "tool.answer.bad_pattern.many",
    grepLate: "tool.answer.grep_late",
    badFilter: "tool.answer.bad_filter",
    tooMany: "tool.answer.too_many",
    loreIndexNothing: "tool.answer.lore_index_nothing",
    loreMissing: "tool.answer.lore_missing",
    loreRelated: "tool.answer.lore_related",
    loreLink: "tool.answer.lore_link",
    loreLinksMore: "tool.answer.lore_links_more",
    loreAbout: "tool.answer.lore_about",
    loreAboutNothing: "tool.answer.lore_about_nothing",
    chatStretch: "tool.answer.chat_stretch",
    chatStretchMore: "tool.answer.chat_stretch_more",
    chatSearchHead: "tool.answer.chat_search_head",
    chatNoSpeaker: "tool.answer.chat_no_speaker",
    chatBadRange: "tool.answer.chat_bad_range",
    chatAbout: "tool.answer.chat_about",
    chatAboutOnce: "tool.answer.chat_about_once",
    chatAboutNothing: "tool.answer.chat_about_nothing",
    chatAboutNear: "tool.answer.chat_about_near",
    trailLine: "tool.answer.trail_line",
    chatCiteChanged: "tool.answer.chat_cite_changed",
    chatCiteMoved: "tool.answer.chat_cite_moved",
    chatCiteGone: "tool.answer.chat_cite_gone",
    chatNotNamed: "tool.answer.chat_not_named",
    outline: "tool.answer.chat_outline",
    outlineBook: "tool.answer.chat_outline.book",
    outlineArcs: "tool.answer.chat_outline.arcs",
    outlineSkeleton: "tool.answer.chat_outline.skeleton",
    outlineNode: "tool.answer.chat_outline.node",
    outlineNodeBook: "tool.answer.chat_outline.node.book",
    outlineNodeArc: "tool.answer.chat_outline.node.arc",
    outlinePart: "tool.answer.chat_outline.part",
    outlineNext: "tool.answer.chat_outline.next",
    outlineLeaf: "tool.answer.chat_outline.leaf",
    outlineStretches: "tool.answer.chat_outline.stretches",
    outlineStretch: "tool.answer.chat_outline.stretch",
    chronicleCheck: "tool.answer.chronicle_check",
    chronicleFile: "tool.answer.chronicle_file",
    chronicleOk: "tool.answer.chronicle_ok",
    chronicleProblems: "tool.answer.chronicle_problems",
    chronicleFailure: "tool.answer.chronicle_failure",
    chronicleNotAsCited: "tool.answer.chronicle_failure.not_as_cited",
    chronicleNoMessage: "tool.answer.chronicle_failure.no_message",
    chronicleNowhere: "tool.answer.chronicle_failure.nowhere",
    chronicleSeveral: "tool.answer.chronicle_failure.several",
    chronicleUncited: "tool.answer.chronicle_uncited",
    chronicleCorrected: "tool.answer.chronicle_corrected",
    chronicleCorrection: "tool.answer.chronicle_correction",
    chronicleCorrectedMore: "tool.answer.chronicle_corrected.more",
    chronicleUncorrected: "tool.answer.chronicle_uncorrected",
    chronicleStale: "tool.answer.chronicle_uncorrected.stale",
    chronicleNoRoom: "tool.answer.chronicle_uncorrected.limit",
    chronicleGaps: "tool.answer.chronicle_gaps",
    chronicleCovered: "tool.answer.chronicle_gaps.none",
    chronicleNone: "tool.answer.chronicle_none",
    chronicleNoFile: "tool.answer.chronicle_no_file",
    memoryHead: "tool.answer.memory_head",
    memoryHit: "tool.answer.memory_hit",
    memoryChunk: "tool.answer.memory_hit.chunk",
    memoryArcSource: "tool.answer.memory_hit.arc",
    memoryNothing: "tool.answer.memory_nothing",
    memoryEntity: "tool.answer.memory_entity",
    memoryRelation: "tool.answer.memory_relation",
    memoryNoEntity: "tool.answer.memory_no_entity",
    memoryEntities: "tool.answer.memory_entities",
    memoryEntityBrief: "tool.answer.memory_entity_brief",
    memoryNoEntities: "tool.answer.memory_no_entities",
    memoryArc: "tool.answer.memory_arc",
    memoryNoArcs: "tool.answer.memory_no_arcs",
    memoryOff: "tool.answer.memory_off",
    databank: "tool.answer.databank",
    databankDoc: "tool.answer.databank_doc",
    databankNone: "tool.answer.databank_none",
    databankHit: "tool.answer.databank_hit",
    databankNothing: "tool.answer.databank_nothing",
    databankUnread: "tool.answer.databank_unread",
    databankRead: "tool.answer.databank_read",
    databankNoDoc: "tool.answer.databank_no_doc",
    databankNotReady: "tool.answer.databank_not_ready",
    webHead: "tool.answer.web_head",
    webResult: "tool.answer.web_result",
    webPage: "tool.answer.web_page",
    webNothing: "tool.answer.web_nothing",
    webOff: "tool.answer.web_off",
    memoryMore: "tool.answer.memory_more",
    memoryFailed: "tool.answer.memory_failed",
    databankFailed: "tool.answer.databank_failed",
    webFailed: "tool.answer.web_failed"
  },
  chronicle: {
    pinned: "recall.chronicle.pinned",
    pinnedFile: "recall.chronicle.pinned.file",
    pinnedMore: "recall.chronicle.pinned.more",
    pinnedFailed: "recall.chronicle.pinned.failed",
    pinnedApart: "recall.chronicle.pinned.apart",
    reach: "recall.chronicle.reach",
    reachNone: "recall.chronicle.reach.none",
    empty: "recall.chronicle.empty",
    jobRunning: "recall.chronicle.upkeep.running",
    jobWaiting: "recall.chronicle.upkeep.waiting",
    kept: "recall.chronicle.upkeep.kept",
    due: "recall.chronicle.upkeep.due",
    begin: "recall.chronicle.upkeep.begin",
    how: "recall.chronicle.upkeep.how",
    howWrites: "recall.chronicle.upkeep.how.writes",
    before: "recall.chronicle.upkeep.before"
  },
  chronicler: "recall.chronicler",
  reader: "recall.reader",
  story: { objective: "recall.story.objective" },
  word: {
    message: "word.message",
    entry: "word.entry",
    line: "word.line",
    stretch: "word.stretch",
    mention: "word.mention",
    hit: "word.hit",
    part: "word.outline_part",
    worldBook: "word.world_book",
    memory: "word.memory",
    document: "word.document",
    result: "word.result",
    arc: "word.memory_arc",
    fact: "word.fact",
    relation: "word.relation",
    databank: "word.databank",
    problem: "word.chronicle_problem",
    citation: "word.citation",
    entity: "word.entity"
  }
};
var RECALL = GROUP.recall;
var ANSWERS4 = GROUP.answers;
var TOOLS = GROUP.tools;
var A = RECALL_TEXT.answer;
var P = RECALL_TEXT.prompt;
var W = RECALL_TEXT.writer;
var C = RECALL_TEXT.chronicle;
var CITE = v("cite", "the message's citation: its number and the start of its text's hash, as [#412 a3f9c27e]. Agents copy it into the chronicle and chronicle_check reads it back, so keep it as it is", true);
var WHEN = v("when", "when it was sent, as When a message was sent writes it; nothing where Lumiverse gives no time");
var QUERIES = "What to look for: one query or several, each answered on its own. Names and rare words find the most.";
var FROM = "Only messages from this number on.";
var TO = "Only messages up to this number.";
var SPEAKER = "Only messages of this speaker: a name as the chat shows it, or user or assistant.";
var REGEX = "true: text is a regular expression (JavaScript's, case-insensitive), matched within one line. Keep it simple: a repeat (*, +, {n,m}) follows one character or class, never a group, and an alternative holds one of * and + at most.";
var arg = (tool, name, text, vars) => ({ id: toolArgId(tool, name), group: TOOLS, label: `${tool}: ${name}`, note: `The description of ${tool}'s ${name} argument.`, text, vars });
var RECALL_TEXTS = [
  ...toolTexts(TOOL.chatOutline, "The story so far as a table of contents: each part with the chat messages it spans, when it was, who speaks, how long it is and how it opens. It comes from the chat's book where it has one, else from the arcs of Lumiverse's memory, else from the chat itself, worked out by code. Start here when you need to know where in a long chat something is. Give from and to to open one part into its smaller parts.", {
    from: "The first message of the part to open, by its number.",
    to: "The last message of the part to open, by its number.",
    stretches: "true: instead of the outline, answer with the messages that from and to name (the whole chat without them) cut into the stretches readers are given, in order, one line each: its messages, how many they are and how long. The size of a stretch is the user's setting, and the cut is made for you: hand on each line's numbers as they stand.",
    cursor: CURSOR_ARG
  }),
  ...toolTexts(TOOL.chatAbout, "The trail of a name or a phrase through this chat: where it first appears, where it last appears, how often, and its most telling lines in order, each with its message's citation. One call answers \u201Cwhat did the chat last establish about the brass key\u201D. Give each name as the chat writes it; several names each get a trail of their own.", { names: "The names or phrases to trace, each as the chat writes it.", from: FROM, to: TO }),
  ...toolTexts(TOOL.chatSearch, "Search this chat's messages by words, best match first: every message, those too old to be in the request among them. Several queries in one call are each answered on their own. Hits are grouped by stretch of the chat, so one exchange doesn't fill the page; each hit shows its message's citation and its best lines. chat_around reads around a hit, chat_read reads messages whole. Narrow with from, to and speaker.", { queries: QUERIES, from: FROM, to: TO, speaker: SPEAKER, cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.chatGrep, "Find every line of this chat that holds some exact text, in any letter case, oldest first, each with its message's citation and its line number. Use it for a name, a phrase or a number; use chat_search when you only know roughly what was said, and chat_about for the whole trail of a name. Narrow with from, to and speaker.", { text: "The text to find, as written; letter case doesn't matter.", regex: REGEX, from: FROM, to: TO, speaker: SPEAKER, cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.chatRead, "Read messages of this chat by their number, as the request and the other chat tools name them (#12): one message, or a run of them from one number to another. Each comes with its citation ([#12 a3f9c27e]: its number and the start of its text's hash): copy it whenever you write down what a message established. A long read comes a page at a time.", { from: "The first message to read, by its number or its citation.", to: "The last message to read, by its number or its citation; leave it out to read one message.", cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.chatAround, "Read the messages around one: a search hit, a line of a trail, a message a citation names. A long read comes a page at a time.", {
    message: "The message, by its number (412) or its citation ([#412 a3f9c27e]).",
    before: "How many messages before it to read.",
    after: "How many messages after it to read.",
    cursor: CURSOR_ARG
  }),
  ...toolTexts(TOOL.loreIndex, "List the world books that apply to this chat, and each one's entries: an entry's id, its title, its keys, its length and how it stands (in the prompt, always sent, switched off). Filter by book, by state, or by text in a title or a key.", {
    book: "A book's id or name, to list that book alone.",
    state: "Only entries that stand so: in_prompt, not_in_prompt, always or off.",
    text: "Only entries whose title or keys hold this text, in any letter case.",
    cursor: CURSOR_ARG
  }),
  ...toolTexts(TOOL.loreSearch, "Search the entries of this chat's world books by words, best match first: titles, keys and text, entries Lumiverse didn't activate among them. A word in a title or a key counts for more than one in the text. Several queries in one call are each answered on their own. Each hit shows how the entry stands, where it matched and its best lines; lore_read reads entries whole.", { queries: QUERIES, book: "Only entries of this book, by its id or name.", cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.loreGrep, "Find every line of this chat's world books that holds some exact text, in any letter case, each with its entry and line number.", { text: "The text to find, as written; letter case doesn't matter.", regex: REGEX, book: "Only entries of this book, by its id or name.", cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.loreRead, "Read entries of this chat's world books whole, by the ids the request's index, lore_index and the lore searches give: one entry or several in one call. A long read comes a page at a time.", { ids: "The entries' ids, as the index and the lore searches give them.", cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.loreRelated, "One step along the lore's own links from an entry: the entries its text mentions by their titles or keys, and the entries that mention it. Use it to find what an entry leans on before the writer leans on it.", { id: "The entry's id, as the index and the lore searches give it." }),
  ...toolTexts(TOOL.loreAbout, "Everything the world books hold on a name: the entries titled or keyed with it first, then the entries whose text mentions it, each with the line that does.", { name: "The name, as the lore writes it." }),
  ...toolTexts(TOOL.activeLore, "List the lore entries Lumiverse activated for this reply: their text is already in the request. Use it to tell what the writer has from what it lacks.", { cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.chronicleCheck, "Check the chronicle (the files of learned/chronicle/) against the chat as it stands, by code. Each citation is compared with the message at its number: that proves the message exists and reads as cited, not that it supports the line. A line fails where a citation doesn't hold, and where it cites nothing; a line that fails is left out of what the main agent is given. Where a citation's hash is that of exactly one other message, the number was wrong: the check writes the right number into the file itself and says what it corrected. It also lists the stretches of the chat the outline covers nothing of. Run it before you lean on the chronicle, and after you write to it.", { path: "One file of the chronicle, to check that file alone: learned/chronicle/facts.md.", cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.memorySearch, "Ask Lumiverse's Memory Cortex what it holds of this chat on something: its own ranked retrieval over the chat's memory, chunks of the chat and arcs, each with the messages it was made from. Several queries in one call are each answered on their own. It is Lumiverse's reading of the chat: where wording matters, read the messages.", {
    queries: QUERIES,
    entities: "Only memories that name these entities, as memory_entity names them."
  }),
  ...toolTexts(TOOL.memoryEntity, "What Lumiverse's Memory Cortex has recorded of a person, a place or a thing in this chat: what it is, how it stands, its facts and its relations. Without a name it lists the entities it knows.", { name: "The entity's name, or one of its aliases; leave it out to list the entities there are." }),
  ...toolTexts(TOOL.memoryArcs, "The arcs Lumiverse's Memory Cortex has made of this chat: scenes, chapters and larger arcs, each with its summary and the messages it covers.", { cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.databankList, "List the databanks that apply to this chat (the user's own reference documents: global ones, the character's and the chat's) and each one's documents, with the id databank_read takes.", { cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.databankSearch, "Search the text of this chat's databank documents by words, best match first. Several queries in one call are each answered on their own; databank_read reads a document whole.", { queries: QUERIES, cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.databankRead, "Read a databank document whole, by the id databank_list and databank_search give. A long document comes a page at a time.", { id: "The document's id, as databank_list gives it.", cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.webSearch, "Search the web with the user's own search provider. It leaves this machine, so use it only for what the chat, the lore and the databanks can't answer: a real-world fact the story leans on.", {
    query: "What to search for, as you would type it into a search engine.",
    pages: "true: read the pages found too, not only their snippets."
  }),
  arg(TOOL.writeReply, "add", "Lore entries to give the writer whole, by the ids the request's index and the lore tools give: each entry's own text is put where Lumiverse puts world info, so you don't retype it in the brief. At most {{entries}} and {{chars}} characters in all: name only what this reply leans on.", [
    v("entries", 'how many entries one reply may add, with the word: "8 entries"'),
    v("chars", "how much text the added entries may hold together")
  ]),
  arg(TOOL.writeReply, "drop", "Lore entries that are in the prompt to take out of what the writer is sent, by their ids: ones that would mislead this reply. The chat and its books stay as they are.", []),
  { id: RECALL_TEXT.span, group: RECALL, label: "A run of messages", note: "How the notes and the chat tools write a run of chat messages.", text: "#{{from}} to #{{to}}", vars: [v("from", "the first message's number", true), v("to", "the last message's number", true)] },
  { id: RECALL_TEXT.message, group: RECALL, label: "A run of one message", note: "As A run of messages, where the run is one message.", text: "#{{index}}", vars: [v("index", "the message's number", true)] },
  { id: RECALL_TEXT.when, group: RECALL, label: "When a message was sent", note: "Follows who wrote a message in the chat tools' answers, where Lumiverse gives its time (UTC).", text: " \xB7 {{date}}", vars: [v("date", "the day, and the time where one message is meant: 2026-03-04 21:15", true)] },
  { id: RECALL_TEXT.state.held, group: ANSWERS4, label: "An entry in the prompt", note: "Marks an entry whose text the request already holds, in the lore tools' answers.", text: " (in the prompt)", vars: [] },
  { id: RECALL_TEXT.state.off, group: ANSWERS4, label: "An entry switched off", note: "Marks an entry that is switched off in its book, in the lore tools' answers.", text: " (switched off)", vars: [] },
  { id: RECALL_TEXT.state.always, group: ANSWERS4, label: "An entry always sent", note: "Marks an entry its book always sends, in the lore tools' answers.", text: " (always sent)", vars: [] },
  { id: P.from, group: RECALL, label: "From the lore", note: "Fills {{from}} of a request's message that is a world-info entry Lumiverse put in the prompt.", text: " \xB7 lore entry [{{id}}] {{title}}", vars: [v("id", "the entry's id, as the lore tools take it", true), v("title", "its title")] },
  { id: P.fromUnnamed, group: RECALL, label: "From the lore, entry not named", note: "Fills {{from}} of a request's message that Lumiverse flagged as World Info without saying which entry it is, where its text is no entry's.", text: " \xB7 world info (Lumiverse doesn't say which entry)", vars: [] },
  {
    id: P.lore,
    group: RECALL,
    label: "Lore in the prompt",
    note: "The first of three notes that follow the request: the lore entries Lumiverse put in this prompt.",
    text: `Lore in the prompt ({{count}}, about {{tokens}} tokens). The writer already has these:
{{entries}}`,
    vars: [v("count", 'how many entries, with the word: "6 entries"'), v("tokens", "their size together, in tokens as estimated"), v("entries", "each entry, as An entry in the prompt writes it", true)]
  },
  { id: P.loreLine, group: RECALL, label: "An entry in the prompt", note: "One entry in Lore in the prompt.", text: "- [{{id}}] {{title}} \xB7 {{chars}} characters \xB7 {{why}} \xB7 {{where}}", vars: [v("id", "the entry's id, as the lore tools take it", true), v("title", "its title"), v("chars", "the length of its text in the prompt"), v("why", "how it got there, in the words below"), v("where", "which message of the request holds it, in the words below")] },
  { id: P.loreMore, group: RECALL, label: "More entries in the prompt", note: "Ends Lore in the prompt when not every entry fits its length.", text: "(and {{count}} more: lore_index with state in_prompt lists them)", vars: [v("count", "how many more", true)] },
  { id: P.loreUnnamed, group: RECALL, label: "A World Info message of no known entry", note: "One line in Lore in the prompt for a message Lumiverse flagged as World Info without naming its entry, whose text is exactly no entry's. Nothing is guessed about which entry it may be.", text: "- world info Lumiverse didn't name \xB7 {{chars}} characters \xB7 {{where}} \xB7 opens: {{opening}}", vars: [v("chars", "the length of its text in the prompt"), v("where", "which message of the request it is, in the words below", true), v("opening", "how its text opens", true)] },
  { id: P.loreNone, group: RECALL, label: "No lore in the prompt", note: "Stands for Lore in the prompt when Lumiverse put no world-info entry in it.", text: "Lore in the prompt: none. Lumiverse activated no world-info entry for this reply.", vars: [] },
  { id: P.loreNoneShown, group: RECALL, label: "No lore shown in the prompt", note: "Stands for Lore in the prompt when Lumiverse activated entries and the request shows the text of none of them. The entries follow, apart.", text: "Lore in the prompt: the request shows the text of no world-info entry.", vars: [] },
  {
    id: P.unseen,
    group: RECALL,
    label: "Activated, but not in the request",
    note: "Follows Lore in the prompt, within its length: the entries Lumiverse says it activated whose text no message of the request shows. The writer doesn't have them.",
    text: `Activated by Lumiverse, but their text is not in the request ({{count}}). The writer doesn't have these.{{add}}
{{entries}}`,
    vars: [v("count", 'how many entries, with the word: "2 entries"'), v("add", "how to give one to the writer, in the words below; nothing where it can't be done"), v("entries", "each entry, as An entry activated but not shown writes it", true)]
  },
  { id: P.unseenLine, group: RECALL, label: "An entry activated but not shown", note: "One entry in Activated, but not in the request.", text: "- [{{id}}] {{title}} \xB7 {{chars}} characters \xB7 {{why}}", vars: [v("id", "the entry's id, as the lore tools take it", true), v("title", "its title"), v("chars", "the length of its text"), v("why", "how Lumiverse says it was activated, in the words below")] },
  { id: P.unseenMore, group: RECALL, label: "More entries activated but not shown", note: "Ends Activated, but not in the request when not every entry fits.", text: "(and {{count}} more)", vars: [v("count", "how many more", true)] },
  { id: P.unseenAdd, group: RECALL, label: "How to give the writer an entry that isn't shown", note: "Fills {{add}} where the main agent briefs a writer and Settings let it add entries.", text: " To give the writer one whole, name its id in write_reply's add.", vars: [] },
  { id: P.whyKey, group: RECALL, label: "Why: a key matched", note: "How an entry got into the prompt, where Lumiverse says a key matched and names it. LumiAH never works a key out itself.", text: "key \u201C{{key}}\u201D matched", vars: [v("key", "the key Lumiverse names", true)] },
  { id: P.whyKeyUnknown, group: RECALL, label: "Why: a key, not named", note: "As above, where Lumiverse says a key matched and doesn't say which.", text: "a key matched", vars: [] },
  { id: P.whyVector, group: RECALL, label: "Why: a vector match", note: "How an entry got into the prompt: Lumiverse matched it by meaning.", text: "matched by meaning", vars: [] },
  { id: P.whyVectorScore, group: RECALL, label: "Why: a vector match, with its score", note: "As above, where Lumiverse gives the score.", text: "matched by meaning, score {{score}}", vars: [v("score", "the score, as Lumiverse gives it", true)] },
  { id: P.whyConstant, group: RECALL, label: "Why: always sent", note: "How an entry got into the prompt: its book sends it every time.", text: "always sent", vars: [] },
  { id: P.whyUnknown, group: RECALL, label: "Why: unknown", note: "How an entry got into the prompt, where Lumiverse says nothing of it.", text: "activated by Lumiverse", vars: [] },
  { id: P.whereMessage, group: RECALL, label: "Where: a message of its own", note: "Which message of the request holds an entry.", text: "message [{{n}}]", vars: [v("n", "the message's number in the request", true)] },
  { id: P.whereInside, group: RECALL, label: "Where: inside a message", note: "As above, for an entry a preset's macro put inside a block.", text: "inside message [{{n}}]", vars: [v("n", "the message's number in the request", true)] },
  {
    id: P.index,
    group: RECALL,
    label: "Lore not in the prompt",
    note: "The second note: the other entries of the chat's books, the best match for the latest messages first.",
    text: `Lore not in the prompt ({{count}}; the best match for the latest messages first). The writer doesn't have these.{{add}}
{{entries}}`,
    vars: [v("count", 'how many entries, with the word: "112 entries"'), v("add", "how to give one to the writer, in the words below; nothing where it can't be done"), v("entries", "each entry, as An entry not in the prompt writes it", true)]
  },
  { id: P.indexLine, group: RECALL, label: "An entry not in the prompt", note: "One entry in Lore not in the prompt.", text: "- [{{id}}] {{title}}{{off}} \xB7 keys: {{keys}} \xB7 {{chars}} characters", vars: [v("id", "the entry's id, as the lore tools take it", true), v("title", "its title"), v("off", "that it is switched off, in the words below; nothing when it is on"), v("keys", "its keys, or the text for nothing"), v("chars", "its length")] },
  { id: P.indexOff, group: RECALL, label: "An entry not in the prompt: switched off", note: "Marks an entry the user switched off, where Settings list those too.", text: " (switched off)", vars: [] },
  { id: P.indexMore, group: RECALL, label: "More entries not in the prompt", note: "Ends Lore not in the prompt when not every entry fits its length.", text: "(and {{count}} more: lore_index lists them all, lore_search and lore_about find among them)", vars: [v("count", "how many more", true)] },
  { id: P.indexAdd, group: RECALL, label: "How to give the writer an entry", note: "Fills {{add}} where the main agent briefs a writer and Settings let it add entries.", text: " To give the writer one whole, name its id in write_reply's add; lore_read reads it first if you need to.", vars: [] },
  {
    id: P.history,
    group: RECALL,
    label: "History in the prompt",
    note: "The third note: which of the chat's messages the request holds word for word, which it doesn't, and what stands in for those.",
    text: "History in the prompt: the request holds chat messages {{held}} word for word ({{count}} of {{total}}). {{missing}}",
    vars: [v("held", "the messages it holds, as runs of message numbers", true), v("count", "how many that is"), v("total", 'how many messages the chat has, with the word: "840 messages"'), v("missing", "the messages it doesn't hold and what stands in for them, in the words below", true)]
  },
  { id: P.historyNone, group: RECALL, label: "No history in the prompt", note: "Stands for History in the prompt when no message of the request could be traced to the chat.", text: "History in the prompt: no message of the request is marked as one of this chat's {{total}}, so which of them it holds can't be told. The chat tools reach every one.", vars: [v("total", 'how many messages the chat has, with the word: "840 messages"')] },
  { id: P.historyAll, group: RECALL, label: "History: the whole chat", note: "Fills {{missing}} when the request holds every message.", text: "That is the whole chat.", vars: [] },
  { id: P.historyMissing, group: RECALL, label: "History: what it doesn't hold", note: "Fills {{missing}} when the request leaves messages out.", text: "It doesn't hold {{missing}}. {{stands}}", vars: [v("missing", "the messages it doesn't hold, as runs of message numbers", true), v("stands", "what stands in for them, in the words below")] },
  { id: P.stands, group: RECALL, label: "History: what stands in", note: "Fills {{stands}} when something in the request stands in for the messages it doesn't hold.", text: "Standing in for them: {{stands}}. A summary is somebody's reading: chat_outline, chat_about and chat_search reach the messages themselves.", vars: [v("stands", "each thing that stands in, named", true)] },
  { id: P.standNone, group: RECALL, label: "History: nothing stands in", note: "Fills {{stands}} when nothing does.", text: "Nothing in the request stands in for them: chat_outline, chat_about and chat_search reach them.", vars: [] },
  { id: P.stand.book, group: RECALL, label: "Standing in: the chat's book", note: "Names the chat's LumiBooks book as what stands in.", text: "the chat's book ({{name}}; book_outline lists it)", vars: [v("name", "the book's maker", true)] },
  { id: P.stand.summary, group: RECALL, label: "Standing in: a summary block", note: "Names a preset block that carries Lumiverse's summary.", text: "the preset block \u201C{{name}}\u201D (a summary)", vars: [v("name", "the block's name in the preset", true)] },
  { id: P.stand.memories, group: RECALL, label: "Standing in: a memories block", note: "Names a preset block that carries Lumiverse's memories.", text: "the preset block \u201C{{name}}\u201D (Lumiverse's memories)", vars: [v("name", "the block's name in the preset", true)] },
  { id: W.unknown, group: RECALL, label: "Not added or dropped: no such entry", note: "Why write_reply left an entry alone: the id names no entry of the chat's books.", text: "no lore entry goes by that id", vars: [] },
  { id: W.ambiguous, group: RECALL, label: "Not added or dropped: several entries", note: "As above: the id names several entries.", text: "it names several entries ({{entries}}): give more of the id", vars: [v("entries", "the entries it names, by id and title", true)] },
  { id: W.held, group: RECALL, label: "Not added: already in the prompt", note: "Why write_reply didn't add an entry.", text: "it is in the prompt already", vars: [] },
  { id: W.notHeld, group: RECALL, label: "Not dropped: not in the prompt", note: "Why write_reply didn't drop an entry.", text: "it isn't in the prompt, so there is nothing to take out", vars: [] },
  { id: W.unseen, group: RECALL, label: "Not dropped: activated, but not in the request", note: "Why write_reply didn't drop an entry Lumiverse activated whose text the request doesn't show.", text: "Lumiverse activated it, but the request doesn't show its text, so there is nothing to take out", vars: [] },
  { id: W.off, group: RECALL, label: "Not added: switched off", note: "Why write_reply didn't add an entry the user switched off in its book.", text: "it is switched off in its book", vars: [] },
  { id: W.empty, group: RECALL, label: "Not added: no text", note: "Why write_reply didn't add an entry that holds no text.", text: "it has no text", vars: [] },
  { id: W.inline, group: RECALL, label: "Not dropped: inside a block", note: "Why write_reply didn't drop an entry a preset's macro put inside a block with other text.", text: "its text sits inside message [{{n}}] with other text and couldn't be told apart from it", vars: [v("n", "the message's number in the request", true)] },
  { id: W.capEntries, group: RECALL, label: "Not added: past the entries a reply may add", note: "Why write_reply didn't add an entry.", text: "a reply may add {{limit}} at most (Entries added per reply)", vars: [v("limit", 'the limit, with the word: "8 entries"', true)] },
  { id: W.capChars, group: RECALL, label: "Not added: past the text a reply may add", note: "Why write_reply didn't add an entry.", text: "with it the added text would pass {{limit}} characters (Text added per reply)", vars: [v("limit", "the limit", true)] },
  { id: W.addOff, group: RECALL, label: "Not added: Settings", note: "Why write_reply didn't add an entry while Settings don't let the main agent add any.", text: "Settings don't let you add entries (Add entries)", vars: [] },
  { id: W.dropOff, group: RECALL, label: "Not dropped: Settings", note: "Why write_reply didn't drop an entry while Settings don't let the main agent drop any.", text: "Settings don't let you drop entries (Drop entries)", vars: [] },
  { id: W.twice, group: RECALL, label: "Named to add and to drop", note: "Why write_reply left alone an entry named both to add and to drop.", text: "it is named both to add and to drop", vars: [] },
  { id: W.unread, group: RECALL, label: "Not added or dropped: the lore couldn't be read", note: "Why write_reply left an entry alone: the chat's world books couldn't be read when it was called.", text: "the lore couldn't be read ({{error}})", vars: [v("error", "why not, in Lumiverse's words", true)] },
  { id: A.loreSearchNothing, group: ANSWERS4, label: "lore_search: nothing found", note: "lore_search's answer for a query no entry matches, with what to try next.", text: "No lore entry matches \u201C{{query}}\u201D. Try fewer or other words, lore_about for a name, or lore_index to see what the books hold.", vars: [v("query", "what was looked for", true)] },
  { id: A.loreGrepNothing, group: ANSWERS4, label: "lore_grep: nothing found", note: "lore_grep's answer when no line holds the text, with what to try next.", text: "No line of the lore holds \u201C{{query}}\u201D. Try a shorter piece of it, or lore_search for the words in any order.", vars: [v("query", "what was looked for", true)] },
  { id: A.loreBook, group: ANSWERS4, label: "lore_index: a book", note: "A book's heading in lore_index's answer.", text: "Book \u201C{{name}}\u201D [{{id}}], {{count}}{{description}}:", vars: [v("name", "the book's name", true), v("id", "the book's id"), v("count", 'how many entries it has, with the word: "12 entries"'), v("description", "its description, after a dash; nothing when it has none")] },
  { id: A.loreEntry, group: ANSWERS4, label: "lore_index: an entry", note: "One entry in lore_index's answer, and in lore_about's.", text: "- [{{id}}] {{title}}{{flags}} \xB7 keys: {{keys}} \xB7 {{chars}} characters", vars: [v("id", "the entry's id, as lore_read takes it", true), v("title", "its title"), v("flags", "how it stands: in the prompt, always sent, switched off, in the words for each"), v("keys", "its keys, or the text for nothing"), v("chars", "its length")] },
  {
    id: A.loreHit,
    group: ANSWERS4,
    label: "lore_search: a hit",
    note: "One entry lore_search found.",
    text: `- [{{id}}] {{title}}{{flags}} \xB7 book \u201C{{book}}\u201D \xB7 {{chars}} characters \xB7 {{why}}
{{lines}}`,
    vars: [v("id", "the entry's id, as lore_read takes it", true), v("title", "its title"), v("flags", "how it stands"), v("book", "its book's name"), v("chars", "its length"), v("why", "how it matched, in the words below"), v("lines", "its best lines, each as A hit's line writes it"), v("excerpt", "its best line alone")]
  },
  { id: A.loreLine, group: ANSWERS4, label: "lore_grep: a line", note: "One line lore_grep found.", text: "- [{{id}}] {{title}}, line {{line}}: {{text}}", vars: [v("id", "the entry's id, as lore_read takes it", true), v("title", "its title"), v("line", "the line's number in the entry"), v("text", "the line, around what was found", true)] },
  { id: A.loreRead, group: ANSWERS4, label: "lore_read: an entry", note: "One entry in lore_read's answer, or the part of it a page holds.", text: `[{{id}}] {{title}}{{flags}} (book \u201C{{book}}\u201D) \xB7 keys: {{keys}} \xB7 characters {{from}} to {{to}} of {{chars}}:
{{text}}`, vars: [v("id", "the entry's id", true), v("title", "its title"), v("flags", "how it stands"), v("book", "its book's name"), v("keys", "its keys, or the text for nothing"), v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "the entry's length"), v("text", "the text", true)] },
  { id: A.loreNoEntry, group: ANSWERS4, label: "No such lore entry", note: "A lore tool's answer to an id no entry has.", text: "There is no lore entry {{id}} in the books that apply to this chat. Take an id from the request's index, lore_index or a lore search, written as it gives it.", vars: [v("id", "the id asked for", true)] },
  { id: A.loreNoBook, group: ANSWERS4, label: "No such world book", note: "A lore tool's answer to a book that isn't among those that apply.", text: "No book \u201C{{book}}\u201D applies to this chat. The books are: {{books}}. Give one of those, or leave book out for them all.", vars: [v("book", "the book asked for", true), v("books", "the books that apply, by name and id")] },
  { id: A.loreNoBooks, group: ANSWERS4, label: "No world books", note: "A lore tool's answer when no world book applies to the chat.", text: "No world book applies to this chat, so there is no lore to read here. Work from the request.", vars: [] },
  { id: A.loreAmbiguous, group: ANSWERS4, label: "An id that names several entries", note: "A lore tool's answer to an id several entries start with.", text: "{{id}} names several entries: {{entries}}. Give more of the id.", vars: [v("id", "the id asked for", true), v("entries", "the entries it names, by id and title")] },
  { id: A.activeEntry, group: ANSWERS4, label: "active_lore: an entry", note: "One entry in active_lore's answer.", text: "- [{{id}}] {{title}} (book \u201C{{book}}\u201D, {{chars}} characters): {{excerpt}}", vars: [v("id", "the entry's id, as lore_read takes it", true), v("title", "its title"), v("book", "its book's name"), v("chars", "the length of the text Lumiverse put in the prompt"), v("excerpt", "the start of that text")] },
  { id: A.activeNone, group: ANSWERS4, label: "active_lore: none", note: "active_lore's answer when Lumiverse activated no entry.", text: "Lumiverse activated no lore entry for this reply. lore_search and lore_index reach the books that apply.", vars: [] },
  { id: A.activeUnseen, group: ANSWERS4, label: "active_lore: activated, but not in the request", note: "Leads active_lore's answer where Lumiverse says it activated entries whose text the request doesn't show.", text: "[Activated by Lumiverse, but their text is not in the request, so the writer doesn't have them: {{entries}}.]", vars: [v("entries", "those entries, by id and title", true)] },
  { id: A.queryHead, group: ANSWERS4, label: "A query's heading", note: "Heads each query's part of a search's answer: how many it found and which of them are shown.", text: "\u201C{{query}}\u201D: {{total}} found; showing {{from}} to {{to}}.", vars: [v("query", "the query", true), v("total", 'how many it found, with the word: "37 entries"', true), v("from", "the first shown, counted from 1"), v("to", "the last shown")] },
  { id: A.queryMore, group: ANSWERS4, label: "A query has more", note: "Ends a query's part when a call of several queries shows only its best.", text: "({{count}} more: call {{tool}} with this query alone to page through them.)", vars: [v("count", "how many more", true), v("tool", "the tool")] },
  { id: A.hitLine, group: ANSWERS4, label: "A hit's line", note: "One of a search hit's best lines.", text: "    line {{line}}: {{text}}", vars: [v("line", "the line's number in the entry or the message"), v("text", "the line", true)] },
  { id: A.hitAbove, group: ANSWERS4, label: "A hit listed above", note: "A hit another query of the same call already showed.", text: "- {{name}}: listed above", vars: [v("name", "the entry's id and title, or the message's citation", true)] },
  { id: A.byWords, group: ANSWERS4, label: "Matched by words", note: "How a hit matched: which of the query's words it holds, and where.", text: "matched {{fields}}: {{words}}", vars: [v("fields", "where: title, key, text"), v("words", "the query's words it holds", true)] },
  { id: A.byMeaning, group: ANSWERS4, label: "Matched by meaning", note: "How a hit matched, where it holds none of the query's words and was found by its meaning.", text: "matched by meaning ({{score}})", vars: [v("score", "how alike, from 0 to 1", true)] },
  { id: A.byBoth, group: ANSWERS4, label: "Matched by words and by meaning", note: "How a hit matched, where both found it.", text: "{{words}}; also by meaning ({{score}})", vars: [v("words", "how it matched by words, as Matched by words writes it", true), v("score", "how alike, from 0 to 1")] },
  { id: A.fieldTitle, group: ANSWERS4, label: "Where a word matched: the title", note: "Names an entry's title in Matched by words.", text: "title", vars: [] },
  { id: A.fieldKey, group: ANSWERS4, label: "Where a word matched: the keys", note: "Names an entry's keys in Matched by words.", text: "keys", vars: [] },
  { id: A.fieldText, group: ANSWERS4, label: "Where a word matched: the text", note: "Names an entry's or a message's text in Matched by words.", text: "text", vars: [] },
  { id: A.wordOnly, group: ANSWERS4, label: "Search is by word only", note: "Ends the first search answer of a run where no embedding connection is set up in Lumiverse.", text: "[Search is by word here: no embedding connection is set up in Lumiverse, so words that mean the same aren't found. Search with the story's own words.]", vars: [] },
  { id: A.badPattern, group: ANSWERS4, label: "A pattern that can't be used", note: "A grep's answer to a regular expression it won't run.", text: "\u201C{{pattern}}\u201D can't be used as a pattern: {{why}}. Give plain text without regex, or a simpler expression.", vars: [v("pattern", "the pattern given", true), v("why", "why not, in the engine's words or the texts below")] },
  { id: A.patternNested, group: ANSWERS4, label: "A pattern refused: a repeat of a group", note: "Fills {{why}}: a repeated group can take very long to match on some text, so a repeat may follow one character or class only.", text: "it repeats a group, which can take very long to match: put a repeat (*, +, {n,m}) after one character or one class only, as in [a-z]+ or \\d{2,4}, and write alternatives without a repeat around them", vars: [] },
  { id: A.patternBack, group: ANSWERS4, label: "A pattern refused: looking back", note: "Fills {{why}}: back-references and look-behind are refused for the same reason.", text: "it uses a back-reference or a look-behind, which can take very long to match", vars: [] },
  { id: A.patternMany, group: ANSWERS4, label: "A pattern refused: too many ways to match", note: "Fills {{why}}: more than one repeat without bound in one alternative, or more optional and bounded parts than a piece of a line can be matched against in bounded time.", text: "it can match in too many ways, which can take very long: keep one repeat without bound (*, +, {n,}) in each alternative, and fewer optional (?) and bounded ({n,m}) parts", vars: [] },
  { id: A.patternLong, group: ANSWERS4, label: "A pattern refused: too long", note: "Fills {{why}}: a pattern longer than Line length.", text: "it is longer than {{limit}} characters (Line length)", vars: [v("limit", "Line length", true)] },
  { id: A.grepLate, group: ANSWERS4, label: "A search that ran out of time", note: "chat_grep's and lore_grep's answer when a search took longer than Time for one search: it was stopped, and nothing it had found is shown.", text: "The search was stopped: it took longer than {{ms}} ms (Time for one search) and had gone through {{searched}} of {{total}}. Narrow it to fewer of them, give plain text instead of a pattern, or a simpler pattern.", vars: [v("ms", "Time for one search", true), v("searched", "how many it had gone through"), v("total", 'how many there were to search, with the word: "5000 messages"')] },
  { id: A.badFilter, group: ANSWERS4, label: "A filter that isn't one", note: "A tool's answer to a filter value it doesn't have.", text: "{{tool}}'s {{arg}} can be: {{values}}. \u201C{{given}}\u201D is none of those.", vars: [v("tool", "the tool"), v("arg", "the argument", true), v("values", "what it can be"), v("given", "what was given")] },
  { id: A.tooMany, group: ANSWERS4, label: "Too many in one call", note: "Follows an answer to a call that named more queries or ids than one call may carry.", text: "[One call carries {{limit}} at most; the rest weren't run: {{rest}}. Call again with those.]", vars: [v("limit", "the limit", true), v("rest", "what wasn't run")] },
  { id: A.loreIndexNothing, group: ANSWERS4, label: "lore_index: nothing matches the filter", note: "lore_index's answer when no entry passes its filters.", text: "No entry of this chat's books matches {{filter}}. Leave a filter out to see more.", vars: [v("filter", "the filters given", true)] },
  { id: A.loreMissing, group: ANSWERS4, label: "lore_read: ids that name nothing", note: "Leads lore_read's answer when some of the ids named no entry: the rest are read.", text: "[Not read: {{ids}}.]", vars: [v("ids", "each id with why it wasn't read", true)] },
  {
    id: A.loreRelated,
    group: ANSWERS4,
    label: "lore_related: its answer",
    note: "lore_related's answer: the entry, the entries it mentions and the entries that mention it.",
    text: `[{{id}}] {{title}}{{flags}} (book \u201C{{book}}\u201D, {{chars}} characters).
It mentions {{out}}:
{{outLines}}
Mentioned by {{in}}:
{{inLines}}`,
    vars: [v("id", "the entry's id", true), v("title", "its title"), v("flags", "how it stands"), v("book", "its book's name"), v("chars", "its length"), v("out", 'how many entries its text mentions, with the word: "3 entries"'), v("outLines", "those entries, each as A linked entry writes it", true), v("in", "how many entries mention it"), v("inLines", "those entries", true)]
  },
  { id: A.loreLink, group: ANSWERS4, label: "A linked entry", note: "One entry in lore_related's and lore_about's answers, with the line that makes the link.", text: "- [{{id}}] {{title}}{{flags}} \xB7 {{chars}} characters \xB7 \u201C{{by}}\u201D, line {{line}}: {{text}}", vars: [v("id", "the entry's id", true), v("title", "its title"), v("flags", "how it stands"), v("chars", "its length"), v("by", "the name the link was found by"), v("line", "the line's number in the text that holds the name"), v("text", "that line, around the name")] },
  { id: A.loreLinksMore, group: ANSWERS4, label: "More linked entries", note: "Ends a list of linked entries longer than Linked entries listed.", text: "(and {{count}} more: lore_grep finds every line that holds the name)", vars: [v("count", "how many more", true)] },
  {
    id: A.loreAbout,
    group: ANSWERS4,
    label: "lore_about: its answer",
    note: "lore_about's answer: the entries titled or keyed with the name, then those that mention it.",
    text: `\u201C{{name}}\u201D in the lore.
Titled or keyed with it ({{own}}):
{{ownLines}}
Mentioning it ({{others}}):
{{otherLines}}`,
    vars: [v("name", "the name asked for", true), v("own", 'how many entries are titled or keyed with it, with the word: "2 entries"'), v("ownLines", "those entries, each as lore_index writes an entry", true), v("others", "how many entries mention it"), v("otherLines", "those entries, each as A linked entry writes it", true)]
  },
  { id: A.loreAboutNothing, group: ANSWERS4, label: "lore_about: nothing", note: "lore_about's answer when no entry is titled or keyed with the name and none mentions it.", text: "The lore holds nothing on \u201C{{name}}\u201D as written: no entry is titled or keyed with it, and none mentions it. lore_search finds by words in any order; chat_about traces a name through the chat.", vars: [v("name", "the name asked for", true)] },
  { id: A.chatSearchNothing, group: ANSWERS4, label: "chat_search: nothing found", note: "chat_search's answer for a query no message matches, with what to try next.", text: "No message of this chat matches \u201C{{query}}\u201D. Try fewer or other words (names and rare words find the most), chat_about for a name, or chat_grep for an exact phrase.", vars: [v("query", "what was looked for", true)] },
  { id: A.chatGrepNothing, group: ANSWERS4, label: "chat_grep: nothing found", note: "chat_grep's answer when no line holds the text, with what to try next.", text: "No line of this chat holds \u201C{{query}}\u201D. Try a shorter piece of it, or chat_search for the words in any order.", vars: [v("query", "what was looked for", true)] },
  { id: A.chatSearchHead, group: ANSWERS4, label: "chat_search: a query's heading", note: "Heads each query's part of chat_search's answer.", text: "\u201C{{query}}\u201D: {{messages}} in {{stretches}}; showing stretches {{from}} to {{to}}, the best first.", vars: [v("query", "the query", true), v("messages", 'how many messages it found, with the word: "14 messages"', true), v("stretches", 'in how many stretches of the chat, with the word: "5 stretches"'), v("from", "the first stretch shown, counted from 1"), v("to", "the last stretch shown")] },
  { id: A.chatStretch, group: ANSWERS4, label: "chat_search: a stretch", note: "Heads the hits of one stretch of the chat.", text: "{{span}}{{when}} \xB7 {{hits}}:", vars: [v("span", "the messages the stretch's hits reach from and to", true), WHEN, v("hits", 'how many hits it holds, with the word: "5 hits"')] },
  { id: A.chatStretchMore, group: ANSWERS4, label: "chat_search: more hits in a stretch", note: "Ends a stretch that holds more hits than Hits per stretch.", text: "  and {{count}} more here: {{messages}}", vars: [v("count", "how many more", true), v("messages", "their message numbers")] },
  {
    id: A.chatHit,
    group: ANSWERS4,
    label: "chat_search: a hit",
    note: "One message chat_search found.",
    text: `- {{cite}} {{who}}, {{chars}} characters{{why}}
{{lines}}`,
    vars: [CITE, v("index", "the message's number"), v("who", "who wrote it"), v("chars", "the message's length"), v("why", "that it was found by its meaning, after a dot; nothing for a match by words"), v("lines", "its best lines, each as A hit's line writes it"), v("excerpt", "its best line alone")]
  },
  { id: A.chatLine, group: ANSWERS4, label: "chat_grep: a line", note: "One line chat_grep found.", text: "- {{cite}} {{who}}, line {{line}}: {{text}}", vars: [CITE, v("index", "the message's number"), v("who", "who wrote it"), v("line", "the line's number in the message"), v("text", "the line, around what was found", true)] },
  { id: A.chatMessage, group: ANSWERS4, label: "A message read", note: "One message, or the part of one a page holds, in chat_read's and chat_around's answers.", text: `{{cite}} {{who}}{{when}}, characters {{from}} to {{to}} of {{chars}}:
{{text}}`, vars: [CITE, v("index", "the message's number"), v("who", "who wrote it"), WHEN, v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "the message's length"), v("text", "the text", true)] },
  { id: A.chatRead, group: ANSWERS4, label: "chat_read: its answer", note: "Heads chat_read's and chat_around's answers.", text: "Chat messages #{{from}} to #{{to}} ({{count}} asked for):", vars: [v("from", "the first message asked for"), v("to", "the last message asked for"), v("count", "how many that is")] },
  { id: A.chatNoMessage, group: ANSWERS4, label: "No such message", note: "A chat tool's answer to a number the chat doesn't have.", text: "There is no chat message #{{index}}: this turn reads messages #{{first}} to #{{last}}. Give a number in that range.", vars: [v("index", "the number asked for", true), v("first", "the first message's number"), v("last", "the last message's number")] },
  { id: A.chatEmpty, group: ANSWERS4, label: "The chat is empty", note: "A chat tool's answer when the chat has no message before this reply.", text: "This chat has no messages before this reply, so there is nothing to read here. Work from the request.", vars: [] },
  { id: A.chatNoStory, group: ANSWERS4, label: "No message is part of the story", note: "A chat tool's answer when the chat has messages before this reply and What counts as the story leaves out every one of them.", text: `{{left}}
No message of this chat before this reply is part of the story, so there is nothing to read here. Work from the request.`, vars: [v("left", "how many messages are left out and why, as Messages left out says it", true)] },
  { id: A.chatLeftOut, group: ANSWERS4, label: "Messages left out", note: "One line of a chat tool's answer where messages in what it covers are left out of the story (What counts as the story), so the agent doesn't take their numbers for gaps.", text: "[Left out here, as not part of the story: {{parts}}.]", vars: [v("parts", "how many, and why, in the words below, joined by and", true)] },
  { id: A.chatLeftHidden, group: ANSWERS4, label: "Messages left out: hidden", note: "Fills {{parts}} in Messages left out with those the user hid from the prompt.", text: "{{count}} the user hid from the prompt", vars: [v("count", 'how many, with the word: "3 messages"', true)] },
  { id: A.chatLeftDirections, group: ANSWERS4, label: "Messages left out: the user's", note: "Fills {{parts}} in Messages left out with the user's own messages, where only the model's replies are the story.", text: "{{count}} by the user, which direct the story from outside it", vars: [v("count", 'how many, with the word: "12 messages"', true)] },
  { id: A.chatLeftOne, group: ANSWERS4, label: "A message left out", note: "A chat tool's answer to a message, named by number or citation, that is left out of the story.", text: "Chat message #{{index}} isn't part of the story here: {{why}}. No chat tool reads it.", vars: [v("index", "the number asked for", true), v("why", "why, in the words below", true)] },
  { id: A.chatLeftOneHidden, group: ANSWERS4, label: "A message left out: hidden", note: "Fills {{why}} in A message left out when the user hid it from the prompt.", text: "the user hid it from the prompt", vars: [] },
  { id: A.chatLeftOneDirection, group: ANSWERS4, label: "A message left out: the user's", note: "Fills {{why}} in A message left out when it is the user's own and only the model's replies are the story.", text: "it is the user's, a direction from outside the story", vars: [] },
  { id: A.chatAllLeftOut, group: ANSWERS4, label: "A range left out whole", note: "chat_read's answer when every message from its first to its last is left out of the story.", text: `{{left}}
No message from #{{from}} to #{{to}} is part of the story.`, vars: [v("left", "how many messages are left out and why, as Messages left out says it", true), v("from", "the first message asked for"), v("to", "the last message asked for")] },
  { id: A.chatNoSpeaker, group: ANSWERS4, label: "No such speaker", note: "A chat tool's answer to a speaker nobody in the chat goes by.", text: "Nobody in this chat speaks as \u201C{{speaker}}\u201D. Its speakers are: {{speakers}}. Give one of those, or user or assistant.", vars: [v("speaker", "the speaker asked for", true), v("speakers", "who speaks in the chat, each with how many messages")] },
  { id: A.chatBadRange, group: ANSWERS4, label: "A range that holds no message", note: "A chat tool's answer to from and to that leave no message between them.", text: "No message lies between #{{from}} and #{{to}}: this turn reads messages #{{first}} to #{{last}}.", vars: [v("from", "from, as given", true), v("to", "to, as given", true), v("first", "the first message's number"), v("last", "the last message's number")] },
  { id: A.chatNotNamed, group: ANSWERS4, label: "A message that isn't named", note: "A chat tool's answer to a message argument that is neither a number nor a citation.", text: "\u201C{{given}}\u201D names no message. Give its number (412) or its citation ([#412 a3f9c27e]).", vars: [v("given", "what was given", true)] },
  { id: A.chatCiteChanged, group: ANSWERS4, label: "A citation the message at its number doesn't read as", note: "Leads a read by a citation where the chat has a message at the cited number and it doesn't read as cited. It says what was compared: LumiAH keeps no record of a chat changing, so it never says that one did.", text: "[{{given}} doesn't hold: message #{{index}} doesn't read as cited, {{where}}. It is read as it stands ({{cite}}); what rested on the cited text has to be checked again.]", vars: [v("given", "the citation given", true), v("index", "the message's number"), v("where", "whether another message reads as cited, in the words of chronicle_check: no message reads as cited, and: several messages read as cited"), v("cite", "the citation of the message as it stands")] },
  { id: A.chatCiteMoved, group: ANSWERS4, label: "A citation with a wrong number", note: "Leads a read by a citation whose hash is that of exactly one other message: the number was written wrong, and that message is read.", text: "[{{given}}: message #{{index}} doesn't read as cited, and exactly one message of the chat does: #{{now}} ({{cite}}), which is read here.]", vars: [v("given", "the citation given", true), v("index", "the number it cites"), v("now", "the number of the message that reads as cited"), v("cite", "that message's citation")] },
  { id: A.chatCiteGone, group: ANSWERS4, label: "A citation of a number the chat doesn't have", note: "A read by a citation where the chat has no message at the cited number and no single other message reads as cited.", text: "{{given}} doesn't hold: the chat has no message #{{index}}, {{where}}. This turn reads messages #{{first}} to #{{last}}.", vars: [v("given", "the citation given", true), v("index", "the number it cites"), v("where", "whether another message reads as cited, in the words of chronicle_check"), v("first", "the first message's number"), v("last", "the last message's number")] },
  {
    id: A.chatAbout,
    group: ANSWERS4,
    label: "chat_about: a trail",
    note: "chat_about's answer for one name: how often and where it appears, its first and latest mention, and its most telling lines.",
    text: `\u201C{{name}}\u201D: {{mentions}} in {{messages}}, {{span}}.
First: {{first}}
Latest: {{latest}}
Most telling lines between them, in order:
{{lines}}
[chat_around reads around a line; chat_search with from and to searches one part of the trail.]`,
    vars: [v("name", "the name traced", true), v("mentions", 'how often it appears, with the word: "23 mentions"'), v("messages", 'in how many messages, with the word: "17 messages"'), v("span", "from which message to which"), v("first", "its first mention, as A trail's line writes it", true), v("latest", "its latest mention", true), v("lines", "its most telling lines between the two, each as A trail's line writes it; the text for nothing when there are none")]
  },
  { id: A.chatAboutOnce, group: ANSWERS4, label: "chat_about: a name that appears once", note: "chat_about's answer for a name one message holds.", text: `\u201C{{name}}\u201D appears in one message ({{mentions}}):
{{line}}`, vars: [v("name", "the name traced", true), v("mentions", 'how often it appears there, with the word: "2 mentions"'), v("line", "the mention, as A trail's line writes it", true)] },
  { id: A.chatAboutNothing, group: ANSWERS4, label: "chat_about: no mention", note: "chat_about's answer for a name no message holds as written.", text: "No message of this chat holds \u201C{{name}}\u201D as written.{{near}}", vars: [v("name", "the name traced", true), v("near", "the closest messages by its words, in the words below; nothing where there are none")] },
  { id: A.chatAboutNear, group: ANSWERS4, label: "chat_about: the closest by words", note: "Fills {{near}} with the messages that hold the name's words apart.", text: ` The closest by its words:
{{lines}}`, vars: [v("lines", "the closest messages, each as A trail's line writes it", true)] },
  { id: A.trailLine, group: ANSWERS4, label: "A trail's line", note: "One mention in chat_about's answer: the message and the line that holds the name.", text: "- {{cite}} {{who}}{{when}}: {{text}}", vars: [CITE, v("who", "who wrote it"), WHEN, v("text", "the line that holds the name", true)] },
  {
    id: A.outline,
    group: ANSWERS4,
    label: "chat_outline: its answer",
    note: "Heads chat_outline's answer: where the outline comes from and what it covers.",
    text: "{{source}} Messages {{span}} ({{count}}) in {{parts}}:",
    vars: [v("source", "where the outline comes from, in the words below", true), v("span", "the messages outlined"), v("count", 'how many messages that is, with the word: "840 messages"'), v("parts", 'how many parts it lists, with the word: "9 parts"')]
  },
  { id: A.outlineBook, group: ANSWERS4, label: "chat_outline: from the book", note: "Fills {{source}} where the chat has a book.", text: "The story's outline, from the chat's book; messages no chapter covers are outlined from the chat itself.", vars: [] },
  { id: A.outlineArcs, group: ANSWERS4, label: "chat_outline: from Lumiverse's memory", note: "Fills {{source}} where the chat has no book and Lumiverse's memory has arcs of it.", text: "The story's outline, from the arcs of Lumiverse's memory; messages no arc covers are outlined from the chat itself.", vars: [] },
  { id: A.outlineSkeleton, group: ANSWERS4, label: "chat_outline: from the chat itself", note: "Fills {{source}} where the chat has neither a book nor arcs.", text: "The story's outline, worked out from the chat itself (it has no book and no arcs): a part ends at a long gap in time, or when it is long enough.", vars: [] },
  { id: A.outlineNode, group: ANSWERS4, label: "chat_outline: a part with a summary", note: "One part of the outline that a book entry or an arc sums up.", text: "- {{span}}{{when}} \xB7 {{messages}} \xB7 {{kind}}: {{title}}{{read}}", vars: [v("span", "the messages the part spans", true), WHEN, v("messages", 'how many messages it spans, with the word: "40 messages"'), v("kind", "what it is: a chapter, an arc, a volume, a scene"), v("title", "its title, or how its summary opens"), v("read", "how to read its summary, in the words below")] },
  { id: A.outlineNodeBook, group: ANSWERS4, label: "chat_outline: reading a part's summary in the book", note: "Fills {{read}} for a part the book sums up.", text: " \xB7 book_read {{id}}", vars: [v("id", "the entry's id, as book_read takes it", true)] },
  { id: A.outlineNodeArc, group: ANSWERS4, label: "chat_outline: an arc's summary", note: "Fills {{read}} for a part an arc of Lumiverse's memory sums up.", text: " \xB7 {{summary}}", vars: [v("summary", "how the arc's summary opens", true)] },
  { id: A.outlinePart, group: ANSWERS4, label: "chat_outline: a part worked out from the chat", note: "One part of the outline that code made from the messages themselves.", text: "- {{span}}{{when}} \xB7 {{messages}}, {{chars}} characters \xB7 {{who}} \xB7 opens: {{opening}}", vars: [v("span", "the messages the part spans", true), WHEN, v("messages", 'how many messages it holds, with the word: "40 messages"'), v("chars", "their length together"), v("who", "who speaks in it, each with how many messages"), v("opening", "how its first message opens")] },
  { id: A.outlineNext, group: ANSWERS4, label: "chat_outline: what to call next", note: "Ends chat_outline's answer.", text: "[Give from and to of a part to open it into its smaller parts. chat_read reads its messages; chat_about traces a name through them.]", vars: [] },
  { id: A.outlineLeaf, group: ANSWERS4, label: "chat_outline: a part with nothing smaller", note: "Ends chat_outline's answer for a part that can't be opened further.", text: "[That part has no smaller parts: chat_read reads its messages.]", vars: [] },
  {
    id: A.outlineStretches,
    group: ANSWERS4,
    label: "chat_outline: the stretches' heading",
    note: "Heads chat_outline's answer to a call with stretches: how many stretches the messages were cut into, and the size none of them passes.",
    text: "{{count}} of at most {{messages}} or {{chars}} characters each:",
    vars: [v("count", 'how many stretches there are, with the word: "84 stretches"', true), v("messages", 'the most messages a stretch holds (Messages per reader), with the word: "60 messages"'), v("chars", "the most text a stretch holds (Text per reader)")]
  },
  { id: A.outlineStretch, group: ANSWERS4, label: "chat_outline: a stretch", note: "One stretch in chat_outline's answer to a call with stretches.", text: "- {{span}} \xB7 {{messages}}, {{chars}} characters", vars: [v("span", "the messages the stretch holds, from its first to its last", true), v("messages", 'how many messages that is, with the word: "60 messages"'), v("chars", "their length together")] },
  {
    id: A.chronicleCheck,
    group: ANSWERS4,
    label: "chronicle_check: its answer",
    note: "Heads chronicle_check's answer: each file, what the check corrected, what the outline leaves out, then what holds and what doesn't.",
    text: `The chronicle against the chat as it stands (messages #{{first}} to #{{last}}). A citation holds where the message at its number reads as cited: that shows the message is there and says what was cited, not that it supports the line.
{{files}}{{corrected}}{{gaps}}
{{verdict}}`,
    vars: [v("first", "the chat's first message's number"), v("last", "its last message's number"), v("files", "each file, as A file of the chronicle writes it", true), v("corrected", "what the check corrected, and what it couldn't, in the words below; nothing where no number was wrong"), v("gaps", "the messages no outline line covers, in the words below; nothing where one file alone was checked"), v("verdict", "that every citation holds, or how many problems follow", true)]
  },
  { id: A.chronicleFile, group: ANSWERS4, label: "chronicle_check: a file", note: "One file in chronicle_check's answer.", text: "- {{path}}: {{lines}}, {{cited}} cited, {{failed}} failed", vars: [v("path", "the file's path", true), v("lines", 'how many lines it has, with the word: "42 lines"'), v("cited", "how many of them cite a message"), v("failed", "how many of them fail the check")] },
  { id: A.chronicleOk, group: ANSWERS4, label: "chronicle_check: everything holds", note: "Fills {{verdict}} when no line has a problem.", text: "Every line cites a message, and every citation holds.", vars: [] },
  { id: A.chronicleProblems, group: ANSWERS4, label: "chronicle_check: problems follow", note: "Fills {{verdict}} when some lines fail. A line that fails is left out of what the main agent is given until it is fixed or removed.", text: "{{count}}. A line that fails is left out of what the main agent is given until you fix or remove it: read the message (chat_read, chat_around), then rewrite the line with the citation the tool prints, or delete it.", vars: [v("count", 'how many problems, with the word: "3 problems"', true)] },
  { id: A.chronicleFailure, group: ANSWERS4, label: "chronicle_check: a line whose citation doesn't hold", note: "One line with a citation that doesn't hold, and what was compared.", text: "- FAILED {{path}} line {{line}}, {{citation}}: {{at}}, {{where}}: {{text}}", vars: [v("path", "the file's path", true), v("line", "the line's number in the file", true), v("citation", "the citation that doesn't hold"), v("at", "what the chat has at the cited number, in the words below", true), v("where", "whether another message reads as cited, in the words below", true), v("text", "the line")] },
  { id: A.chronicleNotAsCited, group: ANSWERS4, label: "chronicle_check: the message there reads otherwise", note: "Fills {{at}}: the chat has a message at the cited number, and it doesn't read as cited.", text: "message #{{index}} doesn't read as cited", vars: [v("index", "the message number cited", true)] },
  { id: A.chronicleNoMessage, group: ANSWERS4, label: "chronicle_check: no message at that number", note: "Fills {{at}}: the chat has no message at the cited number.", text: "the chat has no message #{{index}}", vars: [v("index", "the message number cited", true)] },
  { id: A.chronicleNowhere, group: ANSWERS4, label: "chronicle_check: no message reads as cited", note: "Fills {{where}}, and says the same where a chat tool is given such a citation: no message of the chat has the cited hash.", text: "and no message of the chat reads as cited", vars: [] },
  { id: A.chronicleSeveral, group: ANSWERS4, label: "chronicle_check: several messages read as cited", note: "Fills {{where}}, and says the same where a chat tool is given such a citation: more than one message has the cited hash (two messages with the same text do), so none is taken for the one meant.", text: "and several messages read as cited ({{messages}}), so which was meant can't be told: cite the one you read by its own number", vars: [v("messages", "those messages' numbers", true)] },
  { id: A.chronicleUncited, group: ANSWERS4, label: "chronicle_check: a line that cites nothing", note: "One line of the chronicle that says something and has no citation: no check ever touched it, so it fails.", text: "- FAILED {{path}} line {{line}}, cites nothing: {{text}}", vars: [v("path", "the file's path", true), v("line", "the line's number in the file", true), v("text", "the line")] },
  { id: A.chronicleCorrected, group: ANSWERS4, label: "chronicle_check: numbers it corrected", note: "Fills {{corrected}}: the citations whose number was wrong, which the check has written right in the file. A number is wrong where the message at it doesn't read as cited and exactly one other message does.", text: `
Corrected in the files, {{count}} whose number was wrong (the cited text is that of exactly one other message, whose number is now written):
{{corrections}}`, vars: [v("count", 'how many citations, with the word: "3 citations"', true), v("corrections", "each one, as A corrected number writes it, as many as fit", true)] },
  { id: A.chronicleCorrection, group: ANSWERS4, label: "chronicle_check: a corrected number", note: "One citation in Numbers it corrected.", text: "- {{path}} line {{line}}: {{citation}} now cites #{{now}}", vars: [v("path", "the file's path", true), v("line", "the line's number in the file"), v("citation", "the citation as it was written", true), v("now", "the number written in its place", true)] },
  { id: A.chronicleCorrectedMore, group: ANSWERS4, label: "chronicle_check: more corrected numbers", note: "Ends Numbers it corrected where not every one fits the answer.", text: "(and {{count}} more, corrected the same way)", vars: [v("count", "how many more", true)] },
  { id: A.chronicleUncorrected, group: ANSWERS4, label: "chronicle_check: numbers it couldn't correct", note: "Fills {{corrected}} for a file whose wrong numbers the check couldn't write right. Their lines still pass: which message each means is not in doubt.", text: `
Not corrected in {{path}}, {{count}} whose number is wrong: {{why}}`, vars: [v("path", "the file's path", true), v("count", 'how many citations, with the word: "3 citations"'), v("why", "why not, in the words below or in those a refused write of a file gives", true)] },
  { id: A.chronicleStale, group: ANSWERS4, label: "chronicle_check: not corrected, the file changed", note: "Fills {{why}}: the file was written by someone else while it was checked.", text: "the file was written while it was checked; run chronicle_check again", vars: [] },
  { id: A.chronicleNoRoom, group: ANSWERS4, label: "chronicle_check: not corrected, a limit", note: "Fills {{why}}: with the numbers written right the file would pass a workspace limit.", text: "with the numbers written right the file would pass a workspace limit; shorten it, then run chronicle_check again", vars: [] },
  { id: A.chronicleGaps, group: ANSWERS4, label: "chronicle_check: messages the outline doesn't cover", note: "Fills {{gaps}}: the runs of chat messages no line of outline.md spans. They are what nobody has read into the chronicle.", text: `
No outline line covers {{count}}: {{runs}}.`, vars: [v("count", 'how many messages, with the word: "140 messages"', true), v("runs", "the runs of messages, as many as fit", true)] },
  { id: A.chronicleCovered, group: ANSWERS4, label: "chronicle_check: the outline covers the chat", note: "Fills {{gaps}} where every message lies in a span an outline line names.", text: `
The outline covers every message of the chat.`, vars: [] },
  { id: A.chronicleNone, group: ANSWERS4, label: "chronicle_check: no chronicle", note: "chronicle_check's answer when learned/chronicle/ holds no file.", text: "This chat has no chronicle yet: learned/chronicle/ holds no file. The skill {{skill}} says how one is kept.", vars: [v("skill", "the id of the skill that keeps the chronicle", true)] },
  { id: A.chronicleNoFile, group: ANSWERS4, label: "chronicle_check: no such file", note: "chronicle_check's answer to a path that is no file of the chronicle.", text: "{{path}} is no file of the chronicle. Its files are: {{files}}.", vars: [v("path", "the path asked for", true), v("files", "the chronicle's files")] },
  { id: A.memoryHead, group: ANSWERS4, label: "memory_search: a query's heading", note: "Heads each query's part of memory_search's answer.", text: "\u201C{{query}}\u201D: {{count}} from Lumiverse's memory, the best first.", vars: [v("query", "the query", true), v("count", 'how many it gave, with the word: "6 memories"', true)] },
  { id: A.memoryHit, group: ANSWERS4, label: "memory_search: a memory", note: "One thing Lumiverse's memory gave for a query.", text: "- {{source}}{{span}} \xB7 score {{score}}{{entities}}: {{text}}", vars: [v("source", "what it is: a chunk of the chat, or an arc", true), v("span", "the chat messages it was made from, after a space; nothing where that isn't known"), v("score", "its score, as the Cortex ranks it"), v("entities", "the entities it names, after a dot"), v("text", "its text", true)] },
  { id: A.memoryChunk, group: ANSWERS4, label: "A memory: a chunk of the chat", note: "Names a memory that is a chunk of the chat.", text: "chunk", vars: [] },
  { id: A.memoryArcSource, group: ANSWERS4, label: "A memory: an arc", note: "Names a memory that is one of the Cortex's arcs.", text: "arc", vars: [] },
  { id: A.memoryNothing, group: ANSWERS4, label: "memory_search: nothing", note: "memory_search's answer for a query Lumiverse's memory gave nothing for.", text: "Lumiverse's memory gave nothing for \u201C{{query}}\u201D. chat_search and chat_about search the messages themselves.", vars: [v("query", "the query", true)] },
  {
    id: A.memoryEntity,
    group: ANSWERS4,
    label: "memory_entity: an entity",
    note: "memory_entity's answer: what the Cortex has recorded of one entity.",
    text: `{{name}} ({{type}}, {{status}}){{aliases}} \xB7 {{mentions}}{{seen}}
{{description}}
Facts ({{facts}}):
{{factLines}}
Relations ({{relations}}):
{{relationLines}}`,
    vars: [v("name", "the entity's name", true), v("type", "what it is: character, location, item, faction, concept or event"), v("status", "how it stands: active, inactive, deceased, destroyed or unknown"), v("aliases", "its other names, after a dot"), v("mentions", 'how often the chat mentions it, with the word: "41 mentions"'), v("seen", "when it was last mentioned, after a dot"), v("description", "its description"), v("facts", "how many facts are shown, and of how many"), v("factLines", "its facts, one a line", true), v("relations", "how many relations are shown, and of how many"), v("relationLines", "its relations, each as A relation writes it", true)]
  },
  { id: A.memoryRelation, group: ANSWERS4, label: "memory_entity: a relation", note: "One relation in memory_entity's answer.", text: "- {{type}} {{target}}{{label}} (strength {{strength}}, sentiment {{sentiment}})", vars: [v("type", "what the other is to it: ally, enemy, owns, located_in, \u2026"), v("target", "the other entity's name", true), v("label", "the relation's label, after a colon"), v("strength", "from 0 to 1"), v("sentiment", "from -1 to 1")] },
  { id: A.memoryNoEntity, group: ANSWERS4, label: "memory_entity: no such entity", note: "memory_entity's answer to a name the Cortex has no entity for.", text: "Lumiverse's memory has no entity \u201C{{name}}\u201D. It knows: {{entities}}.", vars: [v("name", "the name asked for", true), v("entities", "the entities it has, each as An entity in a list writes it")] },
  { id: A.memoryEntities, group: ANSWERS4, label: "memory_entity: the entities", note: "memory_entity's answer without a name.", text: `The entities Lumiverse's memory has recorded for this chat, the most salient first ({{count}}):
{{entities}}`, vars: [v("count", 'how many are listed, with the word: "30 entities"'), v("entities", "each entity, as An entity in a list writes it", true)] },
  { id: A.memoryEntityBrief, group: ANSWERS4, label: "An entity in a list", note: "One entity where memory_entity lists them.", text: "{{name}} ({{type}}, {{mentions}})", vars: [v("name", "the entity's name", true), v("type", "what it is"), v("mentions", "how often the chat mentions it")] },
  { id: A.memoryNoEntities, group: ANSWERS4, label: "memory_entity: no entities", note: "memory_entity's answer when the Cortex has recorded none for the chat.", text: "Lumiverse's memory has recorded no entity for this chat yet.", vars: [] },
  { id: A.memoryArc, group: ANSWERS4, label: "memory_arcs: an arc", note: "One arc in memory_arcs' answer.", text: "- {{span}}{{when}} \xB7 tier {{tier}}{{title}}: {{summary}}", vars: [v("span", "the chat messages it covers; the text for nothing where that isn't known", true), WHEN, v("tier", "1 for a scene, 2 for a chapter, and so on"), v("title", "its title, after a dot; nothing when it has none"), v("summary", "its summary", true)] },
  { id: A.memoryNoArcs, group: ANSWERS4, label: "memory_arcs: none", note: "memory_arcs' answer when the Cortex has made no arc of the chat.", text: "Lumiverse's memory has made no arc of this chat yet. chat_outline gives the story's parts.", vars: [] },
  { id: A.memoryOff, group: ANSWERS4, label: "Lumiverse's memory is off", note: "A memory tool's answer when the user has the Memory Cortex switched off for the chat.", text: "Lumiverse's Memory Cortex is switched off for this chat, so it holds nothing to read. chat_outline, chat_about and chat_search work from the messages themselves.", vars: [] },
  { id: A.databank, group: ANSWERS4, label: "databank_list: a databank", note: "A databank's heading in databank_list's answer.", text: "Databank \u201C{{name}}\u201D [{{id}}] ({{scope}}), {{count}}{{description}}:", vars: [v("name", "the databank's name", true), v("id", "its id"), v("scope", "what it applies to: global, character or chat"), v("count", 'how many documents it has, with the word: "4 documents"'), v("description", "its description, after a dash")] },
  { id: A.databankDoc, group: ANSWERS4, label: "databank_list: a document", note: "One document in databank_list's answer.", text: "- [{{id}}] {{name}}{{size}}{{status}}", vars: [v("id", "the document's id, as databank_read takes it", true), v("name", "its name"), v("size", "its size, after a dot; nothing where it isn't known"), v("status", "that Lumiverse hasn't finished reading it in, in brackets; nothing once it has")] },
  { id: A.databankNone, group: ANSWERS4, label: "No databanks", note: "A databank tool's answer when no databank applies to the chat.", text: "No databank applies to this chat.", vars: [] },
  { id: A.databankHit, group: ANSWERS4, label: "databank_search: a hit", note: "One document databank_search found.", text: `- [{{id}}] {{name}} (databank \u201C{{bank}}\u201D, {{chars}} characters)
{{lines}}`, vars: [v("id", "the document's id, as databank_read takes it", true), v("name", "its name"), v("bank", "its databank's name"), v("chars", "its length"), v("lines", "its best lines, each as A hit's line writes it")] },
  { id: A.databankNothing, group: ANSWERS4, label: "databank_search: nothing found", note: "databank_search's answer for a query no document matches.", text: "No databank document matches \u201C{{query}}\u201D. databank_list lists what there is.", vars: [v("query", "what was looked for", true)] },
  { id: A.databankUnread, group: ANSWERS4, label: "databank_search: documents not searched", note: "Follows databank_search's answer when some documents weren't read in.", text: "[Not searched: {{documents}}. They are past Documents read in, or Lumiverse hasn't finished reading them; databank_read still reads one.]", vars: [v("documents", "the documents not searched, by id and name", true)] },
  { id: A.databankRead, group: ANSWERS4, label: "databank_read: its answer", note: "databank_read's answer: a document, or the part of it a page holds.", text: `[{{id}}] {{name}} (databank \u201C{{bank}}\u201D), characters {{from}} to {{to}} of {{chars}}:
{{text}}`, vars: [v("id", "the document's id", true), v("name", "its name"), v("bank", "its databank's name"), v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "the document's length"), v("text", "the text", true)] },
  { id: A.databankNoDoc, group: ANSWERS4, label: "databank_read: no such document", note: "databank_read's answer to an id no document of the chat's databanks has.", text: "There is no document {{id}} in the databanks that apply to this chat. databank_list gives each one's id.", vars: [v("id", "the id asked for", true)] },
  { id: A.databankNotReady, group: ANSWERS4, label: "databank_read: a document with no text", note: "databank_read's answer for a document Lumiverse has no text of.", text: "{{name}} has no text to read ({{status}}): Lumiverse hasn't finished reading it in, or couldn't.", vars: [v("name", "the document's name", true), v("status", "where it stands: pending, processing or error")] },
  { id: A.webHead, group: ANSWERS4, label: "web_search: its answer", note: "Heads web_search's answer.", text: "\u201C{{query}}\u201D: {{count}} from the web.", vars: [v("query", "the query", true), v("count", 'how many results, with the word: "5 results"', true)] },
  { id: A.webResult, group: ANSWERS4, label: "web_search: a result", note: "One result in web_search's answer.", text: `{{n}}. {{title}}
   {{url}}
   {{snippet}}{{page}}`, vars: [v("n", "its place among the results", true), v("title", "the page's title"), v("url", "its address", true), v("snippet", "the provider's snippet"), v("page", "the page's text, in the words below; nothing where it wasn't read")] },
  { id: A.webPage, group: ANSWERS4, label: "web_search: a page's text", note: "Fills {{page}} where the page was read.", text: `
   The page says: {{text}}`, vars: [v("text", "the start of the page's text", true)] },
  { id: A.webNothing, group: ANSWERS4, label: "web_search: nothing found", note: "web_search's answer when the provider gave no result.", text: "The web search gave nothing for \u201C{{query}}\u201D. Try other words.", vars: [v("query", "the query", true)] },
  { id: A.webOff, group: ANSWERS4, label: "web_search: no provider", note: "web_search's answer when the user's web search provider is no longer set up.", text: "No web search provider is set up in Lumiverse now, so nothing was searched.", vars: [] },
  { id: A.memoryMore, group: ANSWERS4, label: "memory_search: memories that didn't fit", note: "Ends memory_search's answer to one query when not every memory fits Answer length.", text: "({{count}} more didn't fit this answer: a narrower query, or memory_search's entities, brings them up.)", vars: [v("count", "how many more", true)] },
  { id: A.memoryFailed, group: ANSWERS4, label: "Lumiverse's memory couldn't be read", note: "A memory tool's answer when Lumiverse's Memory Cortex failed to answer.", text: "Lumiverse's memory couldn't be read ({{error}}). chat_outline, chat_about and chat_search work from the messages themselves.", vars: [v("error", "why, as Lumiverse gave it", true)] },
  { id: A.databankFailed, group: ANSWERS4, label: "The databanks couldn't be read", note: "A databank tool's answer when Lumiverse failed to give the databanks or a document's text.", text: "The databanks couldn't be read ({{error}}). Call again once; if it fails again, go on without them: lore_search and chat_search don't rest on them.", vars: [v("error", "why, as Lumiverse gave it", true)] },
  { id: A.webFailed, group: ANSWERS4, label: "web_search: the search failed", note: "web_search's answer when the user's web search provider failed.", text: "The web search failed ({{error}}), so nothing was found. Call again once; if it fails again, go on from what the chat, the lore and the databanks hold.", vars: [v("error", "why, as the provider or Lumiverse gave it", true)] },
  {
    id: C.pinned,
    group: RECALL,
    label: "The chronicle, pinned",
    note: "Leads the main agent's turn: the top of each file of the chronicle, without the lines that fail the check, then one line on its upkeep.",
    text: `[The chronicle: what this chat has established, kept in learned/chronicle/. Every line cites the messages it rests on; a line that cites nothing, or whose citation no message reads as, is left out. {{reach}} From here go down as far as the moment needs: chat_outline, chat_about, chat_search, then the messages themselves.]
{{files}}{{remind}}`,
    vars: [v("reach", "how far the chronicle reaches against the chat, in the words below"), v("files", "each file's top, as A file of the pinned chronicle writes it", true), v("remind", "the line on its upkeep, in the words below; nothing where Settings switch it off or jobs can't run")]
  },
  { id: C.pinnedFile, group: RECALL, label: "A file of the pinned chronicle", note: "One file's top in The chronicle, pinned.", text: `{{path}}{{more}}{{failed}}:
{{lines}}`, vars: [v("path", "the file's path", true), v("more", "that only its top is shown, in the words below"), v("failed", "that lines were left out, in the words below"), v("lines", "the lines shown", true)] },
  { id: C.pinnedMore, group: RECALL, label: "A pinned file cut", note: "Fills {{more}} when a file is longer than its share of Pinned chronicle: length.", text: " (its first {{shown}} of {{total}}; workspace_read reads the rest)", vars: [v("shown", "how many lines are shown", true), v("total", 'how many lines the file has, with the word: "120 lines"')] },
  { id: C.pinnedFailed, group: RECALL, label: "A pinned file with lines left out", note: "Fills {{failed}} when lines of the file fail the check.", text: " ({{count}} left out: they cite nothing, or cite what no message reads as; chronicle_check lists them)", vars: [v("count", 'how many lines, with the word: "2 lines"', true)] },
  { id: C.pinnedApart, group: RECALL, label: "A pinned file with lines that rest on what isn't the story", note: "Fills {{failed}} when lines of the file cite only messages that What counts as the story leaves out now.", text: " ({{count}} left out: every message they cite is left out of the story now)", vars: [v("count", 'how many lines, with the word: "2 lines"', true)] },
  { id: C.reach, group: RECALL, label: "How far the chronicle reaches", note: "Fills {{reach}}: the last message a line that passes cites, where the chat is, and how many messages it is past the chronicle.", text: "It reaches message #{{covered}}; the chat is at #{{last}}, {{count}} past it.", vars: [v("covered", "the last message a line that passes cites", true), v("last", "the chat's last message", true), v("count", 'how many messages the chat is past the chronicle, with the word: "14 messages"', true)] },
  { id: C.reachNone, group: RECALL, label: "A chronicle none of whose lines passes", note: "Fills {{reach}} when no line of the chronicle passes the check.", text: "None of its lines passes the check; the chat is at #{{last}} and has {{count}}.", vars: [v("last", "the chat's last message", true), v("count", 'how many messages the chat has, with the word: "140 messages"')] },
  { id: C.empty, group: RECALL, label: "No chronicle yet", note: "Leads the main agent's turn in a chat that has no chronicle and is longer than Bring up to date after, while Settings ask for one to be kept and jobs can run.", text: "[This chat has no chronicle yet (learned/chronicle/): nothing keeps what the story established, so the past has to be searched each time. It is at message #{{last}} and has {{count}}.]{{remind}}", vars: [v("last", "the chat's last message", true), v("count", 'how many messages the chat has, with the word: "140 messages"'), v("remind", "the line on its upkeep, in the words below", true)] },
  { id: C.jobRunning, group: RECALL, label: "Upkeep: the chronicler is running", note: "Ends the pinned chronicle while a chronicler job of this chat runs: the main agent starts no other.", text: `
[Upkeep: a chronicler job is running for this chat. Start no other.]`, vars: [] },
  { id: C.jobWaiting, group: RECALL, label: "Upkeep: the chronicler is waiting", note: "Ends the pinned chronicle while a chronicler job of this chat waits to run: the main agent starts no other.", text: `
[Upkeep: a chronicler job is waiting to run for this chat. Start no other.]`, vars: [] },
  { id: C.kept, group: RECALL, label: "Upkeep: nothing due", note: "Ends the pinned chronicle while the chat is no further past it than Bring up to date after: a job is worth it only where the turn changes what the chronicle states.", text: `
[Upkeep: nothing is due. Start a job only if this turn changes something the chronicle states. {{how}}{{before}}]`, vars: [v("how", "how a job is started, in the words below", true), v("before", "what is left to the user, in the words below; nothing where the chronicle reaches a message")] },
  { id: C.due, group: RECALL, label: "Upkeep: the chronicle is behind", note: "Ends the pinned chronicle once the chat is further past it than Bring up to date after.", text: `
[Upkeep: the chat is {{count}} past the chronicle, more than the user's setting allows. Have it brought up to date. {{how}}{{before}}]`, vars: [v("count", 'how many messages the chat is past the chronicle, with the word: "34 messages"', true), v("how", "how a job is started, in the words below", true), v("before", "what is left to the user, in the words below; nothing where the chronicle reaches a message")] },
  { id: C.begin, group: RECALL, label: "Upkeep: a chronicle to begin", note: "Follows No chronicle yet.", text: `
[Upkeep: have one begun. {{how}}{{before}}]`, vars: [v("count", 'how many messages the chat has, with the word: "140 messages"'), v("how", "how a job is started, in the words below", true), v("before", "what is left to the user, in the words below")] },
  { id: C.how, group: RECALL, label: "Upkeep: how a job is started", note: "Fills {{how}} where a writer writes the reply: the whole of how the chronicler is started, so the main agent loads no skill and spends no round on it.", text: "Call job_start in the same answer as write_reply, never in a round of its own: agent {{agent}}, task \u201CBring the chronicle up to date from message #{{from}}.\u201D", vars: [v("agent", "the chronicler's id", true), v("from", "the message a job goes on from", true)] },
  { id: C.howWrites, group: RECALL, label: "Upkeep: how a job is started, when it writes the reply itself", note: "Fills {{how}} where the main agent writes the reply itself, so it has no write_reply call to put the start beside.", text: "Call job_start among the tool calls of a round this reply needs anyway, never in a round of its own (a turn that needs no tool call leaves it to a later one): agent {{agent}}, task \u201CBring the chronicle up to date from message #{{from}}.\u201D", vars: [v("agent", "the chronicler's id", true), v("from", "the message a job goes on from", true)] },
  { id: C.before, group: RECALL, label: "Upkeep: what is left to the user", note: "Fills {{before}} where no line of the chronicle passes and the chat is longer than one reader's stretch: a job started with the reply begins at the chat's last stretch.", text: " The story before #{{from}} stays unlearned until the user has it learned (Learn this story, on the Chronicle page).", vars: [v("from", "the message the job begins at", true)] },
  {
    id: RECALL_TEXT.chronicler,
    group: RECALL,
    label: "Chronicler: instructions",
    note: "The chronicler's instructions: the built-in agent that keeps the chronicle. It reads no message of the chat itself: story readers do, a stretch each, and it merges what they return. The two skills it names hold its procedures.",
    text: [
      "You keep the chronicle of a roleplay chat: what the story has established, written down so that no agent has to read the chat again to know it. You work as a job, beside the story: nobody reads along, and you write no reply.",
      `The chronicle is four files in learned/chronicle/:
- outline.md: the story's parts in order, one line each: \u201C- #120\u2013#159 \xB7 The crossing: what happened, in a sentence. [#120 a3f9c27e] [#159 77b0d41c]\u201D. The numbers are the chat messages the part spans, and the line cites its first and its last message.
- facts.md: what is established and still true, one fact a line.
- threads.md: what is open: promises, debts, questions, plans, dangers. A thread that closed is deleted here and, where it matters, becomes a fact.
- cast.md: who is in the story, one line each: where they are now, in what state, what they want, what they know.`,
      "Every line of these four files is a markdown bullet that ends with the citation of each message it rests on, copied exactly as the chat tools print it: [#412 a3f9c27e]. No heading, no note, no line without a citation: chronicle_check fails every line that cites nothing, and a line that fails is left out of what the main agent is given. Only the top of each file is given to the main agent every turn, so the weightiest and the newest lines come first, each short enough to read at a glance. plan.md and unverified.md, in the same folder, are your working files: neither checked nor given to anyone.",
      "You never read the chat's text, and hold no tool that does: a session that read the chat would carry it in every later call. Story readers read it for you, a stretch each, in sessions of their own. Each answers with lines ready for the files (under outline:, facts:, threads: and cast:, every line with its citations) and a last line that says how far it read: \u201Cread: #120 to #159\u201D.",
      `Your task is one of two, and each has a skill that you load first (skill_load) and then follow:
- Bringing the chronicle up to date from a message on: the skill chronicle-keep.
- Learning the whole of a long history: the skill story-learn.`,
      `Common to both:
- Plan. chat_outline with stretches: true cuts the chat into the stretches readers are given, one line each: \u201C- #120 to #179 \xB7 60 messages, 34,200 characters\u201D. The size is the user's setting: take each line's numbers as they stand.
- Delegate each stretch to a reader: delegate with agent story-reader and, as its task, the stretch (\u201C#120 to #179\u201D) and anything to watch for. It knows nothing you don't write there. Put several delegate calls in one answer: those readers work side by side, as many at once as Settings allow, and the rest wait their turn.
- Merge the lines they return into the four files, copied as they stand, citations and all: workspace_write where a file is new, workspace_edit after, a round's changes in one answer. Never write a citation no reader gave you. A fact that was overturned is rewritten or removed, never left beside its opposite.
- A reader that delegate says stopped before it answered, or whose last line stops short of its stretch's end, left messages unread: write nothing about them, and say which they are.
- Run chronicle_check. It corrects a citation's number itself where the cited text stands at exactly one other message, and lists the runs of messages no outline line covers. Fix or delete every line it still fails.
- Answer with a short report: the stretches read, what you added, changed or removed, and the messages still unread.`,
      "Your session holds the plan and the lines the readers returned, never the chat. Every call you make carries all of it again, so put the calls that don't wait on each other in one answer."
    ].join(`

`),
    vars: []
  },
  {
    id: RECALL_TEXT.reader,
    group: RECALL,
    label: "Story reader: instructions",
    note: "The story reader's instructions: the built-in agent that reads one stretch of the chat for the chronicler and answers with lines for the chronicle. The chronicler merges what stands under the form's four headings and reads its last line for how far the reader came, so keep the form. It asks for five messages a call because that is what fits one answer of the chat tools at the default Answer length: change the number here if you change that setting.",
    text: [
      "You read one stretch of a roleplay chat for the chronicler: the agent that keeps the chat's chronicle, which is what the story has established, written down so that no agent has to read the chat again to know it. The chronicler never sees the chat: it has your answer and nothing else. Other readers have the other stretches.",
      "Your task names your stretch by its first and its last message (\u201C#120 to #159\u201D), and may name things to watch for.",
      `Read exactly that stretch: all of it, and nothing else.
- chat_read with from and to reads a run of messages. A long read comes a page at a time: call again with the cursor a page ends with, until an answer says it is the end.
- Every answer of yours after the first carries all you have read so far, so read in as few answers as you can. In your first answer, call chat_read once for every five messages of the stretch (#120 to #124, #125 to #129, and so on to its end): the calls of one answer run together. A run too long for one page comes back with a cursor: follow all the cursors at once in your next answer.
- chat_around, chat_grep, chat_search and the book and lore tools are for the rare thing your stretch leaves unclear: who a name is, what a place is. They are not for reading on: another reader has the rest.
- You are told how many rounds of tool calls you have. When you are told that few are left, stop reading and answer with what you have.`,
      "Then answer with chronicle lines in exactly this form, and nothing else: no greeting, no comment, no code fence.",
      `outline:
- #120\u2013#159 \xB7 The crossing: what happened, in a sentence. [#120 a3f9c27e] [#159 77b0d41c]
facts:
- One thing established and still true at the stretch's end. [#131 0c2e9a51]
threads:
- One thing left open. [#140 51aab3f0]
cast:
- Mara: where she is, in what state, what she wants, what she knows. [#158 9d1e6c07]
read: #120 to #159`,
      `- outline: one line for the stretch, or one for each of its parts where it plainly holds more than one. A line opens with the messages it spans (#120\u2013#159) and cites the first and the last of them. Together the lines span every message you read and none you didn't: a message counts as read only where an outline line spans it.
- facts: what the stretch establishes that is still true at its end, one fact a line, the weightiest first. Not what the stretch itself overturns again.
- threads: what is open at its end: promises, debts, questions, plans, dangers.
- cast: one line for each person in it: where they are at its end, in what state, what they want, what they know.
- Every line is a markdown bullet that ends with the citation of each message it rests on, copied exactly as chat_read prints it: [#412 a3f9c27e]. Never write a citation you didn't read off a tool's answer, and never change one.
- A section with nothing to say keeps its heading, with no line under it.
- Write what the messages say, not what you expect. What you were asked to watch for goes where it belongs among these lines; where the stretch says nothing of it, leave it out.
- One or two sentences a line, and no more lines than a later reply needs to get the story right: not every turn of the talk.
- The last line says truthfully how far you read: your stretch's first message, and the last message you read to its end. Where you stopped short it names that message, not the stretch's end, and no line above it speaks of anything later. Where you read nothing: \u201Cread: nothing\u201D, under the four headings.`,
      "Where your task says to take the stretch from the book's summary, don't read its messages: book_outline, then book_read of the entries that cover it, and chat_read of its first and of its last message alone, for their citations. Answer in the same form, every line citing those two messages, and end with \u201Cread: #120 to #159, from the book's summary\u201D."
    ].join(`

`),
    vars: []
  },
  {
    id: RECALL_TEXT.story.objective,
    group: RECALL,
    label: "Learn this story: the objective",
    note: "What the page fills in as the objective when the user starts the learning of a chat's story. They can change it before they start.",
    text: "Learn this chat's story and build its chronicle in learned/chronicle/. Load the skill {{skill}} first and follow it.",
    vars: [v("skill", "the id of the skill for learning an existing story", true)]
  },
  word(RECALL_TEXT.word.stretch, "stretch", "stretches"),
  word(RECALL_TEXT.word.mention, "mention", "mentions"),
  word(RECALL_TEXT.word.hit, "hit", "hits"),
  word(RECALL_TEXT.word.part, "part", "parts"),
  word(RECALL_TEXT.word.worldBook, "book", "books"),
  word(RECALL_TEXT.word.memory, "memory", "memories"),
  word(RECALL_TEXT.word.document, "document", "documents"),
  word(RECALL_TEXT.word.result, "result", "results"),
  word(RECALL_TEXT.word.arc, "arc", "arcs"),
  word(RECALL_TEXT.word.fact, "fact", "facts"),
  word(RECALL_TEXT.word.relation, "relation", "relations"),
  word(RECALL_TEXT.word.databank, "databank", "databanks"),
  word(RECALL_TEXT.word.problem, "problem", "problems"),
  word(RECALL_TEXT.word.citation, "citation", "citations"),
  word(RECALL_TEXT.word.entity, "entity", "entities")
];

// src/core/texts/side.ts
var SIDE_TEXT = {
  about: "side.about",
  aboutChat: "side.about.chat",
  aboutNothing: "side.about.nothing",
  summary: "side.summary",
  summarizer: "side.summarizer",
  summarizerInput: "side.summarizer.input",
  asked: "side.summarizer.asked",
  answered: "side.summarizer.answered",
  unanswered: "side.unanswered"
};
var SIDE = GROUP.side;
var SIDE_TEXTS = [
  { id: SIDE_TEXT.about, group: SIDE, label: "What a side session is", note: "Follows the instructions of an agent in a side session.", text: "This is a side conversation with the user, on LumiAH's page: not a reply in a chat. Answer the user directly, as yourself. Nothing you write here goes into a chat's messages, and there is no writer: your answer is what they read. {{about}}", vars: [v("about", "what the conversation is about, as the two texts below say it", true)] },
  { id: SIDE_TEXT.aboutChat, group: SIDE, label: "A side session about a chat", note: "Fills {{about}} for a side session about a chat.", text: "It is about the chat \u201C{{chat}}\u201D: your chat, lore and workspace tools read that chat as it stands now.", vars: [v("chat", "the chat's name", true)] },
  { id: SIDE_TEXT.aboutNothing, group: SIDE, label: "A side session about no chat", note: "Fills {{about}} for a side session about nothing in particular.", text: "It is about no chat in particular: there is no chat or lore to read, and of the workspace only the user's own files (~/).", vars: [] },
  { id: SIDE_TEXT.summary, group: SIDE, label: "The summary, in a side session", note: "Leads a side session's conversation once its older part was summarized.", text: `[The earlier part of this conversation, summarized:]
{{summary}}`, vars: [v("summary", "the summary", true)] },
  {
    id: SIDE_TEXT.summarizer,
    group: SIDE,
    label: "Side session summary: instructions",
    note: "The instructions of the call that summarizes the older part of a long side session.",
    text: "You are given the earlier part of a conversation between a user and an agent, and a summary of what came before it, if there is one. Write one summary that stands for all of it, for the agent to go on from: what the user asked for and why, what was decided, what the agent found or did (with the names of files it wrote), and what is still open. Keep it under {{limit}} tokens. Answer with the summary alone.",
    vars: [v("limit", "Summary length", true)]
  },
  { id: SIDE_TEXT.summarizerInput, group: SIDE, label: "Side session summary: what it is given", note: "The message of the call that summarizes a side session.", text: `The summary so far:
{{summary}}

The conversation since:

{{turns}}`, vars: [v("summary", "the summary so far, or that there is none", true), v("turns", "each exchange, as the two texts below write it", true)] },
  { id: SIDE_TEXT.asked, group: SIDE, label: "Side session summary: the user", note: "What the user said, in what the summarizer is given.", text: `The user:
{{text}}`, vars: [v("text", "the user's words", true)] },
  { id: SIDE_TEXT.answered, group: SIDE, label: "Side session summary: the agent", note: "What the agent answered, in what the summarizer is given.", text: `The agent:
{{text}}`, vars: [v("text", "the agent's answer", true)] },
  { id: SIDE_TEXT.unanswered, group: SIDE, label: "A side session turn without an answer", note: "Stands for the agent's answer, in its conversation, to a message it didn't answer.", text: "(You didn't answer this: {{reason}}.)", vars: [v("reason", "why", true)] }
];

// src/core/texts/spend.ts
var SPEND_TEXT = {
  stopTokens: "stop.spend_tokens",
  stopTokensCall: "stop.spend_tokens_call",
  stopCost: "stop.spend_cost",
  stopCostCall: "stop.spend_cost_call"
};
var SPEND_TEXTS = [
  stopText(SPEND_TEXT.stopTokens, "Tokens per day spent", "A call once every agent's calls together have sent and written all Tokens per day allows.", "what every agent's calls sent and wrote in the last 24 hours is counted as {{tokens}} of the {{limit}} Tokens per day allows (a cached re-read counts as {{weight}} of a token)", [
    v("tokens", `what every agent's calls sent and wrote in the last 24 hours as the limit counts it, with the word: "5000000 tokens"`, true),
    v("limit", "Tokens per day", true),
    v("weight", "What a cached re-read counts as")
  ]),
  stopText(SPEND_TEXT.stopTokensCall, "Tokens per day: the call would pass it", "A call whose own prompt would take every agent's calls past Tokens per day, though they are under it so far.", "the call would take what every agent's calls sent and wrote in the last 24 hours past Tokens per day: counted as {{counted}} with it, of the {{limit}} allowed (a cached re-read counts as {{weight}} of a token)", [
    v("counted", `what every agent's calls spent in the last 24 hours as the limit counts it, with this call's prompt as estimated and the calls under way, with the word: "5004000 tokens"`, true),
    v("limit", "Tokens per day", true),
    v("weight", "What a cached re-read counts as")
  ]),
  stopText(SPEND_TEXT.stopCost, "Cost per day spent", "A call once every agent's calls together have cost all Cost per day allows.", "every agent's calls together have cost ${{cost}} in the last 24 hours, and Cost per day allows ${{limit}}", [
    v("cost", `what every agent's calls cost in the last 24 hours, in US dollars: "5.02"`, true),
    v("limit", 'Cost per day, in US dollars: "5.00"', true)
  ]),
  stopText(SPEND_TEXT.stopCostCall, "Cost per day: the call would pass it", "A call whose own prompt, at your price for its model, would take every agent's calls past Cost per day, though they are under it so far.", "the call would take what every agent's calls cost in the last 24 hours past Cost per day: about ${{cost}} with it, and Cost per day allows ${{limit}}", [
    v("cost", `what every agent's calls cost in the last 24 hours with this call's prompt as estimated and the calls under way, in US dollars: "5.02"`, true),
    v("limit", 'Cost per day, in US dollars: "5.00"', true)
  ])
];

// src/core/texts/workspace.ts
var WORKSPACE_TEXT = {
  areaChat: "workspace.area.chat",
  areaLearned: "workspace.area.learned",
  areaUser: "workspace.area.user",
  noArea: "workspace.no_area",
  pathBad: "workspace.path.bad",
  pathOutside: "workspace.path.outside",
  pathLong: "workspace.path.long",
  listLead: "workspace.list.lead",
  listFolder: "workspace.list.folder",
  listFile: "workspace.list.file",
  listPinned: "workspace.list.pinned",
  listEmpty: "workspace.list.empty",
  listIsFile: "workspace.list.is_file",
  listNothing: "workspace.list.nothing",
  readPage: "workspace.read.page",
  readGone: "workspace.read.gone",
  grepLine: "workspace.grep.line",
  grepNothing: "workspace.grep.nothing",
  wrote: "workspace.wrote",
  unchanged: "workspace.unchanged",
  edited: "workspace.edited",
  moved: "workspace.moved",
  deleted: "workspace.deleted",
  pinned: "workspace.pinned",
  unpinned: "workspace.unpinned",
  pinUser: "workspace.pin.user",
  noFile: "workspace.no_file",
  noFileToWrite: "workspace.write.no_file",
  isFolder: "workspace.is_folder",
  exists: "workspace.exists",
  stale: "workspace.stale",
  fileChars: "workspace.limit.file_chars",
  files: "workspace.limit.files",
  areaChars: "workspace.limit.area_chars",
  editNotFound: "workspace.edit.not_found",
  editSeveral: "workspace.edit.several",
  moveAcross: "workspace.move.across",
  wordFile: "word.file",
  wordListed: "word.folder_or_file",
  wordMatch: "word.match"
};
var ANSWERS5 = GROUP.answers;
var FILE_ARG = "The file's path, as workspace_list writes it: /notes/plan.md in this chat's own area, learned/\u2026 kept with the chat, ~/\u2026 the user's own.";
var BASE_ARG = "The file's version as you last read it, from workspace_read or workspace_list.";
var area = (id, label, text) => ({ id, group: ANSWERS5, label: `An area: ${label}`, note: "Names an area where an answer says which areas a run's workspace has.", text, vars: [v("root", "how the area's paths start", true)] });
var WORKSPACE_TEXTS = [
  ...toolTexts(TOOL.workspaceList, "List the workspace: the text files you and the other agents keep, for yourselves and for each other. It has three areas, told apart by how a path starts. / is this chat's own, and follows the story: when the user swipes, regenerates or edits the chat, its files go back to how they stood at that point. learned/ is kept with the chat whatever path the story takes. ~/ is the user's own, shared by all their chats. This lists what is directly in a folder: its folders, each with how many files it holds, and its files, each with its length, its version and whether it is pinned for you. Without a path it lists /.", { path: "The folder to list: /, learned/, ~/, or a folder under one of them, such as /notes/. Leave it out to list /.", cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.workspaceRead, "Read a workspace file, a page at a time. The answer gives the file's version: every change to a file names the version it was based on, so keep it for the change you make next.", { path: FILE_ARG, cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.workspaceGrep, "Find every line of the workspace's files that holds some exact text, in any letter case, each with its file and line number. Without a path it searches / and learned/; give ~/ to search the user's own files, or a folder or one file to search that alone.", {
    text: "The text to find, as written; letter case doesn't matter.",
    path: "Where to search: a folder (/notes/, learned/, ~/) or one file. Leave it out to search / and learned/.",
    cursor: CURSOR_ARG
  }),
  ...toolTexts(TOOL.workspaceWrite, "Write a workspace file whole: a new file, or the next version of one there is. Every change names the version it was based on: base is new for a file that isn't there yet, else the version workspace_read or workspace_list gave you. If the file has changed since, nothing is written and you are told its version now: read it again and make your change on that. The area decides how the file lives: / follows the story as swipes and edits do, learned/ stays with the chat whatever path the story takes, ~/ is the user's own, shared by all their chats. For a small change to a long file, workspace_edit is cheaper.", {
    path: "The file's path: /notes/plan.md in this chat's own area, learned/\u2026 to keep it with the chat, ~/\u2026 for the user's own. Its folders need no making.",
    content: "The file's whole text, as it is to stand.",
    base: "new for a file that isn't there yet; else the version this text is based on, as workspace_read and workspace_list give it."
  }),
  ...toolTexts(TOOL.workspaceEdit, "Change part of a workspace file: one exact match of find is replaced by replace. find must be in the file once: give more of the text around it until it is, or pass all to replace every match. Like every change it names the version it was based on, as workspace_read gave it.", {
    path: FILE_ARG,
    find: "The text to replace, exactly as the file holds it: every space and line break counts.",
    replace: "What takes its place. Empty takes the text out.",
    base: BASE_ARG,
    all: "true to replace every match of find. Left out, find must match once."
  }),
  ...toolTexts(TOOL.workspaceMove, "Move or rename a workspace file within its area; its history and its pins go with it. Like every change it names the version it was based on. To take a file to another area, write it there and delete it here.", {
    from: "The file's path now.",
    to: "Its new path, in the same area. No file may be there yet.",
    base: BASE_ARG
  }),
  ...toolTexts(TOOL.workspaceDelete, "Delete a workspace file. Like every change it names the version it was based on, so a file someone changed since you read it isn't deleted unseen.", { path: FILE_ARG, base: BASE_ARG }),
  ...toolTexts(TOOL.workspacePin, "Pin a workspace file, or lift its pin. A pinned file leads what you are sent each turn, as it stands then: pin what you need every time, such as a running summary or the facts to keep straight, and keep it short. Pinned files share a size limit, and one past it is only named. You pin in / and learned/; a pin in ~/ reaches every chat of the user's, so it is theirs to set unless their settings let you.", { path: FILE_ARG, pinned: "true to pin the file, false to lift its pin." }),
  area(WORKSPACE_TEXT.areaChat, "the chat's own", "{{root}} (this chat's own files)"),
  area(WORKSPACE_TEXT.areaLearned, "kept with the chat", "{{root}} (kept with the chat)"),
  area(WORKSPACE_TEXT.areaUser, "the user's own", "{{root}} (the user's own files)"),
  { id: WORKSPACE_TEXT.noArea, group: ANSWERS5, label: "An area this run doesn't have", note: "A workspace tool's answer to a path in an area the run has none of: a side session about no chat has the user's files alone.", text: "Your workspace has no {{area}} here. It has: {{areas}}. Give a path in one of those.", vars: [v("area", "the area asked for, by how its paths start"), v("areas", "the areas there are, each as the three texts above name it", true)] },
  { id: WORKSPACE_TEXT.pathBad, group: ANSWERS5, label: "A path that can't be one", note: "A workspace tool's answer to a path that holds a backslash or a control character.", text: "That path can't be used: a path holds no backslash and no control character. Put / between its folders, as in /notes/plan.md.", vars: [] },
  { id: WORKSPACE_TEXT.pathOutside, group: ANSWERS5, label: "A path that leaves its area", note: "A workspace tool's answer to a path that climbs out of its area.", text: "That path climbs out of its area: .. may go up inside an area, never above it. Say which area by how the path starts: / for this chat's own, learned/, or ~/ for the user's.", vars: [] },
  { id: WORKSPACE_TEXT.pathLong, group: ANSWERS5, label: "A path too long", note: "A workspace tool's answer to a path past Path length.", text: "That path is too long: within its area a path may hold {{limit}} characters at most (Path length). Use shorter names or fewer folders.", vars: [v("limit", "Path length", true)] },
  { id: WORKSPACE_TEXT.listLead, group: ANSWERS5, label: "workspace_list: the chat's area", note: "Leads workspace_list's answer when it lists the chat's own area from the top.", text: "This is /, the chat's own area. ~/ is the user's own area, shared by all their chats: list it with path ~/.", vars: [] },
  { id: WORKSPACE_TEXT.listFolder, group: ANSWERS5, label: "workspace_list: a folder", note: "One folder in workspace_list's answer.", text: "- {{path}} (folder, {{files}})", vars: [v("path", "the folder's path, closed with a slash", true), v("files", 'how many files it holds, at any depth, with the word: "3 files"')] },
  { id: WORKSPACE_TEXT.listFile, group: ANSWERS5, label: "workspace_list: a file", note: "One file in workspace_list's answer.", text: "- {{path}} ({{chars}} characters, version {{version}}{{pinned}})", vars: [v("path", "the file's path", true), v("chars", "its length"), v("version", "its version, which a change to it names as base"), v("pinned", "that it is pinned for the agent that asks, in the words below; nothing when it isn't")] },
  { id: WORKSPACE_TEXT.listPinned, group: ANSWERS5, label: "workspace_list: a pinned file", note: "Marks a file that is pinned for the agent that asks, in workspace_list's answers.", text: ", pinned for you", vars: [] },
  { id: WORKSPACE_TEXT.listEmpty, group: ANSWERS5, label: "workspace_list: an empty area", note: "workspace_list's answer for an area that holds no file.", text: "{{path}} holds no files yet.", vars: [v("path", "how the area's paths start", true)] },
  { id: WORKSPACE_TEXT.listIsFile, group: ANSWERS5, label: "workspace_list: a file, not a folder", note: "workspace_list's answer to a path that names a file.", text: "{{path}} is a file, not a folder: {{chars}} characters, version {{version}}{{pinned}}. workspace_read reads it.", vars: [v("path", "the file's path", true), v("chars", "its length"), v("version", "its version"), v("pinned", "that it is pinned for the agent that asks; nothing when it isn't")] },
  { id: WORKSPACE_TEXT.listNothing, group: ANSWERS5, label: "workspace_list: nothing there", note: "workspace_list's answer to a path that names no file and no folder that holds one.", text: "There is nothing at {{path}}: no file, and no folder that holds one. workspace_list without a path lists the workspace from the top.", vars: [v("path", "the path asked for", true)] },
  {
    id: WORKSPACE_TEXT.readPage,
    group: ANSWERS5,
    label: "workspace_read: its answer",
    note: "workspace_read's answer: a file, or the part of it a page holds, under its path, its length and its version.",
    text: `[{{path}}: characters {{from}} to {{to}} of {{total}}, version {{version}}. A write, an edit, a move or a delete of this file takes that version as base.]
{{text}}`,
    vars: [v("path", "the file's path"), v("from", "the first character shown"), v("to", "the character after the last shown"), v("total", "the file's length"), v("version", "its version, which a change to it names as base", true), v("text", "the text", true)]
  },
  { id: WORKSPACE_TEXT.readGone, group: ANSWERS5, label: "workspace_read: a text that is gone", note: "A workspace tool's answer when the store no longer has a file's text.", text: "The text of {{path}} (version {{version}}) is no longer in the store, so it can't be read. If you know what it held, write it again with workspace_write and base {{version}}; else say in your answer that it is lost.", vars: [v("path", "the file's path", true), v("version", "its version")] },
  { id: WORKSPACE_TEXT.grepLine, group: ANSWERS5, label: "workspace_grep: a line", note: "One line workspace_grep found.", text: "- {{path}}, line {{line}}: {{text}}", vars: [v("path", "the file's path", true), v("line", "the line's number in the file"), v("text", "the line, around what was found", true)] },
  { id: WORKSPACE_TEXT.grepNothing, group: ANSWERS5, label: "workspace_grep: nothing found", note: "workspace_grep's answer when no line holds the text: where it looked, and what to try next.", text: "No line holds \u201C{{query}}\u201D in {{where}} ({{files}} searched). Try a shorter piece of it, or look elsewhere: without a path the search covers / and learned/, and path ~/ searches the user's own files.", vars: [v("query", "what was looked for", true), v("where", "where it looked"), v("files", 'how many files it read, with the word: "12 files"')] },
  { id: WORKSPACE_TEXT.wrote, group: ANSWERS5, label: "workspace_write: written", note: "workspace_write's answer once the file is written.", text: "Wrote {{path}}: {{chars}} characters, now at version {{version}}. Your next change to it takes that version as base.", vars: [v("path", "the file's path", true), v("chars", "its length"), v("version", "its new version", true)] },
  { id: WORKSPACE_TEXT.unchanged, group: ANSWERS5, label: "A write that changes nothing", note: "The answer of workspace_write and workspace_edit when the file already holds the text they would give it: no version is made.", text: "{{path}} already holds exactly this text, so nothing changed. It is at version {{version}}.", vars: [v("path", "the file's path", true), v("version", "its version", true)] },
  { id: WORKSPACE_TEXT.edited, group: ANSWERS5, label: "workspace_edit: edited", note: "workspace_edit's answer once the file is changed.", text: "Edited {{path}}: {{count}} replaced. It holds {{chars}} characters now, at version {{version}}. Your next change to it takes that version as base.", vars: [v("path", "the file's path", true), v("count", 'how many matches were replaced, with the word: "1 match"'), v("chars", "its length now"), v("version", "its new version", true)] },
  { id: WORKSPACE_TEXT.moved, group: ANSWERS5, label: "workspace_move: moved", note: "workspace_move's answer once the file is moved.", text: "Moved {{from}} to {{to}}. Its text is the same, so its version is still {{version}}.", vars: [v("from", "the path it had"), v("to", "its path now", true), v("version", "its version")] },
  { id: WORKSPACE_TEXT.deleted, group: ANSWERS5, label: "workspace_delete: deleted", note: "workspace_delete's answer once the file is gone.", text: "Deleted {{path}}. It was at version {{version}}.", vars: [v("path", "the path it had", true), v("version", "the version that went")] },
  { id: WORKSPACE_TEXT.pinned, group: ANSWERS5, label: "workspace_pin: pinned", note: "workspace_pin's answer once the file is pinned: how much the agent's pinned files hold now, against Pinned files in context.", text: "Pinned {{path}}: it leads what you are sent each turn, as it stands then. Your pinned files hold {{chars}} characters together now; up to {{limit}} are given in full (Pinned files in context), and a file past that is only named.", vars: [v("path", "the file's path", true), v("chars", "the length of the agent's pinned files together"), v("limit", "Pinned files in context")] },
  { id: WORKSPACE_TEXT.unpinned, group: ANSWERS5, label: "workspace_pin: pin lifted", note: "workspace_pin's answer once the file's pin is lifted.", text: "Lifted the pin on {{path}}: it no longer leads what you are sent. workspace_read still reads it.", vars: [v("path", "the file's path", true)] },
  {
    id: WORKSPACE_TEXT.pinUser,
    group: ANSWERS5,
    label: "workspace_pin: a pin in the user's area",
    note: "workspace_pin's answer to a file in ~/ while Agents may pin your own files is off: a pin there reaches every chat, so it is the user's to set and to lift.",
    text: "Nothing was changed: {{path}} is in ~/, the user's own area, and a pin there leads what you are sent in every chat of theirs, so pins there are the user's to set and to lift, on the Workspace page (Agents may pin your own files). To have this text each turn in this chat, keep it in a file in / or learned/ and pin that.",
    vars: [v("path", "the file's path", true)]
  },
  { id: WORKSPACE_TEXT.noFile, group: ANSWERS5, label: "No such file", note: "A workspace tool's answer to a path that names no file.", text: "There's no file {{path}}. workspace_list shows the files there are.", vars: [v("path", "the path asked for", true)] },
  { id: WORKSPACE_TEXT.noFileToWrite, group: ANSWERS5, label: "workspace_write: no file to base it on", note: "workspace_write's answer to a base given for a file that isn't there.", text: "Nothing was written: there's no file {{path}}, so there is no version to base it on. To make the file, call workspace_write again with base new. workspace_list shows the files there are.", vars: [v("path", "the path asked for", true)] },
  { id: WORKSPACE_TEXT.isFolder, group: ANSWERS5, label: "A folder where a file is needed", note: "A workspace tool's answer to a path that names a folder where it takes one file.", text: "{{path}} is a folder, and this takes one file. workspace_list with that path lists the files in it.", vars: [v("path", "the folder's path", true)] },
  { id: WORKSPACE_TEXT.exists, group: ANSWERS5, label: "A file already there", note: "The answer to a write that said the file was new, or a move to a path, where there is a file already.", text: "Nothing was changed: there is already a file {{path}}, at version {{version}}. To replace its text, read it with workspace_read and write with that version as base; else choose another path.", vars: [v("path", "the file's path", true), v("version", "the version it has", true)] },
  { id: WORKSPACE_TEXT.stale, group: ANSWERS5, label: "A change based on another version", note: "The answer to a write, an edit, a move or a delete whose base isn't the version the file has now.", text: "Nothing was changed: {{path}} is at version {{version}} now, and that isn't the version you gave as base: it was changed since you read it, or the base was miscopied. Read it again with workspace_read and make your change on what it holds now.", vars: [v("path", "the file's path", true), v("version", "the version it has now", true)] },
  { id: WORKSPACE_TEXT.fileChars, group: ANSWERS5, label: "A file too long", note: "The answer to a write or an edit that would take a file past File length.", text: "Nothing was changed: the file would hold {{chars}} characters, and a file may hold {{limit}} at most (File length). Split it over several files.", vars: [v("chars", "the length it would have"), v("limit", "File length", true)] },
  { id: WORKSPACE_TEXT.files, group: ANSWERS5, label: "Too many files", note: "The answer to a write of a new file into an area that holds as many as Files per area allows.", text: "Nothing was changed: this area already holds the {{limit}} it may (Files per area). Delete files nobody needs any more, or add to one there is.", vars: [v("limit", 'Files per area, with the word: "400 files"', true)] },
  { id: WORKSPACE_TEXT.areaChars, group: ANSWERS5, label: "An area too big", note: "The answer to a write or an edit that would take an area's files past Area size.", text: "Nothing was changed: with it this area's files would hold {{chars}} characters together, and an area may hold {{limit}} at most (Area size). Delete or shorten files nobody needs any more first.", vars: [v("chars", "the length the area's files would have together"), v("limit", "Area size", true)] },
  { id: WORKSPACE_TEXT.editNotFound, group: ANSWERS5, label: "workspace_edit: nothing to replace", note: "workspace_edit's answer when the file doesn't hold the text to replace.", text: "Nothing was changed: {{path}} (version {{version}}) doesn't hold that text, character for character. Read the file again with workspace_read and copy the text to replace from what it gives.", vars: [v("path", "the file's path", true), v("version", "its version")] },
  { id: WORKSPACE_TEXT.editSeveral, group: ANSWERS5, label: "workspace_edit: several matches", note: "workspace_edit's answer when the text to replace is in the file more than once and all wasn't asked for.", text: "Nothing was changed: that text is in {{path}} {{count}}. Give more of the text around the one you mean, until find matches once, or pass all: true to replace every one.", vars: [v("path", "the file's path", true), v("count", 'how many times, with the word: "3 times"', true)] },
  { id: WORKSPACE_TEXT.moveAcross, group: ANSWERS5, label: "workspace_move: across areas", note: "workspace_move's answer to a move from one area to another.", text: "Nothing was moved: a move stays inside one area, and {{from}} and {{to}} are in two. To take the file across, read it, write it there with workspace_write and base new, then delete it here with workspace_delete.", vars: [v("from", "the path it has"), v("to", "the path asked for")] },
  word(WORKSPACE_TEXT.wordFile, "file", "files"),
  word(WORKSPACE_TEXT.wordListed, "folder or file", "folders and files"),
  word(WORKSPACE_TEXT.wordMatch, "match", "matches")
];

// src/core/texts.ts
var TEXT = {
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
    scratchFull: "runtime.scratch_full"
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
    answerRoom: "stop.answer_room"
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
    askReleases: "main.turn.ask.releases"
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
    failedCut: "session.summary_failed.cut"
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
    releaseEnded: "tool.answer.release_ended"
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
    agentsUnread: "progress.agents_unread"
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
  agents: AGENTS_TEXT,
  workspace: WORKSPACE_TEXT,
  jobs: JOBS_TEXT,
  approval: APPROVAL_TEXT,
  side: SIDE_TEXT,
  spend: SPEND_TEXT,
  book: BOOK_TEXT,
  recall: RECALL_TEXT,
  tool: toolId,
  toolArg: toolArgId
};
var RUNTIME = GROUP.runtime;
var MAIN = GROUP.main;
var REQUEST = GROUP.request;
var WRITER = GROUP.writer;
var SESSION = GROUP.session;
var ANSWERS6 = GROUP.answers;
var PROGRESS = GROUP.progress;
var RUNTIME_TEXTS = [
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
    vars: [v("shown", "the characters shown"), v("total", "the result's length"), v("handle", "where the whole result waits", true)]
  },
  { id: TEXT.runtime.scratchFull, group: RUNTIME, label: "scratch_read: no room left", note: "scratch_read's answer when the agent's prompt has no room left for any more of a result (Prompt per call).", text: "Your prompt has no room left for more of scratch {{handle}} (Prompt per call). Answer with what you have.", vars: [v("handle", "the handle asked for", true)] }
];
var STOP_TEXTS = [
  stopText(TEXT.stop.cancelled, "Cancelled", "The agent was cancelled: the turn was stopped, or whoever started it stopped it.", "the agent was cancelled"),
  stopText(TEXT.stop.busy, "Still working", "A message sent while the agent still works on its last one.", "the agent is still working on its last message"),
  stopText(TEXT.stop.revisions, "Out of revisions", "A message after its first answer, once it has had every revision its budget allows (Revisions).", "it has had the {{revisions}} it may have after its first answer (Revisions)", [v("revisions", 'the revisions it may have, with the word: "2 revisions"', true)]),
  stopText(TEXT.stop.wallTime, "Out of time", "The agent's own time ran out (Time per agent).", "the agent's time ran out (Time per agent)"),
  stopText(TEXT.stop.turnTime, "The turn out of time", "The turn's time ran out (Time per turn).", "the turn's time ran out (Time per turn)"),
  stopText(TEXT.stop.callTime, "A call too slow", "One call took longer than Time per call.", "the call took longer than Time per call"),
  stopText(TEXT.stop.callTokensIn, "A prompt too long", "A call whose prompt, as estimated, is past Prompt per call.", "the call's prompt, about {{tokens}}, is past Prompt per call ({{limit}})", [v("tokens", `the prompt's estimate, with the word: "9000 tokens"`, true), v("limit", "Prompt per call", true)]),
  stopText(TEXT.stop.tokensIn, "The agent's prompt tokens spent", "A call that would take the agent's prompt tokens past Prompt tokens per agent.", "the call would take the agent's prompt tokens past Prompt tokens per agent: counted as {{counted}} of the {{limit}} allowed (a cached re-read counts as {{weight}} of a token)", [v("counted", "the prompt tokens with this call, as the limit counts them"), v("weight", "What a cached re-read counts as"), v("limit", "Prompt tokens per agent", true)]),
  stopText(TEXT.stop.tokensOut, "The agent's answer tokens spent", "The agent has written all Answer tokens per agent allows.", "the agent has written its {{tokens}} (Answer tokens per agent)", [v("tokens", 'Answer tokens per agent, with the word: "4000 tokens"', true)]),
  stopText(TEXT.stop.turnTokensIn, "The turn's prompt tokens spent", "A call that would take the turn's prompt tokens past Prompt tokens per turn.", "the call would take the turn's prompt tokens past Prompt tokens per turn: counted as {{counted}} of the {{limit}} allowed (a cached re-read counts as {{weight}} of a token)", [v("counted", "the prompt tokens with this call, as the limit counts them"), v("weight", "What a cached re-read counts as"), v("limit", "Prompt tokens per turn", true)]),
  stopText(TEXT.stop.turnTokensOut, "The turn's answer tokens spent", "The turn's agents have written all Answer tokens per turn allows.", "the turn's agents have written its {{tokens}} (Answer tokens per turn)", [v("tokens", 'Answer tokens per turn, with the word: "20000 tokens"', true)]),
  stopText(TEXT.stop.loop, "The loop detector", "The agent called one tool with the same arguments, and got the same result, as many times in a row as the loop detector allows.", "the agent called {{tool}} with the same arguments {{times}} in a row and got the same result each time (Loop detector)", [v("tool", "the tool's name", true), v("times", 'how many times, with the word: "3 times"', true)]),
  stopText(TEXT.stop.toolTurns, "The agent's tool rounds spent", "The agent has had every round of tool calls Tool rounds per agent allows.", "the agent has had its {{rounds}} of tool calls (Tool rounds per agent)", [v("rounds", 'Tool rounds per agent, with the word: "8 rounds"', true)]),
  stopText(TEXT.stop.turnToolTurns, "The turn's tool rounds spent", "The turn's agents have had every round of tool calls Tool rounds per turn allows.", "the turn's agents have had its {{rounds}} of tool calls (Tool rounds per turn)", [v("rounds", 'Tool rounds per turn, with the word: "40 rounds"', true)]),
  stopText(TEXT.stop.failed, "A call failed", "A call that failed: the provider's error, as it gave it; words of your own may go around it.", "{{error}}", [v("error", "the error, as the provider gave it", true)]),
  stopText(TEXT.stop.throttle, "Past a connection's throttle", "A call that needs more tokens than its connection's throttle lets through in a minute.", "the call needs {{tokens}}, more than this connection's throttle lets through in a minute ({{limit}})", [v("tokens", 'the tokens the call needs, with the word: "9000 tokens"', true), v("limit", "the tokens the throttle lets through in a minute", true)]),
  stopText(TEXT.stop.connectionUnread, "A connection that couldn't be read", "The runtime couldn't read its connections to find the agent's.", "the connection {{connection}} couldn't be read ({{error}})", [v("connection", "the connection's id; empty for the default connection"), v("error", "why", true)]),
  stopText(TEXT.stop.noDefault, "No connection to run on", "An agent with no connection of its own runs on the runtime's default connection, and there is none.", "there is no connection to run this agent on: it has none of its own, and the runtime has no default connection. Add one, or make one the default, on LumiAH's Runtime page under Connections"),
  stopText(TEXT.stop.noConnection, "A connection that is gone, and no default", "The agent's connection isn't one of the runtime's any more, and the runtime has no default connection to run it on instead.", "the connection {{connection}} is no longer one of the runtime's, and the runtime has no default connection to run this agent on instead: give it another in LumiAH's Settings, or make one the default on LumiAH's Runtime page under Connections", [v("connection", "the connection's id", true)]),
  stopText(TEXT.stop.answerRoom, "Too little room left for an answer", "A call that would have fewer answer tokens than Least answer room, because the agent's or its turn's answer tokens are nearly spent.", "only {{left}} are left of its answer tokens, fewer than Least answer room ({{floor}}): an answer written in them would be cut", [v("left", 'the answer tokens left, with the word: "40 tokens"', true), v("floor", "Least answer room", true)])
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
- The request: every message Lumiverse assembled for this reply, numbered, in order. A message marked as a preset instruction is the preset author's: the reply must achieve it. The rest is context: the character, the persona, the lore Lumiverse activated, and the chat's recent messages, ending with what the user just sent. After its messages come notes on what it holds: which lore entries are in the prompt and how each got there, an index of the entries that aren't (with the ids the lore tools take), which chat messages it holds word for word and what stands in for the rest, and, once the chat has one, the top of its chronicle: what the story has established, each line citing the messages it rests on.
- Your notes: what you did on your earlier turns in this chat, as a summary of the older ones and a receipt of each turn since. They are yours, not the story's. past_turn reads an earlier turn of yours in full.`,
      `How to work:
- Decide what this reply turns on: who is present, what was promised or left open, what the lore says about what is in play, and what the preset's instructions ask of this reply in particular.
- Use your tools for what the request and its notes don't show, going from coarse to exact. The chat tools reach every message of the chat, those too old to be in the request among them: chat_outline gives the story's parts, chat_about the trail of a name or a thing, chat_search and chat_grep find, chat_read and chat_around give the words themselves, each message with a citation such as [#412 a3f9c27e]. The lore tools reach every entry of the world books that apply, those Lumiverse didn't activate among them: lore_search, lore_about and lore_related find, lore_read reads entries whole, lore_index lists them all. preset_instructions lists the preset's instruction blocks.
- One call carries several queries or several ids, and several tools go in one answer when none of them depends on another's result. Don't read again what the request already shows. A result that says it was clipped, or that there is more, names the handle or the cursor to read on with.
- Stop looking once you have what the reply needs. Most replies need little.`,
      "You may also hold tools beyond the chat and its lore: the workspace (the workspace_ tools: files you keep for yourself from turn to turn; those pinned for you lead each turn's message), skills (skill_load), other agents to hand a task to (delegate) and jobs that go on after the reply (job_start). Each one's description says when it is worth using. None of them is needed for most replies.",
      "The chronicle is kept by a job, not by you, and never at the reply's cost. The line that ends the pinned chronicle says where it stands. Have it brought up to date only when that line says the chat is further past the chronicle than the user's setting allows, or when this turn changed something the chronicle states; then call job_start in the same answer as write_reply, with the agent and the task that line gives, never in a round of its own. No skill needs loading for it.",
      "Then call write_reply with your brief. The writer already has the whole prompt, so give it only what it would miss or get wrong without you: facts to keep straight (names, places, who knows what, what happened before), lore that bears on this moment, the thread to pick up, an instruction the last replies drifted from. Where write_reply offers add and drop, a lore entry the writer needs whole goes by its id in add, and one in the prompt that would mislead this reply in drop: the entry's own text is put into, or taken out of, what the writer is sent, so don't retype lore in the brief. The writer is sent the prompt as Lumiverse assembled it and nothing of yours but the brief: where guidance you were given bears on the prose, the brief has to carry it. Be specific, quote exact wording where it matters, and keep it short. Don't write the reply's prose, and don't restate the preset. When the prompt already holds everything, say so in one line. write_reply ends your turn: always end with it. An answer without it is handed to the writer as your brief, whatever it says, so never end on a plan or a remark."
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
- The request: every message Lumiverse assembled for this reply, numbered, in order. A message marked as a preset instruction is the preset author's: the reply must achieve it. The rest is context: the character, the persona, the lore Lumiverse activated, and the chat's recent messages, ending with what the user just sent. After its messages come notes on what it holds: which lore entries are in the prompt and how each got there, an index of the entries that aren't (with the ids the lore tools take), which chat messages it holds word for word and what stands in for the rest, and, once the chat has one, the top of its chronicle: what the story has established, each line citing the messages it rests on.
- Your notes: what you did on your earlier turns in this chat, as a summary of the older ones and a receipt of each turn since. They are yours, not the story's. past_turn reads an earlier turn of yours in full.`,
      `How to work:
- Decide what this reply turns on: who is present, what was promised or left open, what the lore says about what is in play, and what the preset's instructions ask of this reply in particular.
- Use your tools for what the request and its notes don't show, going from coarse to exact. The chat tools reach every message of the chat, those too old to be in the request among them: chat_outline gives the story's parts, chat_about the trail of a name or a thing, chat_search and chat_grep find, chat_read and chat_around give the words themselves, each message with a citation such as [#412 a3f9c27e]. The lore tools reach every entry of the world books that apply, those Lumiverse didn't activate among them: lore_search, lore_about and lore_related find, lore_read reads entries whole, lore_index lists them all. preset_instructions lists the preset's instruction blocks.
- One call carries several queries or several ids, and several tools go in one answer when none of them depends on another's result. Don't read again what the request already shows. A result that says it was clipped, or that there is more, names the handle or the cursor to read on with.
- Stop looking once you have what the reply needs. Most replies need little.`,
      "You may also hold tools beyond the chat and its lore: the workspace (the workspace_ tools: files you keep for yourself from turn to turn; those pinned for you lead each turn's message), skills (skill_load), other agents to hand a task to (delegate) and jobs that go on after the reply (job_start). Each one's description says when it is worth using. None of them is needed for most replies.",
      "The chronicle is kept by a job, not by you, and never at the reply's cost. The line that ends the pinned chronicle says where it stands. Have it brought up to date only when that line says the chat is further past the chronicle than the user's setting allows, or when this turn changed something the chronicle states; then call job_start among the tool calls of a round this reply needs anyway, with the agent and the task that line gives, never in a round of its own: a turn that needs no tool call leaves it to a later one. No skill needs loading for it.",
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
    vars: [v("kind", "why a reply is needed, in the words below", true), v("notes", "what changed about its notes since its last turn, and how the user directs the story where only the model's replies are its story, each ending in a blank line; nothing when there is none of it. Required: a summary of its notes reaches the agent only here when no later turn follows it", true), v("count", 'how many messages the request has, with the word: "42 messages"'), v("request", "the request's messages, each framed as below", true), v("ask", "what to do with it, in the words below", true)]
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
  { id: TEXT.main.noteContinued, group: MAIN, label: "The turn continued", note: "Leads a turn's message when it continues a reply the main agent already worked on: what it did then.", text: `You already worked on this reply before it was continued. What you did then:
{{receipt}}`, vars: [v("receipt", "the receipt of that work", true)] },
  { id: TEXT.main.replyOne, group: MAIN, label: "Notes dropped: one reply", note: "Fills {{replies}} in Notes dropped, and in its progress line, when one reply's notes were dropped.", text: "reply {{list}}", vars: [v("list", `the reply's number: "#12"`, true)] },
  { id: TEXT.main.replyMany, group: MAIN, label: "Notes dropped: several replies", note: "Fills {{replies}} in Notes dropped, and in its progress line, when several replies' notes were dropped.", text: "replies {{list}}", vars: [v("list", `the replies' numbers: "#12, #14"`, true)] },
  {
    id: TEXT.main.directed,
    group: MAIN,
    label: "The user directs the story",
    note: "A note of a turn's message where only the model's replies are the story (What counts as the story): the user's messages are directions from outside it.",
    text: "The user directs this story from outside it. Their messages are directions to you, not events of the story and not their character's words, and the directions they gave before this one are not part of its record: the chat tools leave the user's messages out.{{direction}}",
    vars: [v("direction", "the direction for this reply, or that there is none, in the words below; nothing where the user's newest message is left out too")]
  },
  { id: TEXT.main.direction, group: MAIN, label: "The direction for this reply", note: "Fills {{direction}} with the user's newest message, read from the chat, where it is given to the main agent (Your newest message: give it as the direction).", text: `

The direction for this reply:
{{text}}`, vars: [v("text", "the user's newest message", true)] },
  { id: TEXT.main.noDirection, group: MAIN, label: "No direction for this reply", note: "Fills {{direction}} where the chat ends with a reply, or with a message the user hid, so the user gave no direction for this one.", text: `

The user gave no direction for this reply: carry the story on from where it stands.`, vars: [] },
  {
    id: TEXT.main.turnNewest,
    group: MAIN,
    label: "A turn's message, with only the newest message",
    note: "What the main agent is sent each turn in a chat whose extension shows it only the user's newest message, not the whole request Lumiverse assembled.",
    text: `{{kind}}

{{notes}}The user's newest message:

{{message}}

{{ask}}`,
    vars: [v("kind", "why a reply is needed, in the words above", true), v("notes", "what changed about its notes since its last turn, each ending in a blank line; nothing when there is none of it. Required: a summary of its notes reaches the agent only here when no later turn follows it", true), v("message", "the user's newest message, framed as a message of the request is, or that there is none", true), v("ask", "what to do, in the words above", true)]
  },
  { id: TEXT.main.noNewest, group: MAIN, label: "No newest message", note: "Fills {{message}} where the request holds no message from the user.", text: "The request holds no message from the user: carry the story on from where it stands.", vars: [] },
  { id: TEXT.main.askReleases, group: MAIN, label: "What to do: release the reply", note: "Fills {{ask}} in a chat whose reply is only what its agents release: no writer writes it.", text: "Work out what this reply needs, then release it with reply_write, a passage at a time, or hand it to an agent with delegate and to_reply. Nothing else reaches the user.", vars: [] }
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
  { id: TEXT.session.receiptArgsClipped, group: SESSION, label: "A receipt: clipped arguments", note: "Ends a tool call's arguments a receipt keeps only the start of (Receipt length: arguments), as JSON cut where the length ran out: a file the call wrote, a long brief.", text: "{{text}}\u2026 (arguments of {{chars}} characters in all; past_turn with reply {{reply}} and step {{step}} reads them whole)", vars: [v("text", "the start of the arguments, as JSON", true), v("chars", "their whole length"), v("reply", "the reply's number in the chat"), v("step", "the step's number in the turn, as past_turn lists it")] },
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
  { id: TEXT.session.failedCut, group: SESSION, label: "No summary: cut off", note: "Why the notes weren't summarized, when the summary stopped at its limit.", text: "its summary was cut off at its limit (the summarizer's Answer per call)", vars: [] }
];
var TOOL_TEXTS = [
  ...toolTexts(TOOL.presetInstructions, "List the active preset's instruction blocks in order, those switched off marked: what the preset's author tells the model, as written in the preset, before Lumiverse fills in its macros. Give block to read one whole.", { block: "A block's id or name, to read that block whole.", cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.pastTurn, "Read or search an earlier turn of yours in full: every tool call you made with what came back, and your brief, where your notes keep only a receipt. Without arguments it lists your turns. Give reply to list that turn's steps; add step to read one whole; give grep to find the lines that hold some text, in that turn or, without reply, in your latest turns.", { reply: "The reply's number in the chat, as your receipts name it (reply #12).", step: "Which of the turn's steps to read whole, by its number in the turn's list.", grep: "Text to find, in any letter case: every line that holds it, with its reply, step and line.", cursor: CURSOR_ARG }),
  ...toolTexts(TOOL.writeReply, "Hand the writer your brief and have it write the reply, which goes to the user. This ends your turn: call it once, when you have what the reply needs, and call nothing else beside it.", { brief: "What the writer needs that the prompt doesn't already give it: facts to keep straight, lore that bears on this moment, the thread to pick up. Short and specific; no prose for the reply itself." }),
  ...toolTexts(TOOL.replyWrite, "Release a passage of the reply: it streams to the user at once, after what was released before. Call it again for the next passage; the reply is everything released, in order. Released text can't be taken back. Your turn ends when you answer.", { text: "The passage, exactly as the user should read it." })
];
var ANSWER_TEXTS = [
  { id: TEXT.answer.more, group: ANSWERS6, label: "There is more", note: "Ends a tool's answer that has more to give.", text: '[There is more: call {{tool}} again with the same arguments and cursor "{{cursor}}".]', vars: [v("tool", "the tool"), v("cursor", "where the next page starts", true)] },
  { id: TEXT.answer.end, group: ANSWERS6, label: "That is all", note: "Ends the last page of an answer that came in pages.", text: "[That is the end.]", vars: [] },
  { id: TEXT.answer.found, group: ANSWERS6, label: "What a search found", note: "Heads a search's or a listing's answer: how many it found and which of them this page shows.", text: "{{total}} found; showing {{from}} to {{to}}.", vars: [v("total", 'how many it found, with the word: "37 messages"', true), v("from", "the first shown, counted from 1"), v("to", "the last shown")] },
  { id: TEXT.answer.pastGrepNothing, group: ANSWERS6, label: "past_turn: grep found nothing", note: "past_turn's answer when no line of the turns it read holds the text.", text: "No line of {{where}} holds \u201C{{query}}\u201D. Try a shorter piece of it, or give reply to search one turn.", vars: [v("where", "the turns it read, in the words below"), v("query", "what was looked for", true)] },
  { id: TEXT.answer.pastWhereReply, group: ANSWERS6, label: "past_turn: where it looked, one turn", note: "Fills {{where}} when the grep read one turn.", text: "reply #{{reply}}", vars: [v("reply", "the reply's number", true)] },
  { id: TEXT.answer.pastWhereLatest, group: ANSWERS6, label: "past_turn: where it looked, the latest turns", note: "Fills {{where}} when the grep read the latest turns.", text: "your latest {{turns}}", vars: [v("turns", 'how many turns it read, with the word: "8 turns"', true)] },
  { id: TEXT.answer.badCursor, group: ANSWERS6, label: "A cursor that isn't one", note: "The answer to a cursor the tool never gave.", text: "\u201C{{cursor}}\u201D isn't a cursor {{tool}} gave. Pass the cursor exactly as the last answer wrote it, or leave it out to start at the beginning.", vars: [v("cursor", "the cursor given", true), v("tool", "the tool")] },
  { id: TEXT.answer.needs, group: ANSWERS6, label: "A missing argument", note: "The answer to a call that lacks an argument the tool can't do without.", text: "{{tool}} needs {{arg}}: {{what}} Call it again with {{arg}}.", vars: [v("tool", "the tool"), v("arg", "the argument's name", true), v("what", "what the argument is, from its description")] },
  { id: TEXT.answer.cut, group: ANSWERS6, label: "An item cut to fit", note: "Ends an item too long for one page of a listing.", text: "{{text}}\u2026 (cut to fit)", vars: [v("text", "the start of the item", true)] },
  { id: TEXT.answer.presetBlock, group: ANSWERS6, label: "preset_instructions: a block", note: "One instruction block in preset_instructions' answer.", text: "- [{{id}}] \u201C{{name}}\u201D ({{role}}{{flags}}, {{chars}} characters): {{excerpt}}", vars: [v("id", "the block's id", true), v("name", "its name in the preset"), v("role", "whose message it becomes"), v("flags", "that it is switched off, in the words below; nothing when it is on"), v("chars", "its length"), v("excerpt", "the start of its text")] },
  { id: TEXT.answer.presetRead, group: ANSWERS6, label: "preset_instructions: a block read", note: "preset_instructions' answer for one block: its text, or the part a page holds.", text: `Preset instruction \u201C{{name}}\u201D [{{id}}] ({{role}}{{flags}}), characters {{from}} to {{to}} of {{chars}}:
{{text}}`, vars: [v("name", "the block's name", true), v("id", "its id"), v("role", "whose message it becomes"), v("flags", "that it is switched off; nothing when it is on"), v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "the block's length"), v("text", "the text", true)] },
  { id: TEXT.answer.presetNoBlock, group: ANSWERS6, label: "preset_instructions: no such block", note: "preset_instructions' answer to a block the preset doesn't have among its instructions.", text: "The preset has no instruction block \u201C{{block}}\u201D. Its instruction blocks are: {{blocks}}. Give one of those, or leave block out to list them.", vars: [v("block", "the block asked for", true), v("blocks", "the instruction blocks, by name and id")] },
  { id: TEXT.answer.presetNone, group: ANSWERS6, label: "preset_instructions: none", note: "preset_instructions' answer when the preset has no instruction block, or the chat has no preset.", text: "This reply's preset has no instruction blocks to list. The instructions that reached the request are marked in it.", vars: [] },
  { id: TEXT.answer.presetOff, group: ANSWERS6, label: "A block switched off", note: "Marks a block that is switched off in the preset, in preset_instructions' answers.", text: ", switched off", vars: [] },
  { id: TEXT.answer.pastTurns, group: ANSWERS6, label: "past_turn: your turns", note: "Leads past_turn's answer without arguments: the turns it can read, one line each after it.", text: "Your earlier turns in this chat, oldest first. Give reply to list one turn's steps.", vars: [] },
  { id: TEXT.answer.pastTurnLine, group: ANSWERS6, label: "past_turn: one turn", note: "One turn in past_turn's list of turns.", text: "- {{told}} You took {{count}}.", vars: [v("told", "what the turn was for", true), v("count", 'how many steps it took, with the word: "5 steps"')] },
  { id: TEXT.answer.pastTurn, group: ANSWERS6, label: "past_turn: a turn's steps", note: "Leads past_turn's answer for a reply: what the turn was for; its steps follow, one line each.", text: `{{told}}
Its steps, in full as they were; read one whole with step:`, vars: [v("told", "what the turn was for", true)] },
  { id: TEXT.answer.pastStep, group: ANSWERS6, label: "past_turn: one step", note: "One step in past_turn's list.", text: "{{n}}. {{what}} ({{chars}} characters): {{first}}", vars: [v("n", "its number in the turn", true), v("what", "what the step is: a tool call with its arguments, a note, the reply, a stop"), v("chars", "how long its text is"), v("first", "the start of its text")] },
  { id: TEXT.answer.pastRead, group: ANSWERS6, label: "past_turn: a step read", note: "past_turn's answer for one step: its text, or the part a page holds.", text: `Reply #{{reply}}, step {{n}}: {{what}}, characters {{from}} to {{to}} of {{chars}}:
{{text}}`, vars: [v("reply", "the reply's number", true), v("n", "the step's number"), v("what", "what the step is"), v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "how long its text is"), v("text", "the text", true)] },
  { id: TEXT.answer.pastLine, group: ANSWERS6, label: "past_turn: a line found", note: "One line past_turn's grep found.", text: "- reply #{{reply}}, step {{n}}, line {{line}}: {{text}}", vars: [v("reply", "the reply's number", true), v("n", "the step's number"), v("line", "the line's number in the step"), v("text", "the line, around what was found", true)] },
  { id: TEXT.answer.pastNone, group: ANSWERS6, label: "past_turn: no turns", note: "past_turn's answer when the main agent has no earlier turn in the chat.", text: "You have no earlier turn in this chat: this is your first, or your notes from before were dropped. Work from the request and your other tools.", vars: [] },
  { id: TEXT.answer.pastNoTurn, group: ANSWERS6, label: "past_turn: no such turn", note: "past_turn's answer for a reply that is no turn of the main agent's.", text: "Reply #{{reply}} is no turn of yours on this chat. Your turns are replies {{replies}}. Give one of those.", vars: [v("reply", "the reply asked for", true), v("replies", "the replies that are")] },
  { id: TEXT.answer.pastNoStep, group: ANSWERS6, label: "past_turn: no such step", note: "past_turn's answer for a step number the turn doesn't have.", text: "Reply #{{reply}} has {{count}}: give step 1 to {{last}}.", vars: [v("reply", "the reply's number", true), v("count", 'how many steps it has, with the word: "5 steps"'), v("last", "its last step's number")] },
  { id: TEXT.answer.pastSaid, group: ANSWERS6, label: "past_turn: a note", note: "Names a step that is something the main agent wrote beside its tool calls.", text: "a note of yours", vars: [] },
  { id: TEXT.answer.pastCall, group: ANSWERS6, label: "past_turn: a tool call", note: "Names a step that is a tool call: its text is what came back.", text: "{{tool}} {{args}}", vars: [v("tool", "the tool", true), v("args", "its arguments, as JSON")] },
  { id: TEXT.answer.pastFailed, group: ANSWERS6, label: "past_turn: a failed tool call", note: "Names a step that is a tool call that failed.", text: "{{tool}} {{args}}, which failed", vars: [v("tool", "the tool", true), v("args", "its arguments, as JSON")] },
  { id: TEXT.answer.pastReply, group: ANSWERS6, label: "past_turn: the reply", note: "Names the step in which the main agent wrote the reply itself. The reply isn't kept: it is in the chat.", text: "the reply, which you wrote yourself (not kept here: it is chat message #{{reply}}, {{chars}} characters)", vars: [v("reply", "the reply's number in the chat"), v("chars", "the reply's length")] },
  { id: TEXT.answer.pastStop, group: ANSWERS6, label: "past_turn: a stop", note: "Names the step at which the main agent stopped short.", text: "where you stopped short", vars: [] },
  { id: TEXT.answer.replyBusy, group: ANSWERS6, label: "write_reply: already writing", note: "write_reply's answer to a second call while the writer is at work on the first.", text: "The writer is already writing this reply from your other write_reply call. Call write_reply once.", vars: [] },
  { id: TEXT.answer.replyFailed, group: ANSWERS6, label: "write_reply: the writer failed", note: "write_reply's answer when the writer's call failed before any of the reply was sent.", text: "The writer couldn't write the reply: {{reason}}. Nothing was sent to the user. Call write_reply again to try once more.", vars: [v("reason", "why", true)] },
  { id: TEXT.answer.replyNoBrief, group: ANSWERS6, label: "write_reply: no brief", note: "write_reply's answer to a call without a brief.", text: "write_reply needs brief: what the writer needs that the prompt doesn't already give it. When the prompt holds everything, say that in a line. Call write_reply again with brief.", vars: [] },
  { id: TEXT.answer.replyEmpty, group: ANSWERS6, label: "write_reply: an empty reply", note: "Fills {{reason}} in The writer failed, and the turn's error, when the writer's model answered with nothing.", text: "its model answered with nothing", vars: [] },
  { id: TEXT.answer.replyReleased, group: ANSWERS6, label: "write_reply: the reply was released already", note: "write_reply's answer once part of the reply was released with reply_write: no writer writes after it.", text: "Not handed to the writer: you released part of this reply with reply_write, so the reply is yours to finish. Go on with reply_write, or end your turn.", vars: [] },
  { id: TEXT.answer.released, group: ANSWERS6, label: "reply_write: released", note: "reply_write's answer once its passage reached the user.", text: "Released: {{chars}} characters reached the user. The reply holds {{total}} characters now. Release the next passage, or end your turn.", vars: [v("chars", "the passage's length", true), v("total", "the reply's length so far")] },
  { id: TEXT.answer.releaseWriter, group: ANSWERS6, label: "reply_write: the writer has the reply", note: "The answer of reply_write, and of delegate with to_reply, once the writer is writing the reply or has written it.", text: "Not released: the writer is writing this reply, or has written it, so nothing more can go into it.", vars: [] },
  { id: TEXT.answer.releaseHeld, group: ANSWERS6, label: "reply_write: another agent's answer is streaming", note: "The answer of reply_write, and of delegate with to_reply, while a sub-agent's answer streams into the reply.", text: "Not released: another agent's answer is streaming into the reply now. Wait for that call to end, then release yours.", vars: [] },
  { id: TEXT.answer.releaseUnchecked, group: ANSWERS6, label: "reply_write: the extension didn't say", note: "reply_write's answer when the extension that checks each passage gave no word on it in time, or gave one that isn't a word: nothing goes out unchecked.", text: "Not released: the check on each passage didn't answer, so nothing was sent. Try again.", vars: [] },
  { id: TEXT.answer.releaseEnded, group: ANSWERS6, label: "reply_write: the reply has ended", note: "The answer of reply_write, and of delegate with to_reply, once the turn's reply has ended or the turn was stopped.", text: "Not released: this reply has ended.", vars: [] }
];
var PROGRESS_TEXTS = [
  { id: TEXT.progress.session, group: PROGRESS, label: "Notes carried", note: "The first line a turn writes into the reply's thinking block: what the main agent carries from earlier turns.", text: "LumiAH: the main agent carries its notes from {{turns}}.", vars: [v("turns", 'how many earlier turns, with the word: "4 earlier turns"', true)] },
  { id: TEXT.progress.sessionSummary, group: PROGRESS, label: "Notes carried, after a summary", note: "The first line of a turn whose main agent carries a summary of its older turns.", text: "LumiAH: the main agent carries its notes from {{turns}}, after a summary of the ones before.", vars: [v("turns", 'how many earlier turns, with the word: "4 earlier turns"', true)] },
  { id: TEXT.progress.fresh, group: PROGRESS, label: "No notes yet", note: "The first line of a turn whose main agent carries nothing.", text: "LumiAH: the main agent starts without notes from earlier turns.", vars: [] },
  { id: TEXT.progress.dropped, group: PROGRESS, label: "Notes dropped", note: "A line for notes that no longer fit the chat.", text: "An earlier message changed, so its notes from {{replies}} were dropped.", vars: [v("replies", 'the replies: "reply #12" or "replies #12, #14"', true)] },
  { id: TEXT.progress.compacting, group: PROGRESS, label: "Summarizing", note: "A line while the main agent's notes are summarized.", text: "Summarizing its notes from {{turns}}\u2026", vars: [v("turns", 'how many turns fold into the summary, with the word: "6 turns"', true)] },
  { id: TEXT.progress.compacted, group: PROGRESS, label: "Summarized", note: "A line once the summary is made.", text: "Summarized {{folded}}; the latest {{kept}} stay whole.", vars: [v("folded", 'how many turns the summary took in, with the word: "6 turns"', true), v("kept", "how many stay whole")] },
  { id: TEXT.progress.notCompacted, group: PROGRESS, label: "Not summarized", note: "A line when the summary couldn't be made: the notes go on whole.", text: "Its notes weren't summarized ({{reason}}); they go on whole.", vars: [v("reason", "why", true)] },
  { id: TEXT.progress.compactionHeld, group: PROGRESS, label: "Not summarized again yet", note: "A line while a rollback holds the notes whole: they are past Summarize past, and aren't summarized until they have grown by After a rollback or you ask for it.", text: "Its notes stay whole after your rollback: they are summarized again once they have grown by {{margin}} tokens (After a rollback), or when you ask for it.", vars: [v("margin", "After a rollback", true)] },
  { id: TEXT.progress.call, group: PROGRESS, label: "A tool call", note: "A line for each tool the main agent calls.", text: "{{tool}} {{args}}", vars: [v("tool", "the tool", true), v("args", "its arguments, shortened")] },
  { id: TEXT.progress.writing, group: PROGRESS, label: "Writing", note: "A line when the writer starts on the reply from a brief the main agent gave with write_reply.", text: "Writing the reply from the main agent's brief\u2026", vars: [] },
  { id: TEXT.progress.answerAsBrief, group: PROGRESS, label: "Writing from an answer taken as the brief", note: "A line when the main agent ended without calling write_reply: its last answer is handed to the writer in the brief's place.", text: "The main agent ended without calling write_reply; the writer is given its last answer as the brief.", vars: [] },
  { id: TEXT.progress.writingAlone, group: PROGRESS, label: "Writing without a brief", note: "A line when the writer starts with no brief, because the main agent stopped short of one.", text: "The main agent stopped before its brief ({{reason}}); the writer writes from your preset alone.", vars: [v("reason", "why the main agent stopped", true)] },
  { id: TEXT.progress.writingFailed, group: PROGRESS, label: "Writing after a failure", note: "A line when the writer starts with no brief because something of LumiAH's failed before the main agent gave one: its settings or its notes couldn't be read, or its own run broke.", text: "The main agent had no part in this reply ({{reason}}); the writer writes from your preset alone.", vars: [v("reason", "what failed", true)] },
  { id: TEXT.progress.recordFailed, group: PROGRESS, label: "A turn's notes not stored", note: "A line when a turn's notes couldn't be stored, and what the live view says of it: the reply stands, and the main agent won't remember the turn.", text: "This turn's notes couldn't be stored ({{error}}): the reply stands, but the main agent won't remember this turn.", vars: [v("error", "why", true)] },
  { id: TEXT.progress.retry, group: PROGRESS, label: "Trying a call again", note: "A line each time a model call that failed in passing is made again, whichever of the turn's agents made it.", text: "A model call failed ({{reason}}); trying again, {{attempt}} of {{retries}}\u2026", vars: [v("reason", "the failure, in the provider's own words", true), v("attempt", "which try this is"), v("retries", "how many Settings allow")] },
  { id: TEXT.progress.stopped, group: PROGRESS, label: "Stopped", note: "A line when the turn ends without a reply.", text: "No reply: {{reason}}.", vars: [v("reason", "why", true)] },
  { id: TEXT.progress.turnStopped, group: PROGRESS, label: "Why: the turn was stopped", note: "The reason a turn gives when it was stopped before its agents could say why.", text: "the turn was stopped", vars: [] },
  { id: TEXT.progress.dueWait, group: PROGRESS, label: "Waiting for jobs due", note: "A line when a turn waits at its start for the jobs started as due by it.", text: "Waiting for {{jobs}} due by this turn\u2026", vars: [v("jobs", 'how many, with the word: "2 jobs"', true)] },
  { id: TEXT.progress.nothingReleased, group: PROGRESS, label: "Why: nothing was released", note: "Why a turn failed in a chat whose reply is only what its agents release, when they released none of it. No writer writes in their place there.", text: "the agents ended without releasing any of the reply, and in this chat no writer writes it in their place", vars: [] },
  { id: TEXT.progress.leadMissing, group: PROGRESS, label: "Why: the agent that leads isn't there", note: "Why a turn didn't start in a chat whose extension names the agent that leads its replies, when there is no such agent. No other agent leads in its place.", text: "{{extension}} names {{agent}} to lead this chat's replies, and there is no such agent, so this reply wasn't started. {{extension}} has to supply it: update it, or tell its author", vars: [v("extension", "the extension's name"), v("agent", "the agent's id", true)] },
  { id: TEXT.progress.leadOff, group: PROGRESS, label: "Why: the agent that leads is switched off", note: "Why a turn didn't start in a chat whose extension names the agent that leads its replies, when that agent is switched off. No other agent leads in its place.", text: "{{extension}} names {{agent}} to lead this chat's replies, and it is switched off, so this reply wasn't started. Switch it on on the Agents page, then try again", vars: [v("extension", "the extension's name"), v("agent", 'the agent, by its name and its id: "Author (author)"', true)] },
  { id: TEXT.progress.leadLate, group: PROGRESS, label: "Why: the agent that leads wasn't given in time", note: "Why a turn didn't start in a chat whose extension names the agent that leads its replies, when the extension didn't give its agents within Wait for the extension. No other agent leads in its place.", text: "{{extension}} names {{agent}} to lead this chat's replies, and it isn't in this run: {{extension}} didn't give its agents within {{wait}}, so this reply wasn't started. Try again; if it keeps happening, give {{extension}} longer with {{setting}}", vars: [v("extension", "the extension's name"), v("agent", "the agent's id", true), v("wait", 'how long it was waited for: "10 seconds"'), v("setting", "Wait for the extension, with where it is changed", true)] },
  { id: TEXT.progress.leadUnread, group: PROGRESS, label: "Why: the agent that leads couldn't be had", note: "Why a turn didn't start in a chat whose extension names the agent that leads its replies, when asking the extension for its agents failed. No other agent leads in its place.", text: "{{extension}} names {{agent}} to lead this chat's replies, and it isn't in this run: {{extension}}'s agents couldn't be had ({{error}}), so this reply wasn't started. Try again in a moment", vars: [v("extension", "the extension's name"), v("agent", "the agent's id", true), v("error", "why, in the extension's or the link's words", true)] },
  { id: TEXT.progress.claimLate, group: PROGRESS, label: "Why: no word on the chat in time", note: "Why a reply, a job's run or a conversation's turn about a chat didn't start, when the extension didn't say within Wait for the extension whether it answers that chat itself: run as one of LumiAH's own, the chat could be answered wrongly.", text: "{{extension}} didn't say within {{wait}} whether it answers this chat itself, so this wasn't started: run as one of LumiAH's own chats, it could be answered wrongly. Try again; if it keeps happening, give {{extension}} longer with {{setting}}", vars: [v("extension", "the extension's name", true), v("wait", 'how long it was waited for: "10 seconds"'), v("setting", "Wait for the extension, with where it is changed", true)] },
  { id: TEXT.progress.claimUnread, group: PROGRESS, label: "Why: no word on the chat", note: "Why a reply, a job's run or a conversation's turn about a chat didn't start, when asking the extension whether it answers that chat itself failed: run as one of LumiAH's own, the chat could be answered wrongly.", text: "{{extension}} couldn't say whether it answers this chat itself ({{error}}), so this wasn't started: run as one of LumiAH's own chats, it could be answered wrongly. Try again in a moment", vars: [v("extension", "the extension's name", true), v("error", "why, in the extension's or the link's words", true)] },
  { id: TEXT.progress.agentsLate, group: PROGRESS, label: "The extension's agents missing: not given in time", note: "What a run's live view says when the extension didn't give its agents and skills within Wait for the extension: the run goes on without them where none of them is needed. Why a job or a conversation whose agent is the extension's didn't start, too.", text: "{{extension}}'s agents and skills are missing from this run: it didn't give them within {{wait}}. If it keeps happening, give it longer with {{setting}}", vars: [v("extension", "the extension's name", true), v("wait", 'how long it was waited for: "10 seconds"'), v("setting", "Wait for the extension, with where it is changed", true)] },
  { id: TEXT.progress.agentsUnread, group: PROGRESS, label: "The extension's agents missing: couldn't be had", note: "What a run's live view says when asking the extension for its agents and skills failed: the run goes on without them where none of them is needed. Why a job or a conversation whose agent is the extension's didn't start, too.", text: "{{extension}}'s agents and skills are missing from this run: they couldn't be had ({{error}})", vars: [v("extension", "the extension's name", true), v("error", "why, in the extension's or the link's words", true)] }
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
var TEXT_DEFS = [...MAIN_TEXTS, ...REQUEST_TEXTS, ...WRITER_TEXTS, ...SESSION_TEXTS, ...AGENTS_TEXTS, ...WORKSPACE_TEXTS, ...JOBS_TEXTS, ...APPROVAL_TEXTS, ...SIDE_TEXTS, ...SPEND_TEXTS, ...BOOK_TEXTS, ...RECALL_TEXTS, ...TOOL_TEXTS, ...ANSWER_TEXTS, ...RUNTIME_TEXTS, ...STOP_TEXTS, ...PROGRESS_TEXTS, ...WORD_TEXTS];
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

// src/link/contract.ts
var LINK_VERSION = 2;
var LINK = "lumiah-link";
var EXTENSION_IDENTIFIER = "lumi_ah";
var MODEL_ID = "lumiah";
function loopbackModel(identifier) {
  return identifier === EXTENSION_IDENTIFIER ? MODEL_ID : `${MODEL_ID}-${identifier}`;
}
function sameBase(a, b) {
  const at = (url) => url.trim().replace(/\/+$/, "").toLowerCase();
  return at(a) === at(b);
}
function loopsBack(connection, model, bases) {
  if (connection.model === model)
    return true;
  if (connection.model === MODEL_ID || connection.model.startsWith(`${MODEL_ID}-`))
    return false;
  return bases.some((base) => sameBase(base, connection.url));
}
var TAG_PARAM = "lumiah_turn";
var KEY_PREFIX = "lah_";
var KEY_FORM = new RegExp(`^${KEY_PREFIX}[0-9a-f]{64}$`);
var RUNTIME_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
var STREAM_ID = /^[0-9a-f]{32}$/;
var BLOB_HASH = /^[0-9a-f]{64}$/;
var DOC_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]{1,128}(?:\/[A-Za-z0-9._-]{1,128}){0,7}$/;
var DOC_PREFIX = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?:[A-Za-z0-9._-]{1,128}\/){0,7}[A-Za-z0-9._-]{0,128}$/;
var MARK_PATH = "mirror.json";
var MIRROR_ID = /^[0-9a-f]{32}$/;
var FRAME_LIMIT = 4 * 1024 * 1024;
var EXTENSION_MEMBERS = ["definitions", "claim", "writerRequest", "runBegan", "agentModel", "releasing", "released", "replyWritten", "runEnded"];
var OWN_BACKEND = { name: "LumiAH", connection: "LumiAH" };
var COPY_EVENTS = ["MESSAGE_SENT", "MESSAGE_EDITED", "MESSAGE_DELETED", "MESSAGE_SWIPED", "SWIPE_EDITED", "CHAT_CHANGED", "CHAT_DELETED", "CHAT_FORKED", "WORLD_BOOK_CHANGED", "WORLD_BOOK_DELETED", "WORLD_BOOK_ENTRY_CHANGED", "WORLD_BOOK_ENTRY_DELETED", "WORLD_BOOK_LIBRARY_CHANGED"];
var COPY_PERMISSIONS = ["chats", "chat_mutation", "world_books"];
function versionWords(runtime, extension, name = "LumiAH") {
  if (runtime < extension)
    return `This runtime speaks link version ${runtime} and ${name} ${extension}: update the runtime by running its start line on ${name}'s Runtime page again.`;
  return `This runtime speaks link version ${runtime} and ${name} ${extension}: update ${name} in Lumiverse (Extensions \u2192 ${name} \u2192 Update), then restart the runtime.`;
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
var MI = 1024 * 1024;
var CEILINGS = Object.freeze({
  joinMaxUnits: 64 * MI,
  partStaleMs: 5 * 60000,
  joinFrames: 16,
  joinHeldUnits: 64 * MI,
  joinFramesTotal: 64,
  joinHeldUnitsTotal: 256 * MI,
  streamKeepMs: 60 * 60000,
  streams: 256,
  streamsTotal: 2048,
  nameChars: 200,
  jobsActive: 512,
  jobsActiveTotal: 8192,
  liveEvents: 50000,
  liveRunning: 64,
  liveChats: 256,
  liveEventsTotal: 2000000,
  liveRunsTotal: 4096,
  tagsHeld: 1024,
  tagsKnown: 8192,
  recordsWaiting: 512,
  turnsTotal: 8192,
  verdictsTotal: 65536,
  recordsTotal: 4096,
  generationsUnowned: 1024
});
var RUNTIME_DEFAULTS = Object.freeze({
  commentMs: 5000,
  progressMs: 60000,
  stallMs: 30 * 60000,
  lostMs: 120000,
  probeMs: 15000,
  heartbeatMs: 60000,
  silentMs: 45000,
  crashMs: 1e4,
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
  stopAskMs: 5000,
  joinMaxUnits: 32 * 1024 * 1024,
  partStaleMs: 60000,
  storeWaitMs: 60000,
  lumiverseMs: 60000,
  copyReadMs: 15000,
  copyChars: 32000000,
  providerMs: 60000,
  answerSilentMs: 5 * 60000
});
var TRANSPORT_DEFAULTS = Object.freeze({
  history: Object.freeze({ keep: "last", count: 40 }),
  tags: Object.freeze({ lifeMs: 2 * 60 * 60000, held: 256, checkMs: 3000, known: 1024 }),
  streams: Object.freeze({ keepMs: 10 * 60000 }),
  connections: Object.freeze({ oneToolAtATime: Object.freeze([]) }),
  mcp: Object.freeze({ callMs: 30000 }),
  jobs: Object.freeze({ paused: false }),
  pages: Object.freeze({ noticesKept: 200, askMs: 30000, noticeChars: 400, settleMs: 5000, proxyMs: 1e4 }),
  link: Object.freeze({ quietMs: 120000, relays: 8, connectionMs: 15000, joinMaxUnits: 32 * 1024 * 1024, partStaleMs: 60000, joinFrames: 8, joinHeldUnits: 64 * 1024 * 1024 }),
  live: Object.freeze({ events: 20000, page: 500, chats: 32, lostMs: 30000 }),
  anchors: Object.freeze({ waitMs: 10 * 60000, held: 64 }),
  sessions: Object.freeze({ previewChars: 120, page: 50, pathsKept: 16, pathMs: 5 * 60000 }),
  runtime: RUNTIME_DEFAULTS
});
var ms = (title, description, minimum, maximum) => ({ type: "integer", title, description, minimum, maximum, "x-unit": "ms" });
var whole3 = (title, description, minimum, maximum, unit) => ({ type: "integer", title, description, minimum, maximum, ...unit !== undefined ? { "x-unit": unit } : {} });
var DAY_MS = 24 * 60 * 60000;
var TRANSPORT_RETIRED = [["builtin"], ["streams", "coalesceMs"], ["runtime", "resendMs"], ["runtime", "resendTries"], ["runtime", "ackEvery"]];
var TRANSPORT_SCHEMA = {
  type: "object",
  title: "Transport",
  description: "How LumiAH carries a reply between this extension and your runtime beside Lumiverse, over its link. The defaults suit a runtime on the same machine as Lumiverse.",
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
        count: whole3("Latest messages kept", "How many of the chat's latest messages stay in the prompt when only the latest are kept.", 1, 1e4, "messages")
      }
    },
    tags: {
      type: "object",
      title: "Turn tags",
      description: "The single-use tag the prompt interceptor puts on each generation LumiAH answers.",
      additionalProperties: false,
      properties: {
        lifeMs: ms("A tag's life", "How long after a generation starts its tag still admits its request.", 60000, DAY_MS),
        held: whole3("Tags remembered", "The most tags remembered at once; the oldest is let go first.", 8, CEILINGS.tagsHeld),
        checkMs: ms("Loopback check", "How long a reply waits while it is checked whether its connection is the loopback, when that isn't known yet. Past it, a chat not known to be answered here goes on untouched.", 100, 9000),
        known: whole3("Connections remembered", "How many connections and chats are remembered as answered here or not; the oldest is let go first.", 16, CEILINGS.tagsKnown)
      }
    },
    streams: {
      type: "object",
      title: "Streams",
      description: "How the outcome of a tool run in this extension, or of a tool call held for your word, travels from this extension to the runtime.",
      additionalProperties: false,
      properties: {
        keepMs: ms("Unacknowledged chunks kept", "How long a finished stream's chunks are kept for an acknowledgement that never came.", 1e4, CEILINGS.streamKeepMs)
      }
    },
    connections: {
      type: "object",
      title: "Connections",
      description: "The agents run on the runtime's own connections (Runtime \u2192 Connections): an agent with none of its own, or whose connection is gone, runs on the runtime's default. What LumiAH must know of a connection that its provider doesn't say.",
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
    mcp: {
      type: "object",
      title: "MCP servers",
      description: "The tools of the MCP servers you set up in Lumiverse, which LumiAH's agents may be given. Each tool is named mcp:<server>:<tool>, and every call goes through Lumiverse. A server, or one tool of it, is switched off on the Agents page.",
      additionalProperties: false,
      properties: {
        callMs: ms("Call time", "How long one call of an MCP tool may take before it is given up.", 1000, 120000)
      }
    },
    jobs: {
      type: "object",
      title: "Jobs",
      description: "The switch that holds every job. Whether jobs run at all, how many at once and what each may spend are with the core's settings, under Jobs.",
      additionalProperties: false,
      properties: {
        paused: { type: "boolean", title: "Hold all jobs", description: "While on, every running job waits at its agents' next round, and a job that begins waits at its first. Switch it off and they go on." }
      }
    },
    pages: {
      type: "object",
      title: "Pages",
      description: "What LumiAH's pages keep, and how long they wait for the runtime.",
      additionalProperties: false,
      properties: {
        noticesKept: whole3("Notices kept", "How many notices of jobs (finished, failed, interrupted, waiting on you) are kept until you dismiss them. Past it the oldest go first.", 10, 2000),
        askMs: ms("Runtime wait", "How long a page waits for the runtime to do what it asked of it (write a file, start a job, read a list) before it says the runtime didn't answer.", 1000, 600000),
        noticeChars: whole3("Notice length", "How much of a job's opening a notice keeps. The job's page shows it whole.", 40, 4000, "characters"),
        settleMs: ms("Wait for the runtime's saves", "How long a page that reads what your runtime saved (Sessions, a turn's transcript, a call's prompt) waits for the runtime to finish sending it to this extension's storage. Past it the page shows what the storage holds, and says so.", 500, 60000),
        proxyMs: ms("Proxy road wait", "How long a page's request waits on the faster road (Lumiverse's own proxy to your runtime, used once you grant the permission cors_proxy) before it is sent over the link as well. Whichever answers first is taken, and the runtime does the work once. At most 30 seconds: Lumiverse's proxy waits no longer.", 1000, 30000)
      }
    },
    link: {
      type: "object",
      title: "Link",
      description: "The extension's end of the link to your runtimes.",
      additionalProperties: false,
      properties: {
        quietMs: ms("Quiet after", "How long without a word from a runtime before the Runtime page shows it as quiet.", 1e4, DAY_MS),
        relays: whole3("Runtimes per account", "The runtimes one account may have registered at once.", 1, 64, "runtimes"),
        connectionMs: ms("Wait for the connection", "How long minting a key waits for your linked runtime to make the loopback connection.", 1000, 5 * 60000),
        joinMaxUnits: whole3("Largest frame joined", "The largest frame the extension puts together from parts: a stored transcript or a model call's prompt may be this long.", MI, CEILINGS.joinMaxUnits, "characters"),
        partStaleMs: ms("Parts kept", "How long the first parts of a frame wait for the rest.", 1000, CEILINGS.partStaleMs),
        joinFrames: whole3("Frames joined at once", "The most frames sent in parts that the extension puts together at once for one account. A runtime sends a large frame's parts one after another, so only frames left unfinished add up: a frame begun past this is refused.", 1, CEILINGS.joinFrames, "frames"),
        joinHeldUnits: whole3("Characters held while joining", "The most characters the extension holds, for one account, of frames still coming in parts. A frame that would pass it is refused. Keep it at least as large as the largest frame joined.", MI, CEILINGS.joinHeldUnits, "characters")
      }
    },
    live: {
      type: "object",
      title: "Live view",
      description: "What the extension keeps of each chat's current turn for the Live page.",
      additionalProperties: false,
      properties: {
        events: whole3("Events kept per turn", "The most events kept of a chat's live turn; past it the reply's later events stay out of the Live page (its stored transcript is whole all the same).", 100, CEILINGS.liveEvents, "events"),
        page: whole3("Events per read", "The most events one read of a live view or a stored transcript answers.", 10, 1e4, "events"),
        chats: whole3("Chats kept", "The most chats whose latest turn is kept for the Live page.", 1, CEILINGS.liveChats, "chats"),
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
        held: whole3("Records waiting", "The most records waiting for their replies at once.", 1, CEILINGS.recordsWaiting, "records")
      }
    },
    sessions: {
      type: "object",
      title: "Sessions page",
      additionalProperties: false,
      properties: {
        previewChars: whole3("Reply preview", "How much of a reply's opening the Sessions page shows to find it by.", 0, 2000, "characters"),
        page: whole3("Turns per page", "The most turns one page of the Sessions list holds.", 1, 500, "turns"),
        pathsKept: whole3("Chats kept in memory", "The most chats whose list of messages (without their text) is kept in memory until the chat changes, so a reply reads its chat once. 0 keeps none: every read asks Lumiverse again.", 0, 1024, "chats"),
        pathMs: ms("Keep a chat's list for", "How long such a list is kept at most, even while Lumiverse says nothing of the chat changing. After that the chat is read again. 0 keeps none: every read asks Lumiverse again.", 0, DAY_MS)
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
        stallMs: ms("Stream stalled after", "A tool's run in this extension with nothing from it for this long is given up. A tool call held for your word waits as long as it takes.", 1e4, DAY_MS),
        lostMs: ms("Extension lost after", "How long this extension may stay out of the runtime's reach during a reply before the reply ends.", 5000, 60 * 60000),
        probeMs: ms("Ping while working", "How often the runtime pings while it answers a reply.", 1000, 5 * 60000),
        heartbeatMs: ms("Ping while idle", "How often the runtime pings while it answers none.", 5000, 60 * 60000),
        silentMs: ms("Silent after", "How long a request may go unanswered, with nothing heard meanwhile, before this extension counts as silent.", 5000, 60 * 60000),
        crashMs: ms("Crashed after", "After Lumiverse reports an error in this extension, how long silence makes it a crash.", 1000, 5 * 60000),
        requestMs: ms("Request wait", "How long each request to this extension waits for its answer.", 5000, 60 * 60000),
        socketPingMs: ms("Socket ping", "How often the runtime pings Lumiverse's event socket. Lumiverse closes one idle for two minutes.", 5000, 110000),
        modelsWaitMs: ms("Model list wait", "How long the connection's model list, and the key check of a request with no turn tag, wait for the link to come up.", 1000, 5 * 60000),
        maxBodyBytes: whole3("Largest request", "The largest request the runtime reads from Lumiverse. A larger one is refused: lower the connection's context size, or the history cutoff.", 64 * 1024, 64 * 1024 * 1024, "bytes"),
        drainMs: ms("Wait before restart", "How long setting the runtime up again waits for replies under way before it restarts it.", 0, 60 * 60000),
        drainPollMs: ms("Restart poll", "How often it asks meanwhile.", 500, 60000),
        connectionsRead: whole3("Connections read", "How many of your connections the runtime reads when it looks for the loopback's.", 10, 200, "connections"),
        reconnectMs: ms("First reconnect wait", "The first wait before the runtime reconnects to Lumiverse; each failure doubles it.", 100, 60000),
        reconnectMaxMs: ms("Longest reconnect wait", "The longest wait between two tries to reconnect.", 1000, 60 * 60000),
        sessionCheckMs: ms("Session check", "How often the runtime asks Lumiverse about its session, which renews it.", 60000, 7 * DAY_MS),
        stopGraceMs: ms("Stop grace", "How long a stopping runtime waits for its last words to go out.", 0, 30000),
        traceMs: ms("Trace held back", "How long the runtime holds trace events to send them together.", 0, 5000),
        traceBatch: whole3("Trace events per request", "The most trace events one request carries to the Live page.", 1, 4096, "events"),
        traceHeld: whole3("Trace events held", "The most trace events held while they can't be sent; past it a reply's later events stay out of the Live page (its stored transcript is whole all the same).", 100, 1e6, "events"),
        turnWaitMs: ms("Wait for the earlier reply", "How long a new reply waits for the chat's earlier one to stop before it is refused.", 1000, 10 * 60000),
        stopAskMs: ms("Wait for Lumiverse's Stop", "How long Lumiverse may take to answer when the runtime asks it to stop a reply you stopped in the Live page, before the runtime ends the reply itself.", 500, 60000),
        joinMaxUnits: whole3("Largest frame joined", "The largest frame the runtime puts together from parts.", 1024 * 1024, 256 * 1024 * 1024, "characters"),
        partStaleMs: ms("Parts kept", "How long the first parts of a frame wait for the rest.", 1000, 60 * 60000),
        storeWaitMs: ms("Storage wait", "How long the runtime waits for this extension's storage to take what it saved, wherever something waits on it: a reply's record, a page that reads it, the runtime stopping. Past it that goes on without it. Nothing is lost: it stays on the runtime's disk and goes to the storage as soon as it can.", 1000, 60 * 60000),
        lumiverseMs: ms("Lumiverse wait", "How long each request the runtime makes to Lumiverse over HTTP waits for its answer: finding this extension, opening its link, putting the key in the loopback connection, asking Lumiverse to stop a reply. Past it the request fails, and says so.", 1000, 10 * 60000),
        copyReadMs: ms("Chat data wait", "How long each request the runtime makes to Lumiverse for its own copy of your chats and world books waits for its answer: a page of a chat's messages or of a book's entries, a check of a chat before an agent reads it. Past it that read is given up, and the agent's read is asked of this extension instead.", 1000, 10 * 60000),
        copyChars: whole3("Chat data kept", "The most characters of your chats and world books the runtime keeps in memory, so an agent reads them without asking this extension. What was used least recently goes first; a chat larger than this alone is read from this extension every time. 0 keeps none.", 0, 1e9, "characters"),
        providerMs: ms("Provider wait", "How long testing one of the runtime's connections (Runtime \u2192 Connections), or reading a server's list of its models for a model picker, waits for the provider to answer. Past it the page says the provider didn't answer.", 1000, 10 * 60000),
        answerSilentMs: ms("Silent answer ends after", "How long a model's answer, once it has begun, may go with nothing at all from its provider's server before the call is ended and made again, as a dropped stream is. Before its answer begins a model may still be reading a long prompt or thinking unseen: that is never cut short. 0: no limit.", 0, DAY_MS)
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

// src/link/timings.ts
var TIMINGS_KEPT = 2000;
var SLOWEST_SHOWN = 12;
var OP_MAX = 64;
function at(sorted, fraction) {
  if (sorted.length === 0)
    return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? 0;
}
function spread(values) {
  if (values.length === 0)
    return null;
  values.sort((a, b) => a - b);
  return { p50: at(values, 0.5), p95: at(values, 0.95), max: values[values.length - 1] ?? 0 };
}

class Timings {
  capacity;
  rows;
  next = 0;
  held = 0;
  constructor(capacity = TIMINGS_KEPT) {
    this.capacity = capacity;
    this.rows = new Array(capacity);
  }
  add(row) {
    if (this.capacity === 0)
      return;
    const kept = {
      at: row.at,
      op: row.op.length > OP_MAX ? row.op.slice(0, OP_MAX) : row.op,
      road: row.road,
      sent: Math.max(0, Math.round(row.sent)),
      got: Math.max(0, Math.round(row.got)),
      ms: Math.max(0, Math.round(row.ms)),
      workMs: row.workMs === null ? null : Math.max(0, Math.round(Math.min(row.workMs, row.ms))),
      outcome: row.outcome
    };
    this.rows[this.next] = kept;
    this.next = (this.next + 1) % this.capacity;
    this.held = Math.min(this.held + 1, this.capacity);
  }
  all() {
    const out = [];
    for (let i = 0;i < this.held; i++) {
      const row = this.rows[(this.next - this.held + i + this.capacity) % this.capacity];
      if (row !== undefined)
        out.push(row);
    }
    return out;
  }
  view() {
    const rows = this.all();
    const groups = new Map;
    for (const row of rows) {
      const key = `${row.road} ${row.op}`;
      const group = groups.get(key);
      if (group === undefined)
        groups.set(key, [row]);
      else
        group.push(row);
    }
    const ops = [...groups.values()].map((group) => {
      const first = group[0];
      const said = group.filter((row) => row.workMs !== null);
      return {
        op: first.op,
        road: first.road,
        count: group.length,
        notOk: group.filter((row) => row.outcome !== "ok").length,
        ms: spread(group.map((row) => row.ms)) ?? { p50: 0, p95: 0, max: 0 },
        waitMs: spread(said.map((row) => row.ms - (row.workMs ?? 0))),
        workMs: spread(said.map((row) => row.workMs ?? 0)),
        sent: Math.max(...group.map((row) => row.sent)),
        got: Math.max(...group.map((row) => row.got))
      };
    });
    ops.sort((a, b) => b.ms.p95 - a.ms.p95 || b.count - a.count || a.op.localeCompare(b.op));
    const slowest = [...rows].sort((a, b) => b.ms - a.ms || b.at - a.at).slice(0, SLOWEST_SHOWN);
    return { since: rows[0]?.at ?? null, rows: rows.length, capacity: this.capacity, ops, slowest };
  }
}
function timingsViewOf(raw) {
  const record = (v2) => typeof v2 === "object" && v2 !== null && !Array.isArray(v2);
  const whole4 = (v2) => typeof v2 === "number" && Number.isSafeInteger(v2) && v2 >= 0;
  const roadOf = (v2) => v2 === "link" || v2 === "proxy";
  const outcomeOf = (v2) => v2 === "ok" || v2 === "refused" || v2 === "timeout" || v2 === "failed";
  const opOf = (v2) => typeof v2 === "string" && v2 !== "" && v2.length <= OP_MAX;
  const spreadOf = (v2) => v2 === null ? null : record(v2) && whole4(v2.p50) && whole4(v2.p95) && whole4(v2.max) ? { p50: v2.p50, p95: v2.p95, max: v2.max } : undefined;
  if (!record(raw) || !(raw.since === null || whole4(raw.since)) || !whole4(raw.rows) || !whole4(raw.capacity) || !Array.isArray(raw.ops) || !Array.isArray(raw.slowest))
    return null;
  const ops = [];
  for (const o of raw.ops) {
    if (!record(o) || !opOf(o.op) || !roadOf(o.road) || !whole4(o.count) || !whole4(o.notOk) || !whole4(o.sent) || !whole4(o.got))
      return null;
    const ms2 = spreadOf(o.ms);
    const waitMs = spreadOf(o.waitMs);
    const workMs = spreadOf(o.workMs);
    if (ms2 === undefined || ms2 === null || waitMs === undefined || workMs === undefined)
      return null;
    ops.push({ op: o.op, road: o.road, count: o.count, notOk: o.notOk, ms: ms2, waitMs, workMs, sent: o.sent, got: o.got });
  }
  const slowest = [];
  for (const c of raw.slowest.slice(0, SLOWEST_SHOWN)) {
    if (!record(c) || !whole4(c.at) || !opOf(c.op) || !roadOf(c.road) || !whole4(c.sent) || !whole4(c.got) || !whole4(c.ms) || !(c.workMs === null || whole4(c.workMs)) || !outcomeOf(c.outcome))
      return null;
    slowest.push({ at: c.at, op: c.op, road: c.road, sent: c.sent, got: c.got, ms: c.ms, workMs: c.workMs, outcome: c.outcome });
  }
  return { since: raw.since, rows: raw.rows, capacity: raw.capacity, ops, slowest };
}

// src/extension/backend/approvals.ts
class Approvals {
  env;
  held = new Map;
  changed = [];
  constructor(env) {
    this.env = env;
  }
  onChange(listener) {
    this.changed.push(listener);
  }
  tell(userId) {
    for (const listener of this.changed)
      listener(userId);
  }
  settle(id, answer) {
    const held = this.held.get(id);
    if (held === undefined)
      return false;
    this.held.delete(id);
    held.settle(answer);
    this.tell(held.userId);
    return true;
  }
  ask(userId, stream, ask, signal) {
    const { promise, resolve, reject } = Promise.withResolvers();
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("The call no longer waits for an answer."));
      return promise;
    }
    const id = this.env.id();
    const gaveUp = () => void this.settle(id, signal.reason instanceof Error ? signal.reason : new Error("The call no longer waits for an answer."));
    signal.addEventListener("abort", gaveUp, { once: true });
    this.held.set(id, {
      userId,
      view: { ...ask, id, stream },
      settle: (answer) => {
        signal.removeEventListener("abort", gaveUp);
        if (answer instanceof Error)
          reject(answer);
        else
          resolve(answer);
      }
    });
    this.tell(userId);
    return promise;
  }
  answer(userId, id, answer) {
    if (this.held.get(id)?.userId !== userId)
      return false;
    return this.settle(id, answer);
  }
  views(userId) {
    const out = [];
    for (const held of this.held.values())
      if (held.userId === userId)
        out.push(held.view);
    return out;
  }
  waitingRuns(userId) {
    const out = new Set;
    for (const held of this.held.values())
      if (held.userId === userId)
        out.add(held.view.turn);
    return out;
  }
  dropRun(userId, run, why) {
    for (const [id, held] of [...this.held])
      if (held.userId === userId && held.view.turn === run)
        this.settle(id, new Error(why));
  }
}
function holdCall(d, userId, ask, signal) {
  const job = d.jobs.active(userId, ask.turn);
  if (job !== null)
    d.jobs.waits(userId, job.id, ask.tool).catch(() => {
      return;
    });
  return d.approvals.ask(userId, d.live.streamOf(userId, ask.turn) ?? ask.turn, ask, signal).finally(() => {
    if (job !== null && !d.approvals.waitingRuns(userId).has(job.id))
      d.jobs.waits(userId, job.id, null).catch(() => {
        return;
      });
  });
}

// src/link/road.ts
var ASK_PATH = "/x/ask";
var PROBE_HEADER = "x-lumiah-probe";
var PROXY_HOP_MS = 30000;
var PROXY_MAX_BYTES = 25 * 1024 * 1024;
var PROXY_ROOM_BYTES = 64 * 1024;
var TOO_LARGE_STATUS = 507;
function hex(bytes) {
  let out = "";
  for (const b of bytes)
    out += b.toString(16).padStart(2, "0");
  return out;
}
async function roadProof(secret, relay, nonce) {
  const encoder = new TextEncoder;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`lumiah ask road
${relay}
${nonce}`))));
}
async function sameSecret(a, b) {
  const encoder = new TextEncoder;
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(a)), crypto.subtle.digest("SHA-256", encoder.encode(b))]);
  const left = new Uint8Array(x);
  const right = new Uint8Array(y);
  let differs = 0;
  for (let i = 0;i < left.length; i++)
    differs |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return differs === 0;
}
function isLoopback(listen) {
  const name = listen.toLowerCase();
  return name === "localhost" || name === "::1" || name === "[::1]" || /^127(\.\d{1,3}){3}$/.test(name);
}
function roadBase(listen, port) {
  const host = listen.includes(":") && !listen.startsWith("[") ? `[${listen}]` : listen;
  return `http://${host}:${port}`;
}

// src/shared/timeouts.ts
var AGENT_TIMES = ["main", "writer", "summarizer"].flatMap((agent) => [
  ["core", "agents", agent, "budget", "callMs"],
  ["core", "agents", agent, "budget", "wallMs"]
]);
var TIMEOUT_GROUPS = [
  {
    id: "runtime",
    label: "Waiting for the runtime",
    about: "How long a page, a reply or a key waits for your runtime to do something.",
    rows: [
      ["transport", "pages", "askMs"],
      ["transport", "pages", "proxyMs"],
      ["transport", "link", "connectionMs"],
      ["transport", "tags", "checkMs"],
      ["transport", "runtime", "turnWaitMs"],
      ["transport", "runtime", "drainMs"],
      ["transport", "live", "lostMs"],
      ["transport", "link", "quietMs"]
    ]
  },
  {
    id: "link",
    label: "The link",
    about: "How long the runtime and this extension wait for each other over the link, and how the runtime reaches Lumiverse.",
    rows: [
      ["transport", "runtime", "requestMs"],
      ["transport", "runtime", "lumiverseMs"],
      ["transport", "runtime", "lostMs"],
      ["transport", "runtime", "silentMs"],
      ["transport", "runtime", "crashMs"],
      ["transport", "runtime", "stallMs"],
      ["transport", "runtime", "modelsWaitMs"],
      ["transport", "runtime", "reconnectMs"],
      ["transport", "runtime", "reconnectMaxMs"],
      ["transport", "runtime", "partStaleMs"],
      ["transport", "link", "partStaleMs"],
      ["transport", "runtime", "stopAskMs"],
      ["transport", "runtime", "stopGraceMs"]
    ]
  },
  {
    id: "tools",
    label: "Tools and approvals",
    about: "How long a tool call, your word on one, or something an agent started may take.",
    rows: [
      ["transport", "mcp", "callMs"],
      ["core", "approval", "waitMs"],
      ["core", "extension", "waitMs"],
      ["core", "jobs", "dueWaitMs"]
    ]
  },
  {
    id: "model",
    label: "A model call",
    about: "How long an agent's calls, the agent, a turn or a job may take, how long a model's answer may go silent, how long a connection's test waits for its provider, and the wait before a failed call is made again.",
    rows: [...AGENT_TIMES, ["core", "turn", "wallMs"], ["core", "jobs", "budget", "wallMs"], ["core", "loop", "retryWaitMs"], ["transport", "runtime", "answerSilentMs"], ["transport", "runtime", "providerMs"]]
  },
  {
    id: "store",
    label: "The copy and the store",
    about: "How long the runtime's copy of your chats and lore waits for Lumiverse, and how long what the runtime saved, and the records of replies, wait to reach this extension's storage and Lumiverse.",
    rows: [
      ["transport", "runtime", "copyReadMs"],
      ["transport", "runtime", "storeWaitMs"],
      ["transport", "pages", "settleMs"],
      ["transport", "anchors", "waitMs"],
      ["core", "jobs", "recordWaitMs"]
    ]
  }
];
function timeoutGroupOf(path) {
  return TIMEOUT_GROUPS.find((group) => group.rows.some((row) => row.length === path.length && row.every((key, i) => key === path[i]))) ?? null;
}
function timeoutPlace(path, title, owner) {
  const group = timeoutGroupOf(path);
  const settings = owner.settingsAt ?? `${owner.name}'s Settings`;
  return `${title} (${settings} \u2192 Timeouts${group !== null ? ` \u2192 ${group.label}` : ""})`;
}

// src/link/waits.ts
function transportWait(path, owner) {
  let at2 = TRANSPORT_SCHEMA;
  for (const key of path)
    at2 = isRecord2(at2) && isRecord2(at2.properties) ? at2.properties[key] : undefined;
  const title = isRecord2(at2) && typeof at2.title === "string" ? at2.title : path.join(".");
  return timeoutPlace([TRANSPORT_KEY, ...path], title, owner);
}
function spanWords(ms2) {
  if (ms2 < 1000)
    return `${Math.round(ms2)} ms`;
  if (ms2 >= 60000 && ms2 % 60000 === 0)
    return `${ms2 / 60000} minute${ms2 === 60000 ? "" : "s"}`;
  const seconds = Math.round(ms2 / 100) / 10;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

// src/host/refused.ts
class LinkRefused extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "LinkRefused";
  }
}

// src/extension/backend/errors.ts
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
function wrongKey(name) {
  return new LinkRefused("forbidden", `The key in the loopback connection isn't this account's loopback key. Mint a new one on ${name}'s Runtime page: your linked runtime puts it in the connection.`);
}
function wordsOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/extension/backend/asks.ts
var CODES = { bad_request: "bad_request", not_found: "not_found", forbidden: "forbidden", unavailable: "unavailable", invalid: "invalid", conflict: "conflict" };
var LINK_DROPPED = "The runtime's link just dropped. Try again once the Runtime page shows it linked.";
function problemsOf(raw) {
  if (!Array.isArray(raw))
    return;
  const out = [];
  for (const one of raw)
    if (isRecord2(one) && Array.isArray(one.path) && typeof one.message === "string")
      out.push({ path: one.path.filter((k) => typeof k === "string" || typeof k === "number"), message: one.message });
  return out;
}
function refused(refusal, who) {
  const said = typeof refusal.message === "string" && refusal.message !== "" ? refusal.message : `${who} couldn't do that.`;
  const code = typeof refusal.code === "string" ? CODES[refusal.code] : undefined;
  return new UiRefused(code ?? "internal", code === undefined ? `${who} couldn't do that (${said}).` : said, problemsOf(refusal.problems));
}
var sizeOf = (value) => JSON.stringify(value ?? null).length;

class Asks {
  deps;
  pending = new Map;
  constructor(deps) {
    this.deps = deps;
  }
  async chatOf(userId, op, id) {
    try {
      const read2 = await this.ask(userId, op, { id });
      const row = isRecord2(read2) ? op === "jobs.read" ? read2.job : read2.side : undefined;
      return isRecord2(row) && typeof row.chatId === "string" && row.chatId !== "" ? row.chatId : null;
    } catch (error) {
      if (error instanceof UiRefused && error.code === "not_found")
        return null;
      throw error;
    }
  }
  async place(userId, where) {
    if (where.relay !== undefined)
      return this.deps.relays.isLinked(userId, where.relay) ? where.relay : { relay: where.relay };
    const running = where.run !== undefined ? this.deps.runOf(userId, where.run.stream, where.run.turn) : null;
    if (running !== null)
      return running;
    let chat = where.chat ?? null;
    if (where.job !== undefined) {
      const runs = this.deps.jobOf(userId, where.job);
      if (runs !== null)
        return runs;
      chat = await this.chatOf(userId, "jobs.read", where.job);
    } else if (where.side !== undefined)
      chat = await this.chatOf(userId, "sides.turns", where.side);
    if (chat !== null && await this.deps.onLoopback(userId, chat))
      return await this.deps.runtimeOf(userId, chat) ?? { chat };
    return this.deps.userRuntime(userId);
  }
  async ask(userId, op, args, where = {}) {
    const relay = await this.place(userId, where);
    const start = `Start it (its line is on ${this.deps.name}'s Runtime page) and try again.`;
    if (relay === null)
      throw new UiRefused("unavailable", `${this.deps.name} needs its runtime for this, and none is linked now. ${start}`);
    if (typeof relay !== "string")
      throw new UiRefused("unavailable", "relay" in relay ? `That runtime isn't linked now. ${start}` : `This chat runs in a runtime, and that runtime isn't linked now. ${start}`);
    const { askMs: waitMs, proxyMs } = (await this.deps.settings.transport(userId)).pages;
    const opened = where.patient !== true && waitMs <= PROXY_HOP_MS && this.deps.road !== undefined ? await this.deps.road.open(userId, relay) : null;
    const id = this.deps.id();
    const body = opened === null ? null : JSON.stringify({ ask: id, op, args, where: { ...where, relay } });
    const proxied = body !== null && body.length <= PROXY_MAX_BYTES - PROXY_ROOM_BYTES;
    const { promise, resolve, reject } = Promise.withResolvers();
    const unwait = where.patient ? () => {
      return;
    } : this.deps.later(waitMs, () => {
      const pending = this.pending.get(id);
      if (pending !== undefined)
        this.settle(id, { error: new UiRefused("unavailable", `The runtime didn't answer within ${spanWords(waitMs)}. It may be busy or restarting: try again in a moment. ${transportWait(["pages", "askMs"], this.deps)} says how long a page waits for it.`), outcome: "timeout", road: pending.road, took: null, got: 0 });
    });
    this.pending.set(id, {
      userId,
      relay,
      op,
      args,
      at: this.deps.now(),
      sent: proxied && body !== null ? body.length : sizeOf(args),
      road: proxied ? "proxy" : "link",
      linked: false,
      proxied,
      unproxy: () => {
        return;
      },
      settle: (out) => {
        unwait();
        if ("error" in out)
          reject(out.error);
        else
          resolve(out.value);
      }
    });
    if (proxied && opened !== null && body !== null)
      this.viaProxy(id, opened, body, proxyMs);
    else
      this.viaLink(id);
    return promise;
  }
  viaProxy(id, opened, body, proxyMs) {
    const pending = this.pending.get(id);
    const road = this.deps.road;
    if (pending === undefined || road === undefined)
      return;
    pending.unproxy = this.deps.later(proxyMs, () => this.viaLink(id));
    road.send(pending.userId, pending.relay, opened, body).then((answer) => {
      const still = this.pending.get(id);
      if (still === undefined)
        return;
      still.proxied = false;
      still.unproxy();
      if (answer.kind === "answer") {
        if (answer.refusal !== null)
          this.settle(id, { error: refused(answer.refusal, "The runtime"), outcome: "refused", road: "proxy", took: answer.took, got: answer.got });
        else
          this.settle(id, { value: answer.value, road: "proxy", took: answer.took, got: answer.got });
      } else if (!still.linked)
        this.viaLink(id);
    });
  }
  viaLink(id) {
    const pending = this.pending.get(id);
    if (pending === undefined || pending.linked)
      return;
    if (this.deps.relays.push(pending.userId, pending.relay, { link: LINK, type: "ask", ask: id, op: pending.op, args: pending.args }))
      pending.linked = true;
    else if (!pending.proxied)
      this.settle(id, { error: new UiRefused("unavailable", LINK_DROPPED), outcome: "failed", road: "link", took: null, got: 0 });
  }
  settle(id, out) {
    const pending = this.pending.get(id);
    if (pending === undefined)
      return;
    this.pending.delete(id);
    pending.unproxy();
    this.deps.timings?.add({ at: pending.at, op: pending.op, road: out.road, sent: pending.sent, got: out.got, ms: this.deps.now() - pending.at, workMs: out.took, outcome: "error" in out ? out.outcome : "ok" });
    pending.settle(out);
  }
  answered(userId, relay, ask, value, refusal, took) {
    if (typeof ask !== "string")
      return;
    const pending = this.pending.get(ask);
    if (pending === undefined || pending.userId !== userId || pending.relay !== relay)
      return;
    const worked = typeof took === "number" && Number.isFinite(took) && took >= 0 ? took : null;
    if (isRecord2(refusal)) {
      this.settle(ask, { error: refused(refusal, "The runtime"), outcome: "refused", road: "link", took: worked, got: sizeOf(refusal) });
      return;
    }
    this.settle(ask, { value: value === undefined ? null : value, road: "link", took: worked, got: sizeOf(value) });
  }
  recheck(userId) {
    const gone = new Set;
    for (const pending of this.pending.values())
      if (pending.userId === userId && !this.deps.relays.isLinked(userId, pending.relay))
        gone.add(pending.relay);
    for (const relay of gone)
      this.relayGone(userId, relay);
  }
  relayGone(userId, relay) {
    for (const [id, pending] of [...this.pending]) {
      if (pending.userId === userId && pending.relay === relay && !pending.proxied)
        this.settle(id, { error: new UiRefused("unavailable", "The runtime's link dropped before it answered. Try again once the Runtime page shows it linked."), outcome: "failed", road: pending.road, took: null, got: 0 });
    }
  }
}

// src/core/hash.ts
var HEX = /^[0-9a-f]{64}$/;
function isHash(value) {
  return typeof value === "string" && HEX.test(value);
}
function hex2(buffer) {
  let out = "";
  for (const byte of new Uint8Array(buffer))
    out += byte.toString(16).padStart(2, "0");
  return out;
}
async function textHash(text) {
  return hex2(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
function partsHash(...parts) {
  return textHash(JSON.stringify(parts));
}
var ROOT_PATH = "";
function nextPath(parent, role, hash) {
  return partsHash("lumiah.path", parent, role, hash);
}

// src/host/chat.ts
function anchorsOf(own) {
  const out = { v: 1, swipes: {} };
  if (!isRecord2(own) || own.v !== 1 || !isRecord2(own.swipes))
    return out;
  for (const [swipe, record] of Object.entries(own.swipes))
    if (/^(0|[1-9][0-9]*)$/.test(swipe) && record !== undefined && record !== null)
      out.swipes[swipe] = record;
  return out;
}
var OWN_ANCHORS = {
  reads: { under: null },
  read: (own, swipe) => anchorsOf(own).swipes[String(swipe)] ?? null,
  write(own, swipe, record) {
    const anchors = anchorsOf(own);
    anchors.swipes[String(swipe)] = record;
    return anchors;
  },
  swipeDeleted(own, deleted) {
    const anchors = anchorsOf(own);
    const held = Object.keys(anchors.swipes).map(Number);
    if (!held.some((swipe) => swipe >= deleted))
      return null;
    const moved = { v: 1, swipes: {} };
    for (const swipe of held) {
      if (swipe === deleted)
        continue;
      const record = anchors.swipes[String(swipe)];
      if (record !== undefined)
        moved.swipes[String(swipe > deleted ? swipe - 1 : swipe)] = record;
    }
    return moved;
  }
};
function anchorsUnder(key) {
  const records = (own) => isRecord2(own) ? own[key] ?? null : null;
  const entry = (own, held) => ({ ...isRecord2(own) ? own : {}, [key]: held });
  return {
    reads: { under: key },
    read: (own, swipe) => OWN_ANCHORS.read(records(own), swipe),
    write: (own, swipe, record) => entry(own, OWN_ANCHORS.write(records(own), swipe, record)),
    swipeDeleted(own, deleted) {
      const moved = OWN_ANCHORS.swipeDeleted(records(own), deleted);
      return moved === null ? null : entry(own, moved);
    }
  };
}
var TAIL_FIRST = 4;
function placeOf(rows, index) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = low + high >> 1;
    if (rows[mid].index < index)
      low = mid + 1;
    else
      high = mid;
  }
  return low;
}

class ChatReader {
  reads;
  kept;
  now;
  codec;
  paths = new Map;
  constructor(reads, kept, now, codec = OWN_ANCHORS) {
    this.reads = reads;
    this.kept = kept;
    this.now = now;
    this.codec = codec;
  }
  async own(userId, chatId) {
    const chat = await this.reads.chats.get(chatId, userId);
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
  touchedAll() {
    for (const chatId of this.paths.keys())
      this.touched(chatId);
  }
  dropped(chatId) {
    this.paths.delete(chatId);
  }
  async path(userId, chatId) {
    await this.own(userId, chatId);
    const keeping = await this.kept(userId);
    const held = this.paths.get(chatId);
    if (held?.fresh === true && this.now() - held.at < keeping.ms) {
      const last = await this.last(chatId);
      const keptLast = held.rows.at(-1);
      const same = last === null ? keptLast === undefined : keptLast !== undefined && keptLast.id === last.id && keptLast.index === last.index && keptLast.swipeId === last.swipeId && keptLast.mark === contentMark(last.role, last.content);
      if (same)
        return held.rows.map(({ mark: _mark, ...row }) => row);
    }
    const at2 = this.now();
    const mine = held ?? { rows: [], fresh: false, changes: 0, at: at2 };
    if (held === undefined)
      this.paths.set(chatId, mine);
    const changes = mine.changes;
    const rows = await this.reads.chats.messages(chatId);
    const before = new Map(mine.rows.map((row) => [row.id, row]));
    const read2 = await Promise.all(rows.map(async (m) => {
      const mark = contentMark(m.role, m.content);
      const old = before.get(m.id);
      const hash = old !== undefined && old.swipeId === m.swipeId && old.mark === mark ? old.hash : await textHash(m.content);
      return { id: m.id, index: m.index, role: m.role, name: m.name, swipeId: m.swipeId, chars: m.content.length, hash, anchor: this.codec.read(m.own, m.swipeId), mark };
    }));
    const unchanged = this.paths.get(chatId) === mine && mine.changes === changes;
    this.paths.delete(chatId);
    if (keeping.chats > 0) {
      this.paths.set(chatId, { rows: read2, fresh: unchanged && keeping.ms > 0, changes: mine.changes, at: at2 });
      for (const oldest of this.paths.keys()) {
        if (this.paths.size <= keeping.chats)
          break;
        this.paths.delete(oldest);
      }
    }
    return read2.map(({ mark: _mark, ...row }) => row);
  }
  async messages(userId, chatId, from, to) {
    await this.own(userId, chatId);
    return (await this.range(chatId, from, to)).map((m) => ({ id: m.id, index: m.index, role: m.role, name: m.name, swipeId: m.swipeId, content: m.content }));
  }
  async range(chatId, from, to) {
    if (to <= from)
      return [];
    const kept = this.paths.get(chatId)?.rows ?? [];
    const last = kept.at(-1)?.index ?? -1;
    const start = kept.length > 0 ? placeOf(kept, from) : from;
    const count = kept.length > 0 && last >= to ? placeOf(kept, to) - start : to - from;
    const rows = count > 0 ? await this.reads.chats.messages(chatId, { from: start, count }) : [];
    const placed = rows.every((m, i) => {
      const held = kept[start + i];
      if (kept.length === 0)
        return m.index === from + i;
      return held !== undefined ? held.id === m.id : m.index > last;
    });
    if (placed)
      return rows.filter((m) => m.index >= from && m.index < to);
    return (await this.reads.chats.messages(chatId)).filter((m) => m.index >= from && m.index < to);
  }
  async find(chatId, messageId) {
    const tail = await this.reads.chats.messages(chatId, { tail: TAIL_FIRST });
    const near = tail.find((m) => m.id === messageId);
    if (near !== undefined)
      return near;
    if (tail.length < TAIL_FIRST)
      return null;
    return (await this.reads.chats.messages(chatId)).find((m) => m.id === messageId) ?? null;
  }
  async last(chatId) {
    return (await this.reads.chats.messages(chatId, { tail: 1 })).at(-1) ?? null;
  }
  async info(userId, chatId) {
    const chat = await this.reads.chats.get(chatId, userId);
    if (chat === null)
      return null;
    const from = chat.metadata.branched_from;
    return {
      id: chat.id,
      name: chat.name,
      characterId: chat.characterId,
      characterName: chat.characterId === null ? null : await this.reads.chats.characterName(chat.characterId, userId),
      branchedFrom: typeof from === "string" && from !== "" ? from : null
    };
  }
  async anchors(userId, cursor) {
    const at2 = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(at2) || at2 < 0)
      throw new LinkRefused("bad_request", "That page of the chats' records isn't one LumiAH gave.");
    const { chats, total } = await this.reads.chats.list(userId, at2, 1);
    const chat = chats[0];
    const anchors = [];
    if (chat !== undefined) {
      for (const message of await this.reads.chats.messages(chat.id)) {
        if (message.own === null)
          continue;
        for (let swipe = 0;swipe < message.swipes; swipe++) {
          const anchor = this.codec.read(message.own, swipe);
          if (anchor !== null)
            anchors.push({ chatId: chat.id, messageId: message.id, swipeId: swipe, anchor });
        }
      }
    }
    return { anchors, next: chat !== undefined && at2 + 1 < total ? String(at2 + 1) : null };
  }
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
  writes = new KeyedQueue;
  changing = new Map;
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
      for (const other of this.loaded.keys()) {
        if (this.loaded.size <= USERS_KEPT)
          break;
        if (!this.changing.has(other))
          this.loaded.delete(other);
      }
    }
    return loaded;
  }
  async change(userId, fn) {
    this.changing.set(userId, (this.changing.get(userId) ?? 0) + 1);
    try {
      const doc = await this.get(userId);
      const out = fn(doc);
      const text = JSON.stringify(doc);
      try {
        await this.writes.run(userId, async () => {
          const unreadable = this.unreadable.get(userId);
          if (unreadable !== undefined) {
            await this.host.storage.write(`${this.file}.bad`, unreadable, userId);
            this.unreadable.delete(userId);
          }
          await this.host.storage.write(this.file, text, userId);
        });
      } catch (error) {
        this.loaded.delete(userId);
        throw new Error(`LumiAH couldn't save ${this.file} (${error instanceof Error ? error.message : String(error)}). Try again in a moment.`);
      }
      return out;
    } finally {
      const left = (this.changing.get(userId) ?? 1) - 1;
      if (left > 0)
        this.changing.set(userId, left);
      else
        this.changing.delete(userId);
    }
  }
  settle() {
    return this.writes.idle();
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
  async idle() {
    await Promise.all(this.tails.values());
  }
}

// src/extension/backend/chat.ts
class Chats extends ChatReader {
  host;
  writes = new KeyedQueue;
  constructor(host, kept, now, codec = OWN_ANCHORS) {
    super(host, kept, now, codec);
    this.host = host;
  }
  async anchor(userId, chatId, messageId, swipe, record) {
    await this.own(userId, chatId);
    if (!this.host.granted("chat_mutation"))
      return false;
    const aimed = typeof swipe === "function" ? swipe() : swipe;
    return this.writes.run(`${chatId}\x00${messageId}`, async () => {
      const message = await this.find(chatId, messageId);
      if (message === null)
        return false;
      const at2 = aimed ?? message.swipeId;
      if (!Number.isSafeInteger(at2) || at2 < 0 || at2 >= message.swipes)
        return false;
      const held = this.codec.read(message.own, at2);
      const kept = isRecord2(record) && record.ran === undefined && isRecord2(held) && held.ran !== undefined && held.generationId === record.generationId ? { ...record, ran: held.ran } : record;
      await this.host.chats.setOwn(chatId, messageId, this.codec.write(message.own, at2, kept));
      this.touched(chatId);
      return true;
    });
  }
  async recorded(chatId, messageId, swipe, generationId) {
    const message = await this.find(chatId, messageId);
    const held = message === null ? null : this.codec.read(message.own, swipe);
    return isRecord2(held) && held.generationId === generationId;
  }
  async swipeDeleted(chatId, messageId, deleted) {
    if (!this.host.granted("chat_mutation"))
      return;
    await this.writes.run(`${chatId}\x00${messageId}`, async () => {
      const message = await this.find(chatId, messageId);
      if (message === null)
        return;
      const moved = this.codec.swipeDeleted(message.own, deleted);
      if (moved === null)
        return;
      await this.host.chats.setOwn(chatId, messageId, moved);
      this.touched(chatId);
    });
  }
  async deleteEmpty(userId, chatId, messageId) {
    await this.own(userId, chatId);
    if (!this.host.granted("chat_mutation"))
      return false;
    return this.writes.run(`${chatId}\x00${messageId}`, async () => {
      const message = await this.find(chatId, messageId);
      if (message === null || message.role !== "assistant" || message.swipes !== 1 || message.content !== "")
        return false;
      await this.host.chats.deleteMessage(chatId, messageId);
      this.touched(chatId);
      return true;
    });
  }
}

// src/extension/backend/copy.ts
var SEP = "\x00";
var key = (userId, relay) => `${userId}${SEP}${relay}`;
function text(value, what) {
  if (typeof value !== "string" || value === "")
    throw new LinkRefused("bad_request", `The read names no ${what}: update the runtime and LumiAH to the same build.`);
  return value;
}
function whole4(value, what) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new LinkRefused("bad_request", `The read's ${what} isn't a whole number: update the runtime and LumiAH to the same build.`);
  return value;
}
function rangeOf(value) {
  if (value === null || value === undefined)
    return;
  if (isRecord2(value) && value.tail !== undefined)
    return { tail: whole4(value.tail, "tail") };
  if (isRecord2(value))
    return { from: whole4(value.from, "start"), count: whole4(value.count, "count") };
  throw new LinkRefused("bad_request", "The read's range of messages is malformed: update the runtime and LumiAH to the same build.");
}

class CopyFeed {
  host;
  deps;
  told = new Map;
  given = new Map;
  queues = new Map;
  switches;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
    this.switches = new UserDocs(host, "database.json", (raw) => isRecord2(raw) && raw.v === 1 && typeof raw.on === "boolean" ? { v: 1, on: raw.on } : null, () => ({ v: 1, on: false }));
  }
  start() {
    this.host.events.onLumiverse(COPY_EVENTS, (name, payload, userId) => {
      if (userId === null)
        return;
      this.queue(userId, async () => this.toEach(userId, (seq) => ({ link: LINK, type: "event", seq, name, payload: payload ?? null, userId })));
    });
    this.host.onPermission((permission) => {
      if (!COPY_PERMISSIONS.includes(permission))
        return;
      for (const userId of new Set([...this.told.keys()].map((k) => k.slice(0, k.indexOf(SEP)))))
        this.queue(userId, () => this.retell(userId));
    });
    this.deps.ownElsewhere?.onChanged((chatId, userId) => {
      this.deps.chats.touched(chatId);
      if (userId !== null) {
        this.queue(userId, async () => this.toEach(userId, (seq) => ({ link: LINK, type: "own", seq, chat: chatId })));
        return;
      }
      for (const user of new Set([...this.told.keys()].map((k) => k.slice(0, k.indexOf(SEP))))) {
        this.host.chats.get(chatId, user).then((chat) => {
          if (chat !== null)
            this.queue(user, async () => this.toEach(user, (seq) => ({ link: LINK, type: "own", seq, chat: chatId })));
        }).catch((error) => this.host.log("warn", `[LumiAH] whose chat ${chatId} is couldn't be told, so its runtimes read its records again: ${wordsOf(error)}`));
      }
    });
  }
  async offer(userId, relay) {
    const k = key(userId, relay);
    const fields = await this.fields(userId);
    this.given.set(k, fields.database);
    if (!this.told.has(k))
      this.told.set(k, 0);
    return { ...fields, told: this.told.get(k) ?? 0 };
  }
  toldTo(userId, relay) {
    return this.told.get(key(userId, relay)) ?? 0;
  }
  async pinged(userId, relay) {
    const k = key(userId, relay);
    if ((this.given.get(k) ?? null) === null)
      return;
    if (await this.databaseFor(userId).catch(() => null) === this.given.get(k))
      return;
    this.queue(userId, () => this.retell(userId));
  }
  async read(userId, port, method, args) {
    if (!Array.isArray(args))
      throw new LinkRefused("bad_request", "The read's arguments are malformed: update the runtime and LumiAH to the same build.");
    const { chats, lore } = this.host;
    const value = async () => {
      switch (`${String(port)}.${String(method)}`) {
        case "chats.get":
          return chats.get(text(args[0], "chat"), userId);
        case "chats.messages": {
          const chatId = text(args[0], "chat");
          await this.deps.chats.own(userId, chatId);
          return chats.messages(chatId, rangeOf(args[1]));
        }
        case "chats.swipe": {
          const chatId = text(args[0], "chat");
          await this.deps.chats.own(userId, chatId);
          return chats.swipe(chatId, text(args[1], "message"), whole4(args[2], "swipe"));
        }
        case "chats.list":
          return chats.list(userId, whole4(args[0], "offset"), whole4(args[1], "limit"));
        case "chats.characterName":
          return chats.characterName(text(args[0], "character"), userId);
        case "chats.sovereignHand":
          return chats.sovereignHand(text(args[0], "chat"), userId);
        case "lore.book":
          return lore.book(text(args[0], "world book"), userId);
        case "lore.entries":
          return lore.entries(text(args[0], "world book"), userId);
        case "lore.entry":
          return lore.entry(text(args[0], "entry"), userId);
        case "lore.record":
          return lore.record(text(args[0], "world book"), userId);
        case "lore.records":
          return lore.records(text(args[0], "world book"), userId);
        case "lore.global":
          return lore.global(userId);
        case "lore.ofCharacter":
          return lore.ofCharacter(text(args[0], "character"), userId);
        case "lore.ofPersona":
          return lore.ofPersona(args[0] === null ? null : text(args[0], "persona"), userId);
        default:
          throw new LinkRefused("bad_request", `There is no read ${String(port)}.${String(method)} of the extension's host: update the runtime and LumiAH to the same build.`);
      }
    };
    return { value: await value() ?? null };
  }
  async own(userId, chatId) {
    const own = this.deps.ownElsewhere;
    if (own === undefined)
      throw new LinkRefused("bad_request", `${this.deps.name} keeps LumiAH's records on the messages themselves: the runtime reads them there.`);
    const id = text(chatId, "chat");
    await this.deps.chats.own(userId, id);
    return { entries: await own.read(id, userId) };
  }
  async turnLore(userId, chatId, character) {
    const turn = this.deps.turns.ofChat(userId, text(chatId, "chat"));
    const characterId = character === undefined || character === null ? null : text(character, "character");
    const { lore } = this.host;
    const [global, active, persona, ofCharacter] = await Promise.all([
      lore.global(userId).catch(() => []),
      lore.ofPersona(null, userId).catch(() => null),
      typeof turn?.personaId === "string" ? lore.ofPersona(turn.personaId, userId).catch(() => null) : undefined,
      characterId !== null ? lore.ofCharacter(characterId, userId).catch(() => []) : []
    ]);
    const books = { global, active, character: ofCharacter, ...persona !== undefined ? { persona } : {} };
    return turn === undefined ? { activated: [], books } : { persona: turn.personaId, activated: turn.activated, books };
  }
  async databaseView(userId) {
    if (!await this.operator(userId))
      return { operator: false, on: false, path: null };
    return { operator: true, on: (await this.switches.get(userId)).on, path: this.host.database() };
  }
  async setDatabase(userId, on) {
    if (typeof on !== "boolean")
      throw new UiRefused("bad_request", "Say whether the database reader is to be on (true) or off (false).");
    if (!await this.operator(userId))
      throw new UiRefused("forbidden", "Only this Lumiverse's operator can switch the database reader on or off.");
    if (on && this.host.database() === null)
      throw new UiRefused("unavailable", `${this.deps.name} can't tell where Lumiverse's database is from where it is installed, so the reader can't be switched on.`);
    await this.switches.change(userId, (doc) => {
      doc.on = on;
    });
    this.queue(userId, () => this.retell(userId));
    return this.databaseView(userId);
  }
  async settle() {
    await Promise.all([...this.queues.values()]);
    await this.switches.settle();
  }
  async operator(userId) {
    return await this.host.role(userId).catch(() => "user") === "operator";
  }
  async databaseFor(userId) {
    const path = this.host.database();
    if (path === null || !await this.operator(userId))
      return null;
    return (await this.switches.get(userId)).on ? path : null;
  }
  async fields(userId) {
    return {
      identifier: this.host.identifier,
      granted: COPY_PERMISSIONS.filter((permission) => this.host.granted(permission)),
      ownElsewhere: this.deps.ownElsewhere !== undefined,
      declinesLore: this.deps.declinesLore,
      records: this.deps.records,
      database: await this.databaseFor(userId).catch(() => null)
    };
  }
  async retell(userId) {
    const offer = await this.fields(userId);
    for (const k of this.told.keys())
      if (k.startsWith(`${userId}${SEP}`))
        this.given.set(k, offer.database);
    await this.toEach(userId, (seq) => ({ link: LINK, type: "copy", seq, offer }));
  }
  queue(userId, work) {
    const next = (this.queues.get(userId) ?? Promise.resolve()).then(work).catch((error) => {
      for (const k of this.told.keys())
        if (k.startsWith(`${userId}${SEP}`))
          this.told.set(k, (this.told.get(k) ?? 0) + 1);
      this.host.log("warn", `[LumiAH] the runtime's copy of chat and lore couldn't be told of a change, so it reads again what it holds: ${wordsOf(error)}`);
    });
    this.queues.set(userId, next);
    next.then(() => {
      if (this.queues.get(userId) === next)
        this.queues.delete(userId);
    });
  }
  async toEach(userId, make) {
    const { relays } = await this.deps.registry.read(userId);
    for (const relay of Object.keys(relays)) {
      const k = key(userId, relay);
      const seq = (this.told.get(k) ?? 0) + 1;
      if (this.deps.relays.push(userId, relay, make(seq)))
        this.told.set(k, seq);
    }
  }
}

// src/core/agents.ts
var OWNED_FIELDS = ["instructions", "tools", "name", "description"];

// src/core/workspace.ts
var ROOT = { chat: "/", learned: "learned/", user: "~/" };
function showPath(area2, path) {
  return `${ROOT[area2]}${path}`;
}
var FILED = new WeakMap;

// src/core/definitions.ts
var ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
var text2 = (value) => typeof value === "string";
var INSTRUCTION_TEXTS = [TEXT.main.system, TEXT.agents.summarizer, TEXT.recall.chronicler, TEXT.recall.reader];
function checkAgent(value, tools) {
  const problems = [];
  if (!isRecord(value))
    return { agent: null, problems: [{ path: [], message: "It must be an agent definition." }] };
  const need = (key2, what) => {
    const v2 = value[key2];
    if (text2(v2) && v2.trim() !== "")
      return v2;
    problems.push({ path: [key2], message: `It needs ${what}.` });
    return "";
  };
  const id = need("id", "an id");
  if (id !== "" && !ID.test(id))
    problems.push({ path: ["id"], message: "An id is letters, digits and _ . : - only, starts with a letter or a digit, and is at most 64 characters." });
  const name = need("name", "a name");
  const description = need("description", "a description: it is what another agent reads when it chooses whom to hand a task");
  if (!text2(value.instructions))
    problems.push({ path: ["instructions"], message: "Its instructions must be text." });
  if (value.given !== "request" && value.given !== "task")
    problems.push({ path: ["given"], message: "It must be given the whole request, or its task alone." });
  if (value.follows !== undefined && !(text2(value.follows) && ID.test(value.follows)))
    problems.push({ path: ["follows"], message: "It must name an agent definition by its id." });
  if (value.grant !== undefined && value.grant !== "own" && value.grant !== "definition")
    problems.push({ path: ["grant"], message: "It must say own (no tool the agent that starts it doesn't hold) or definition (its own tools, whoever starts it), or be left out for Settings to decide." });
  if (value.text !== undefined && !(text2(value.text) && INSTRUCTION_TEXTS.includes(value.text)))
    problems.push({ path: ["text"], message: `It may name only one of: ${INSTRUCTION_TEXTS.join(", ")}.` });
  const run = {};
  for (const key2 of ["connectionId", "model", "effort", "tools", "toolCalls", "budget"])
    if (hasOwn(value, key2))
      run[key2] = value[key2];
  const settings = readAgentSettings(run, tools, newAgentSettings(), [], problems);
  const owns = value.owns === undefined ? [] : Array.isArray(value.owns) && value.owns.every((field) => OWNED_FIELDS.includes(field)) ? [...new Set(value.owns)] : null;
  if (owns === null)
    problems.push({ path: ["owns"], message: `It may name only these fields: ${OWNED_FIELDS.join(", ")}.` });
  if (problems.length > 0)
    return { agent: null, problems };
  const grant = value.grant === "own" || value.grant === "definition" ? value.grant : undefined;
  return { agent: { id, name, description, instructions: value.instructions, ...text2(value.text) ? { text: value.text } : {}, given: value.given, ...text2(value.follows) ? { follows: value.follows } : {}, ...grant !== undefined ? { grant } : {}, ...owns !== null && owns.length > 0 ? { owns } : {}, ...settings }, problems };
}
function checkSkill(value) {
  const problems = [];
  if (!isRecord(value))
    return { skill: null, problems: [{ path: [], message: "It must be a skill." }] };
  const need = (key2, what) => {
    const v2 = value[key2];
    if (text2(v2) && v2.trim() !== "")
      return v2;
    problems.push({ path: [key2], message: `It needs ${what}.` });
    return "";
  };
  const id = need("id", "an id");
  if (id !== "" && !ID.test(id))
    problems.push({ path: ["id"], message: "An id is letters, digits and _ . : - only, starts with a letter or a digit, and is at most 64 characters." });
  const name = need("name", "a name");
  const description = need("description", "a description: it is what an agent reads when it chooses a skill");
  const body = need("body", "a body: the procedure itself");
  const ids = (key2, message) => {
    const v2 = value[key2];
    if (v2 === undefined)
      return;
    if (Array.isArray(v2) && v2.every((agent) => text2(agent) && ID.test(agent)))
      return [...new Set(v2)];
    problems.push({ path: [key2], message });
    return null;
  };
  const agents = ids("agents", "It must name the agents it is for by their ids, or be left out for every agent.");
  const starts = ids("starts", "It must name the agents its procedure starts by their ids, or be left out.");
  return problems.length > 0 ? { skill: null, problems } : { skill: { id, name, description, body, ...value.owned === true ? { owned: true } : {}, ...agents ? { agents } : {}, ...starts ? { starts } : {} }, problems };
}

// src/core/paths.ts
function docKey(id) {
  return encodeURIComponent(id).replace(/\./g, "%2E");
}
var DOC = {
  userArea: "workspace/user.json",
  learned: (chatId) => `chats/${docKey(chatId)}/learned.json`,
  chatArea: (chatId, generation) => `chats/${docKey(chatId)}/area/${docKey(generation)}.json`,
  approvals: (chatId) => `chats/${docKey(chatId)}/approvals.json`,
  session: (chatId) => `chats/${docKey(chatId)}/session.json`,
  chatJobs: (chatId) => `chats/${docKey(chatId)}/jobs.json`,
  job: (id) => `jobs/${docKey(id)}.json`,
  allJobs: "jobs/all.json",
  runningJobs: "jobs/running.json",
  side: (id) => `sides/${docKey(id)}.json`,
  sides: "sides.json",
  spend: (day, hour) => `spend/${day}/${hour}.json`,
  upkeep: "upkeep.json"
};

// src/core/guidance.ts
var GUIDANCE_FILE = "GUIDANCE.md";
var CHARACTERS = "characters";
function characterGuidance(characterId) {
  return `${CHARACTERS}/${docKey(characterId)}/${GUIDANCE_FILE}`;
}

// src/core/recall/cite.ts
var CITE_CHARS = 8;
var HASH_CHARS = 64;
var CITATION = new RegExp(`\\[#(\\d{1,9})\\s+([0-9a-f]{${CITE_CHARS},${HASH_CHARS}})\\]`, "gi");
var NAMED = new RegExp(`^\\[?\\s*(?:#\\s*)?(\\d{1,9})(?:\\s+([0-9a-f]{${CITE_CHARS},${HASH_CHARS}}))?\\s*\\]?$`, "i");

// src/shared/ui.ts
var UI_VERSION = 1;
function isReply(kind) {
  return kind !== "job" && kind !== "side";
}
var URL_SLOT = "{{url}}";
function chatAnswered(chat) {
  return chat.connection?.loopback === true;
}
function replyDid(events) {
  let main = null;
  const briefs = new Map;
  let brief = null;
  let lore = { added: [], dropped: [] };
  let answer = null;
  let stop = null;
  for (const { event } of events) {
    if (event.kind === "agent_started") {
      if (main === null && event.agent.parent === undefined)
        main = event.agent.id;
      continue;
    }
    if (event.kind !== "agent_entry" || event.agentId !== main)
      continue;
    const { entry } = event;
    if (entry.kind === "answer") {
      const calls = Array.isArray(entry.calls) ? entry.calls : [];
      for (const call of calls)
        if (call.name === TOOL.writeReply && isRecord(call.args) && typeof call.args.brief === "string")
          briefs.set(call.id, call.args.brief);
      answer = calls.length === 0 && typeof entry.text === "string" && entry.text.trim() !== "" ? entry.text : null;
      stop = null;
    } else if (entry.kind === "result") {
      if (entry.name !== TOOL.writeReply || entry.error === true)
        continue;
      brief = briefs.get(entry.callId) ?? brief;
      const changed = loreChangesOf(entry);
      lore = { added: changed?.added.map((e) => e.title) ?? [], dropped: changed?.dropped.map((e) => e.title) ?? [] };
    } else if (entry.kind === "stop")
      stop = { code: entry.code, reason: entry.reason };
  }
  if (brief !== null)
    return { brief, lore, stop: null };
  return { brief: stop === null ? answer : null, lore, stop };
}
function loreChangesOf(entry) {
  const e = entry;
  if (!isRecord(e) || e.kind !== "result" || !isRecord(e.lore) || !Array.isArray(e.lore.added) || !Array.isArray(e.lore.dropped))
    return null;
  return { added: e.lore.added, dropped: e.lore.dropped, refused: Array.isArray(e.lore.refused) ? e.lore.refused : [] };
}
var isLimit = (v2) => v2 === undefined || v2 === null || typeof v2 === "number" && Number.isSafeInteger(v2) && v2 >= 0;
var isAllowance = (v2) => isRecord(v2) && isLimit(v2.tokensIn) && isLimit(v2.tokensOut) && isLimit(v2.toolTurns) && isLimit(v2.wallMs);
var isId = (v2) => typeof v2 === "string" && v2.length > 0 && v2.length <= 256;
var isIdOrNull = (v2) => v2 === null || isId(v2);
var isCount = (v2) => typeof v2 === "number" && Number.isSafeInteger(v2) && v2 >= 0;
var isSeq = (v2) => typeof v2 === "number" && Number.isSafeInteger(v2) && v2 >= 1;
var isPath = (v2) => Array.isArray(v2) && v2.every((key2) => typeof key2 === "string");
var isBool = (v2) => typeof v2 === "boolean";
var isText = (v2) => typeof v2 === "string";
var AREAS = { chat: true, learned: true, user: true };
var isArea = (v2) => typeof v2 === "string" && Object.hasOwn(AREAS, v2);
var isFilePath = (v2) => typeof v2 === "string" && v2.length > 0 && v2.length <= 1024;
var inArea = (r) => isArea(r.area) && (r.area === "user" ? isIdOrNull(r.chatId) : isId(r.chatId));
var isPage = (r) => isIdOrNull(r.cursor) && isCount(r.limit) && r.limit > 0;
var isChoice = (v2) => v2 === "allow" || v2 === "ask";
var AUTHS = { key: true, signin: true, none: true };
var EFFORTS2 = { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };
var isSignInProvider = (v2) => v2 === "anthropic" || v2 === "openai";
var isShort = (v2) => typeof v2 === "string" && v2.length <= 1024;
var isShortOrGone = (v2) => v2 === undefined || v2 === null || isShort(v2);
var isPasted = (v2) => typeof v2 === "string" && v2.length > 0 && v2.length <= 8192;
var toRuntime = (r) => r.relay === undefined || isId(r.relay);
var BODY = {
  "lah.hello": (r) => r.active === undefined || isIdOrNull(r.active),
  "lah.chat.get": (r) => isId(r.chatId),
  "lah.chat.set": (r) => isId(r.chatId) && typeof r.on === "boolean",
  "lah.chat.takeover": (r) => isId(r.chatId),
  "lah.chat.story.get": (r) => isId(r.chatId),
  "lah.chat.story.set": (r) => isId(r.chatId) && isRecord(r.story) && Object.entries(r.story).every(([member, value]) => STORY_MEMBERS.includes(member) && storyValue(member, value)),
  "lah.chat.lead.get": (r) => isId(r.chatId),
  "lah.live.open": (r) => isId(r.stream),
  "lah.live.events": (r) => isId(r.stream) && isId(r.turn) && isSeq(r.from),
  "lah.live.close": (r) => isId(r.stream),
  "lah.turn.stop": (r) => isId(r.stream) && isId(r.turn),
  "lah.turn.say": (r) => isId(r.stream) && isId(r.turn) && isText(r.text) && r.text.trim() !== "",
  "lah.turn.pause": (r) => isId(r.stream) && isId(r.turn) && isBool(r.on),
  "lah.approval.answer": (r) => isId(r.id) && isRecord(r.answer) && (r.answer.decision === "once" || r.answer.decision === "chat" || r.answer.decision === "refused" && (r.answer.reason === undefined || isText(r.answer.reason))),
  "lah.approvals.kept": (r) => isIdOrNull(r.chatId),
  "lah.approval.forget": (r) => isId(r.chatId) && isId(r.tool),
  "lah.turns.list": (r) => isId(r.chatId) && isPage(r),
  "lah.transcript.get": (r) => isId(r.transcript) && isSeq(r.from),
  "lah.prompt.get": (r) => isId(r.prompt),
  "lah.blob.get": (r) => isId(r.hash),
  "lah.session.rollback": (r) => isId(r.chatId) && isId(r.messageId) && isCount(r.swipe),
  "lah.session.summarize": (r) => isId(r.chatId),
  "lah.settings.set": (r) => Array.isArray(r.set) && r.set.every((s) => isRecord(s) && isPath(s.path) && s.value !== undefined) && Array.isArray(r.reset) && r.reset.every(isPath),
  "lah.text.set": (r) => isId(r.id) && typeof r.text === "string",
  "lah.text.reset": (r) => isId(r.id),
  "lah.key": (r) => r.op === "mint" || r.op === "forget",
  "lah.relay": (r) => (r.op === "rotate" || r.op === "forget") && isId(r.relay),
  "lah.drawer.close": () => true,
  "lah.runtime.service.get": (r) => isId(r.relay),
  "lah.runtime.service.set": (r) => isId(r.relay) && (r.memory === undefined || typeof r.memory === "string" && r.memory.length <= 32) && (r.autoUpdate === undefined || typeof r.autoUpdate === "boolean") && (r.restart === undefined || typeof r.restart === "boolean"),
  "lah.runtime.update.apply": (r) => isId(r.relay),
  "lah.ws.list": (r) => inArea(r),
  "lah.ws.read": (r) => inArea(r) && isFilePath(r.path) && (r.version === undefined || isId(r.version)),
  "lah.ws.write": (r) => inArea(r) && isFilePath(r.path) && isText(r.text) && isIdOrNull(r.base),
  "lah.ws.move": (r) => inArea(r) && isFilePath(r.from) && isFilePath(r.to) && isId(r.base),
  "lah.ws.delete": (r) => inArea(r) && isFilePath(r.path) && isId(r.base),
  "lah.ws.pin": (r) => inArea(r) && isFilePath(r.path) && isId(r.agent) && isBool(r.on),
  "lah.ws.history": (r) => inArea(r) && isFilePath(r.path),
  "lah.ws.changes": (r) => isId(r.chatId) && isId(r.messageId) && isCount(r.swipe),
  "lah.guidance.get": (r) => isIdOrNull(r.chatId),
  "lah.guidance.set": (r) => isIdOrNull(r.chatId) && (r.level === "user" || (r.level === "middle" || r.level === "chat") && isId(r.chatId)) && isText(r.text) && isIdOrNull(r.base),
  "lah.defs.get": () => true,
  "lah.agent.save": (r) => isRecord(r.agent) && isId(r.agent.id) && isText(r.agent.name) && isText(r.agent.description) && isText(r.agent.instructions),
  "lah.skill.save": (r) => isRecord(r.skill) && isId(r.skill.id) && isText(r.skill.name) && isText(r.skill.description) && isText(r.skill.body),
  "lah.def.remove": (r) => (r.kind === "agent" || r.kind === "skill") && isId(r.id),
  "lah.def.switch": (r) => (r.kind === "agent" || r.kind === "skill" || r.kind === "tool" || r.kind === "mcp") && isId(r.id) && isBool(r.off),
  "lah.tool.approval": (r) => isId(r.name) && (r.approval === null || isChoice(r.approval)),
  "lah.tier.approval": (r) => (r.tier === "read" || r.tier === "write" || r.tier === "external") && isChoice(r.approval),
  "lah.jobs.list": (r) => isIdOrNull(r.chatId) && isPage(r),
  "lah.jobs.set": (r) => (r.off === undefined || isBool(r.off)) && (r.paused === undefined || isBool(r.paused)) && (r.off !== undefined || r.paused !== undefined),
  "lah.job.start": (r) => isId(r.chatId) && isId(r.agent) && isText(r.task) && r.task.trim() !== "" && (r.when === "now" || r.when === "after_reply") && (r.allowance === undefined || isAllowance(r.allowance)) && (r.story === undefined || r.story === true),
  "lah.job.cancel": (r) => isId(r.id),
  "lah.job.again": (r) => isId(r.id),
  "lah.job.grant": (r) => isId(r.id) && isAllowance(r.allowance),
  "lah.job.resume": (r) => isId(r.id),
  "lah.notice.dismiss": (r) => isIdOrNull(r.id),
  "lah.side.list": () => true,
  "lah.side.start": (r) => isId(r.agent) && isIdOrNull(r.chatId),
  "lah.side.turns": (r) => isId(r.session) && isPage(r),
  "lah.side.send": (r) => isId(r.session) && isText(r.text) && r.text.trim() !== "",
  "lah.side.remove": (r) => isId(r.session),
  "lah.spend.get": (r) => isCount(r.days) && r.days > 0 && (r.timeZone === undefined || isText(r.timeZone)),
  "lah.upkeep.get": () => true,
  "lah.upkeep.sweep": () => true,
  "lah.home.get": (r) => isIdOrNull(r.chatId),
  "lah.runtime.store": (r) => isId(r.relay),
  "lah.runtime.chatdata": (r) => isId(r.relay),
  "lah.runtime.database": (r) => typeof r.on === "boolean",
  "lah.timings.get": () => true,
  "lah.lore.get": (r) => isId(r.chatId),
  "lah.lore.entry": (r) => isId(r.chatId) && isId(r.entryId),
  "lah.lore.search": (r) => isId(r.chatId) && Array.isArray(r.queries) && r.queries.length > 0 && r.queries.every((q) => isText(q) && q.trim() !== "") && (r.limit === undefined || isCount(r.limit) && r.limit > 0),
  "lah.lore.embed": (r) => isId(r.chatId) && isBool(r.start),
  "lah.chronicle.get": (r) => isId(r.chatId),
  "lah.chronicle.cited": (r) => isId(r.chatId) && Array.isArray(r.citations) && r.citations.length > 0 && r.citations.every(isId),
  "lah.story.get": (r) => isId(r.chatId),
  "lah.connections.list": toRuntime,
  "lah.connections.save": (r) => {
    const c = r.connection;
    if (!isRecord(c) || !(c.id === undefined || isId(c.id)) || !isShort(c.name) || !isId(c.provider) || typeof c.auth !== "string" || !Object.hasOwn(AUTHS, c.auth))
      return false;
    if (!isShortOrGone(c.baseUrl) || !isShortOrGone(c.api) || !isShortOrGone(c.model) || !(c.effort === undefined || c.effort === null || typeof c.effort === "string" && Object.hasOwn(EFFORTS2, c.effort)))
      return false;
    if (!(c.headers === undefined || c.headers === null || isRecord(c.headers) && Object.entries(c.headers).every(([name, value]) => name.length > 0 && name.length <= 256 && (value === null || isPasted(value)))))
      return false;
    return toRuntime(r) && (r.key === undefined || r.key === null || isPasted(r.key)) && (r.create === undefined || r.create === true && isId(c.id));
  },
  "lah.connections.remove": (r) => toRuntime(r) && isId(r.id),
  "lah.connections.default": (r) => toRuntime(r) && isIdOrNull(r.id),
  "lah.connections.test": (r) => toRuntime(r) && isId(r.id),
  "lah.connections.models": (r) => toRuntime(r) && (r.provider === undefined ? isIdOrNull(r.connectionId) : isId(r.provider) && r.connectionId === undefined),
  "lah.connections.lumiverse": () => true,
  "lah.signin.start": (r) => toRuntime(r) && isSignInProvider(r.provider),
  "lah.signin.finish": (r) => toRuntime(r) && isId(r.flow) && isPasted(r.code),
  "lah.signin.cancel": (r) => toRuntime(r) && isId(r.flow),
  "lah.signin.out": (r) => toRuntime(r) && isSignInProvider(r.provider),
  "lah.signin.state": (r) => toRuntime(r) && isSignInProvider(r.provider)
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

// src/extension/backend/cause.ts
var LIMITS = {
  revisions: true,
  call_tokens_in: true,
  tokens_in: true,
  tokens_out: true,
  tool_turns: true,
  turn_tokens_in: true,
  turn_tokens_out: true,
  turn_tool_turns: true,
  call_time: true,
  wall_time: true,
  turn_time: true,
  throttle: true,
  spend: true
};
function causeOf(events) {
  let main = null;
  let refused2 = false;
  let called = false;
  let stop = null;
  for (const { event } of events) {
    if (event.kind === "agent_started") {
      if (main === null && isRecord2(event.agent) && typeof event.agent.id === "string" && event.agent.parent === undefined)
        main = event.agent.id;
      continue;
    }
    if (event.kind !== "agent_entry" || main === null || event.agentId !== main || !isRecord2(event.entry))
      continue;
    const { entry } = event;
    if (entry.kind === "tools_refused")
      refused2 = true;
    else if (entry.kind === "answer" && Array.isArray(entry.calls) && entry.calls.length > 0)
      called = true;
    else if (entry.kind === "stop")
      stop = typeof entry.code === "string" ? entry.code : null;
  }
  if (stop !== null && Object.hasOwn(LIMITS, stop))
    return "limit";
  return refused2 && !called ? "no_tools" : null;
}

// src/extension/backend/views.ts
function refuse(what) {
  throw new UiRefused("internal", `The core answered with something that isn't ${what}. If a runtime answered, update the runtime and the extension to the same build.`);
}
var isObject = (v2) => typeof v2 === "object" && v2 !== null && !Array.isArray(v2);
var isText2 = (v2) => typeof v2 === "string";
var record = (v2, what) => isObject(v2) ? v2 : refuse(what);
var list = (v2, what) => Array.isArray(v2) ? v2 : refuse(what);
var text3 = (v2, what) => typeof v2 === "string" ? v2 : refuse(what);
var number = (v2, what) => typeof v2 === "number" && Number.isFinite(v2) ? v2 : refuse(what);
var flag3 = (v2, what) => typeof v2 === "boolean" ? v2 : refuse(what);
var textOrNull = (v2, what) => v2 === null ? null : text3(v2, what);
var numberOrNull = (v2, what) => v2 === null ? null : number(v2, what);
function oneOf(v2, among, what) {
  return typeof v2 === "string" && Object.hasOwn(among, v2) ? v2 : refuse(what);
}
var AREAS2 = { chat: true, learned: true, user: true };
var SOURCES = { builtin: true, extension: true, user: true };
var TIERS = { read: true, write: true, external: true };
var JOB_STATES = { queued: true, running: true, done: true, failed: true, cancelled: true, interrupted: true, off_path: true, spent: true, paused: true };
var TURN_ENDS = { done: true, failed: true, stopped: true };
var LEVELS = { user: true, middle: true, chat: true };
var OWNED = { instructions: true, tools: true, name: true, description: true };
var UNUSABLE = { off: true, withdrawn: true, unknown: true };
function namedOf(v2, what) {
  return list(v2, what).map((one) => {
    const o = record(one, what);
    return { id: text3(o.id, what), name: text3(o.name, what) };
  });
}
function authorOf(v2, what) {
  const o = record(v2, what);
  if (o.who === "user")
    return { who: "user" };
  if (o.who === "agent" || o.who === "job")
    return { who: o.who, id: text3(o.id, what), role: text3(o.role, what) };
  return refuse(what);
}
function isUsage(v2) {
  return isRecord2(v2) && [v2.calls, v2.toolTurns, v2.in, v2.cachedIn, v2.out, v2.reasoningOut, v2.ms].every((n) => typeof n === "number") && typeof v2.estimated === "boolean";
}
function pageOf(rows, cursor, limit2) {
  const from = cursor === null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(from) || from < 0)
    return null;
  const page = rows.slice(from, from + limit2);
  return { rows: page, next: from + page.length < rows.length ? String(from + page.length) : null };
}
var A_FILE = "a workspace file";
function fileOf(v2) {
  const o = record(v2, A_FILE);
  return { path: text3(o.path, A_FILE), hash: text3(o.hash, A_FILE), chars: number(o.chars, A_FILE), at: number(o.at, A_FILE), by: authorOf(o.by, A_FILE), pins: list(o.pins, A_FILE).map((pin) => text3(pin, A_FILE)) };
}
function areaView(raw) {
  const what = "an area of the workspace";
  const o = record(raw, what);
  const limits = record(o.limits, what);
  const basis = o.basis === null ? null : record(o.basis, what);
  const core = {
    area: oneOf(o.area, AREAS2, what),
    files: list(o.files, what).map(fileOf),
    chars: number(o.chars, what),
    limits: { fileChars: number(limits.fileChars, what), files: number(limits.files, what), areaChars: number(limits.areaChars, what), pinChars: number(limits.pinChars, what) },
    agents: namedOf(o.agents, what),
    basis: basis === null ? null : { messageId: text3(basis.messageId, what), swipe: number(basis.swipe, what), index: number(basis.index, what) }
  };
  return core;
}
function versionOf(v2, what) {
  const o = record(v2, what);
  return { hash: text3(o.hash, what), chars: number(o.chars, what), at: number(o.at, what), by: authorOf(o.by, what) };
}
function fileRead(raw) {
  const o = record(raw, A_FILE);
  const core = { file: fileOf(o.file), text: text3(o.text, A_FILE), version: versionOf(o.version, A_FILE) };
  return { file: core.file, text: core.text, version: core.version.hash };
}
function fileChanged(raw) {
  const core = { file: fileOf(record(raw, A_FILE).file) };
  return core;
}
function versionsOf(raw) {
  const what = "a file's versions";
  return { versions: list(record(raw, what).versions, what).map((one) => versionOf(one, what)) };
}
function madeIn(version, turns) {
  const { at: at2, by } = version;
  if (by.who === "user")
    return null;
  const turn = by.who === "job" ? turns.findLast((t) => t.record.jobs?.some((job) => job.id === by.id) === true) : turns.findLast((t) => t.record.began !== undefined && t.record.began <= at2 && at2 <= t.record.at);
  return turn === undefined ? null : { messageId: turn.messageId, swipe: turn.swipeId, index: turn.index };
}
function versionsView(core, turns) {
  return { versions: core.versions.map((version) => ({ hash: version.hash, chars: version.chars, at: version.at, by: version.by, turn: madeIn(version, turns) })) };
}
function changesView(raw) {
  const what = "a turn's change set";
  const core = {
    changes: list(record(raw, what).changes, what).map((one) => {
      const o = record(one, what);
      return { area: oneOf(o.area, AREAS2, what), path: text3(o.path, what), before: textOrNull(o.before, what), after: textOrNull(o.after, what), by: authorOf(o.by, what) };
    })
  };
  return core;
}
function guidanceOf(raw) {
  const what = "the guidance";
  const o = record(raw, what);
  return {
    levels: list(o.levels, what).map((one) => {
      const level = record(one, what);
      return {
        id: oneOf(level.id, LEVELS, what),
        whose: text3(level.whose, what),
        text: text3(level.text, what),
        path: textOrNull(level.path, what),
        hash: textOrNull(level.hash, what),
        at: numberOrNull(level.at, what),
        by: level.by === null ? null : authorOf(level.by, what),
        editable: flag3(level.editable, what),
        ...level.locked !== undefined ? { locked: text3(level.locked, what) } : {}
      };
    }),
    limit: number(o.limit, what),
    agentsEdit: flag3(o.agentsEdit, what)
  };
}
function noted(path, words) {
  return path === null ? words.replace(/^./, (first) => first.toUpperCase()) : `${path}: ${words}`;
}
function levelWords(level, character) {
  if (level.id === "user")
    return { label: "Yours", note: noted(level.path, "every agent of every chat of yours is given it.") };
  if (level.id === "chat")
    return { label: "This chat's", note: noted(level.path, "kept with this chat, whatever path its story takes.") };
  if (character !== null && level.path === showPath("user", characterGuidance(character.id))) {
    const name = character.name !== null && character.name.trim() !== "" ? character.name : null;
    return name === null ? { label: "The character's", note: noted(level.path, "every chat of yours with this chat's character is given it.") } : { label: `${name}'s`, note: noted(level.path, `every chat of yours with ${name} is given it.`) };
  }
  return { label: "The extension's", note: noted(level.path, `named by the extension that answers this chat, in the character's place. Agents are told it is guidance ${level.whose}.`) };
}
function guidanceView(core, character) {
  return {
    levels: core.levels.map((level) => ({ id: level.id, ...levelWords(level, character), text: level.text, hash: level.hash, at: level.at, by: level.by, editable: level.editable, ...level.locked !== undefined ? { locked: level.locked } : {} })),
    limit: core.limit,
    agentsEdit: core.agentsEdit
  };
}
function isSourced(o) {
  return isText2(o.source) && Object.hasOwn(SOURCES, o.source) && typeof o.off === "boolean" && (o.over === undefined || o.over === "builtin" || o.over === "extension");
}
function isAgent(v2) {
  if (!isRecord2(v2) || !isSourced(v2))
    return false;
  const runsWith = (v2.connectionId === null || isText2(v2.connectionId)) && (v2.model === null || isText2(v2.model)) && isText2(v2.effort) && isText2(v2.toolCalls) && Array.isArray(v2.tools) && v2.tools.every(isText2) && isRecord2(v2.budget);
  const page = (v2.owns === undefined || Array.isArray(v2.owns) && v2.owns.every((field) => isText2(field) && Object.hasOwn(OWNED, field))) && (v2.lacks === undefined || Array.isArray(v2.lacks) && v2.lacks.every(isText2));
  return runsWith && page && isText2(v2.id) && isText2(v2.name) && isText2(v2.description) && isText2(v2.instructions) && (v2.given === "request" || v2.given === "task");
}
function isSkill(v2) {
  return isRecord2(v2) && isSourced(v2) && isText2(v2.id) && isText2(v2.name) && isText2(v2.description) && isText2(v2.body) && (v2.owned === undefined || v2.owned === true) && (v2.agents === undefined || Array.isArray(v2.agents) && v2.agents.every(isText2));
}
function toolOf(v2) {
  const what = "a tool";
  const o = record(v2, what);
  return {
    name: text3(o.name, what),
    family: text3(o.family, what),
    tier: oneOf(o.tier, TIERS, what),
    description: text3(o.description, what),
    ...o.parameters !== undefined ? { parameters: record(o.parameters, what) } : {},
    runs: o.runs === "runtime" || o.runs === "extension" ? o.runs : refuse(what),
    source: oneOf(o.source, SOURCES, what),
    off: flag3(o.off, what)
  };
}
function defsView(raw, approval, mcp) {
  const what = "the definitions";
  const o = record(raw, what);
  return {
    agents: list(o.agents, what).map((one) => isAgent(one) ? one : refuse("an agent definition")),
    skills: list(o.skills, what).map((one) => isSkill(one) ? one : refuse("a skill")),
    tools: list(o.tools, what).map((one) => {
      const tool = toolOf(one);
      const own = Object.hasOwn(approval.tools, tool.name) ? approval.tools[tool.name] ?? null : null;
      return { ...tool, approval: own, asks: (own ?? approval.tiers[tool.tier]) === "ask" };
    }),
    mcp,
    agentSchema: record(o.agentSchema, what),
    agentDefaults: record(o.agentDefaults, what),
    tiers: { ...approval.tiers }
  };
}
function agentNames(raw) {
  const what = "the definitions";
  return new Map(namedOf(record(raw, what).agents, what).map((agent) => [agent.id, agent.name]));
}
function heldView(raw) {
  const what = "what each agent holds";
  return list(record(raw, what).agents, what).map((one) => {
    const o = record(one, what);
    return {
      id: text3(o.id, what),
      name: text3(o.name, what),
      holds: list(o.holds, what).map((tool) => text3(tool, what)),
      cannot: list(o.cannot, what).map((row) => {
        const r = record(row, what);
        return { tool: text3(r.tool, what), why: oneOf(r.why, UNUSABLE, what) };
      })
    };
  });
}
function isJob(v2) {
  if (!isRecord2(v2) || !isRecord2(v2.by))
    return false;
  const what = isText2(v2.id) && isText2(v2.chatId) && isText2(v2.agent) && isText2(v2.task) && (v2.when === "now" || v2.when === "after_reply");
  return what && isText2(v2.state) && Object.hasOwn(JOB_STATES, v2.state) && (v2.by.who === "user" || v2.by.who === "agent") && (v2.basis === null || isText2(v2.basis)) && typeof v2.createdAt === "number" && isUsage(v2.usage);
}
function jobOf(raw) {
  const job = isObject(raw) ? raw.job : undefined;
  return isJob(job) ? job : refuse("a job");
}
function jobsOf(raw) {
  const what = "a page of jobs";
  const o = record(raw, what);
  return {
    jobs: list(o.jobs, what).map((one) => isJob(one) ? one : refuse("a job")),
    next: textOrNull(o.next, what),
    today: { tokens: number(record(o.today, what).tokens, what) },
    agents: namedOf(o.agents, what),
    paused: flag3(o.paused, what)
  };
}
function jobsPage(core, limits, cursor) {
  const before = cursor === null ? 0 : Number(cursor);
  const { tokensIn, tokensOut, wallMs } = limits.budget;
  return {
    jobs: core.jobs,
    next: core.next,
    total: (Number.isSafeInteger(before) && before > 0 ? before : 0) + core.jobs.length,
    limits: { atOnce: limits.atOnce, tokensPerJob: tokensIn === null && tokensOut === null ? null : (tokensIn ?? 0) + (tokensOut ?? 0), msPerJob: wallMs, tokensPerDay: limits.tokensPerDay },
    today: core.today,
    agents: core.agents
  };
}
function sideOf(v2) {
  const what = "a side session";
  const o = record(v2, what);
  return { id: text3(o.id, what), chatId: text3(o.chatId, what), agent: text3(o.agent, what), title: text3(o.title, what), createdAt: number(o.createdAt, what), lastAt: number(o.lastAt, what), turns: number(o.turns, what) };
}
function sidesOf(raw) {
  const what = "the side sessions";
  return { sides: list(record(raw, what).sides, what).map(sideOf) };
}
function sideStartedOf(raw) {
  return { side: sideOf(record(raw, "a side session").side) };
}
function sideTurnsOf(raw) {
  const what = "a side session's turns";
  const o = record(raw, what);
  return {
    side: sideOf(o.side),
    turns: list(o.turns, what).map((one) => {
      const turn = record(one, what);
      const usage = turn.usage;
      return {
        turn: text3(turn.turn, what),
        at: number(turn.at, what),
        asked: text3(turn.asked, what),
        answered: textOrNull(turn.answered, what),
        status: oneOf(turn.status, TURN_ENDS, what),
        ...turn.reason !== undefined ? { reason: text3(turn.reason, what) } : {},
        ...turn.segment !== undefined ? { segment: text3(turn.segment, what) } : {},
        ...turn.transcript !== undefined ? { transcript: text3(turn.transcript, what) } : {},
        usage: isUsage(usage) ? usage : refuse(what)
      };
    })
  };
}
function turnStarted(raw) {
  const turn = isObject(raw) ? raw.turn : undefined;
  return typeof turn === "string" && turn !== "" ? turn : refuse("the turn it started");
}
var NEW_TALK = "New conversation";
function sideSession(row, names, unkept, titleChars) {
  const title = row.title !== "" || unkept === null ? row.title : clip(unkept.said.replace(/\s+/g, " ").trim(), titleChars);
  return {
    id: row.id,
    agent: row.agent,
    agentName: names.get(row.agent) ?? row.agent,
    chatId: row.chatId === "" ? null : row.chatId,
    title: title !== "" ? title : NEW_TALK,
    createdAt: row.createdAt,
    lastAt: unkept === null ? row.lastAt : Math.max(row.lastAt, unkept.at),
    turns: row.turns + (unkept === null ? 0 : 1)
  };
}
function sideTurns(kept, unkept) {
  const turns = kept.map((turn) => ({ turn: turn.turn, at: turn.at, said: turn.asked, answer: turn.answered, state: turn.status, transcript: turn.transcript ?? null, usage: turn.usage })).reverse();
  return unkept === null ? turns : [{ turn: unkept.turn, at: unkept.at, said: unkept.said, answer: null, state: unkept.state, transcript: null, usage: null }, ...turns];
}
function settingOf(settings, setting) {
  const path = [settings.coreKey, ...setting];
  let schema = settings.schema;
  let value = settings.values;
  for (const key2 of path) {
    const properties = isObject(schema) ? schema.properties : undefined;
    schema = isObject(properties) && Object.hasOwn(properties, key2) ? properties[key2] : undefined;
    value = isObject(value) && Object.hasOwn(value, key2) ? value[key2] : undefined;
  }
  const node = isObject(schema) ? schema : {};
  return { path, title: isText2(node.title) ? node.title : setting.join("."), unit: isText2(node["x-unit"]) ? node["x-unit"] : null, none: isText2(node["x-none"]) ? node["x-none"] : "No limit", value };
}
var CAP_UNITS = { tokens: true, usd: true };
function spendRowOf(v2) {
  const what = "a row of spend";
  const o = record(v2, what);
  return { key: text3(o.key, what), calls: number(o.calls, what), in: number(o.in, what), cachedIn: number(o.cachedIn, what), out: number(o.out, what), cost: number(o.cost, what), unpriced: number(o.unpriced, what) };
}
function spendOf(raw) {
  const what = "the spend";
  const o = record(raw, what);
  const rows = (v2) => list(v2, what).map(spendRowOf);
  return {
    days: rows(o.days),
    chats: rows(o.chats),
    agents: rows(o.agents),
    connections: rows(o.connections),
    models: rows(o.models),
    total: spendRowOf(o.total),
    caps: list(o.caps, what).map((one) => {
      const cap = record(one, what);
      return { setting: list(cap.setting, what).map((key2) => text3(key2, what)), unit: oneOf(cap.unit, CAP_UNITS, what), limit: numberOrNull(cap.limit, what), used: number(cap.used, what), reached: flag3(cap.reached, what) };
    })
  };
}
var ID_CHARS = 8;
function chatLabel(chatId, names) {
  if (chatId === "")
    return "No chat";
  const name = names.get(chatId);
  if (name === null)
    return `A chat that is gone (${chatId.slice(0, ID_CHARS)})`;
  return name !== undefined && name.trim() !== "" ? name : `Chat ${chatId.slice(0, ID_CHARS)}`;
}
function spendView(core, names, settings) {
  const rows = (of, label) => of.map((row) => ({ ...row, label: label(row.key) }));
  const days = core.days.length;
  return {
    days: rows(core.days, (day) => day),
    chats: rows(core.chats, (chatId) => chatLabel(chatId, names.chats)),
    agents: rows(core.agents, (id) => names.agents.get(id) ?? (id !== "" ? id : "An agent with no name")),
    connections: rows(core.connections, (id) => names.connections.get(id) ?? `A connection that is gone (${id.slice(0, ID_CHARS)})`),
    models: rows(core.models, (model) => model),
    total: { ...core.total, label: days === 1 ? "Today" : `The last ${days} days` },
    caps: core.caps.map((cap) => {
      const { path, title } = settingOf(settings, cap.setting);
      return { path, label: title, unit: cap.unit, limit: cap.limit, used: cap.used, reached: cap.reached };
    })
  };
}
var KIND_LABELS = {
  segment: "Turns' notes",
  summary: "Summaries",
  transcript: "Transcripts",
  prompt: "Prompts",
  index: "Workspace indexes",
  file: "Workspace file versions",
  report: "Job reports",
  session: "Jobs' sessions",
  side: "Conversations with agents"
};
function upkeepOf(raw) {
  const what = "what is stored";
  const o = record(raw, what);
  const total = record(o.total, what);
  const loose = o.loose === null ? null : record(o.loose, what);
  const last = o.lastSweep === null ? null : record(o.lastSweep, what);
  return {
    kinds: list(o.kinds, what).map((one) => {
      const kind = record(one, what);
      return { kind: oneOf(kind.kind, KIND_LABELS, what), count: number(kind.count, what), bytes: number(kind.bytes, what), oldestAt: numberOrNull(kind.oldestAt, what), keep: kind.keep === null ? null : list(kind.keep, what).map((key2) => text3(key2, what)) };
    }),
    total: { count: number(total.count, what), bytes: number(total.bytes, what) },
    loose: loose === null ? null : { count: number(loose.count, what), bytes: number(loose.bytes, what), at: number(loose.at, what) },
    lastSweep: last === null ? null : { at: number(last.at, what), removed: number(last.removed, what), bytes: number(last.bytes, what), ms: number(last.ms, what) },
    sweeping: flag3(o.sweeping, what)
  };
}
var ONE_OF = { days: "day", hours: "hour" };
function keptWords(setting) {
  const { value, unit } = setting;
  if (typeof value !== "number")
    return value === null ? setting.none : "As Settings say";
  if (unit === null)
    return String(value);
  return `${value} ${value === 1 && Object.hasOwn(ONE_OF, unit) ? ONE_OF[unit] : unit}`;
}
function upkeepView(core, settings) {
  return {
    kinds: core.kinds.map((kind) => {
      const setting = kind.keep === null ? null : settingOf(settings, kind.keep);
      return { kind: kind.kind, label: KIND_LABELS[kind.kind], count: kind.count, bytes: kind.bytes, kept: setting === null ? null : { path: setting.path, words: keptWords(setting) }, oldestAt: kind.oldestAt };
    }),
    total: core.total,
    loose: core.loose,
    lastSweep: core.lastSweep,
    sweeping: core.sweeping
  };
}
var isCount2 = (v2) => typeof v2 === "number" && Number.isFinite(v2);
function listOf(v2, is) {
  return Array.isArray(v2) && v2.every(is);
}
var isBook = (v2) => isRecord2(v2) && isText2(v2.id) && isText2(v2.name) && isCount2(v2.entries);
var isLoreRow = (v2) => isRecord2(v2) && isText2(v2.entryId) && isText2(v2.short) && isText2(v2.bookId) && isText2(v2.title) && Array.isArray(v2.keys) && isCount2(v2.chars) && isText2(v2.state);
var isLastTurn = (v2) => v2 === null || isRecord2(v2) && isText2(v2.generationId) && isCount2(v2.at);
var isEmbedding = (v2) => isRecord2(v2) && (v2.connection === null || isRecord2(v2.connection)) && typeof v2.enabled === "boolean" && isRecord2(v2.lore) && isRecord2(v2.messages) && isCount2(v2.pending) && isCount2(v2.pendingTokens) && typeof v2.working === "boolean" && isRecord2(v2.today) && isRecord2(v2.all);
function loreView(raw) {
  const what = "a chat's lore";
  const { books, entries, last, embedding } = record(raw, what);
  if (!listOf(books, isBook) || !listOf(entries, isLoreRow) || !isLastTurn(last) || !isEmbedding(embedding))
    return refuse(what);
  const core = { books, entries, last, embedding };
  return { ...core, embedding };
}
function loreEntry(raw) {
  const what = "a lore entry";
  const { entry, text: body } = record(raw, what);
  if (!isLoreRow(entry) || !isText2(body))
    return refuse(what);
  const core = { entry, text: body };
  return core;
}
var isHit = (v2) => isRecord2(v2) && isText2(v2.entryId) && isText2(v2.short) && isText2(v2.title) && isCount2(v2.score) && Array.isArray(v2.lines);
var isFound = (v2) => isRecord2(v2) && isText2(v2.query) && isCount2(v2.total) && listOf(v2.hits, isHit);
var MEANING = { on: true, off: true, none: true };
function loreSearch(raw) {
  const what = "what a lore search found";
  const o = record(raw, what);
  const { queries } = o;
  if (!listOf(queries, isFound))
    return refuse(what);
  const core = { queries, meaning: oneOf(o.meaning, MEANING, what) };
  return core;
}
function embeddingView(raw) {
  const what = "how search by meaning stands";
  const { embedding } = record(raw, what);
  if (!isEmbedding(embedding))
    return refuse(what);
  const core = { embedding };
  return { ...core, embedding };
}
var isLine = (v2) => isRecord2(v2) && isText2(v2.path) && isCount2(v2.line);
var isChronicleFile = (v2) => isRecord2(v2) && isText2(v2.path) && isCount2(v2.chars) && isCount2(v2.lines) && isCount2(v2.cited) && isCount2(v2.failed);
var isFailure = (v2) => isLine(v2) && isText2(v2.text) && isText2(v2.citation) && isCount2(v2.index) && (v2.why === "gone" || v2.why === "changed");
var isMoved = (v2) => isLine(v2) && isText2(v2.citation) && isCount2(v2.index) && isCount2(v2.now);
var isUncited = (v2) => isLine(v2) && isText2(v2.text);
function chronicleView(raw) {
  const what = "a chat's chronicle";
  const { files, failures, moved, uncited } = record(raw, what);
  if (!listOf(files, isChronicleFile) || !listOf(failures, isFailure) || !listOf(moved, isMoved) || !listOf(uncited, isUncited))
    return refuse(what);
  const core = { files, failures, moved, uncited };
  return core;
}
var isCited = (v2) => isRecord2(v2) && isCount2(v2.index) && typeof v2.ok === "boolean" && (v2.message === null || isRecord2(v2.message) && isText2(v2.message.text));
function citedView(raw) {
  const what = "the messages a chronicle cites";
  const { cited } = record(raw, what);
  if (!listOf(cited, isCited))
    return refuse(what);
  const core = { cited };
  return core;
}
function storyOf(raw) {
  const what = "how far a story's learning has come";
  const o = record(raw, what);
  const suggested = record(o.suggested, what);
  const e = record(o.estimate, what);
  const estimate = {
    messages: number(e.messages, what),
    chars: number(e.chars, what),
    stretches: number(e.stretches, what),
    promptTokens: number(e.promptTokens, what),
    cachedTokens: number(e.cachedTokens, what),
    writtenTokens: number(e.writtenTokens, what),
    weighedTokens: number(e.weighedTokens, what),
    toolTurns: number(e.toolTurns, what),
    usd: numberOrNull(e.usd, what)
  };
  return { plan: textOrNull(o.plan, what), messages: number(o.messages, what), covered: number(o.covered, what), suggested: { task: text3(suggested.task, what), agent: text3(suggested.agent, what) }, estimate, refused: typeof o.refused === "string" ? o.refused : null };
}
function storyView(core, job) {
  return { ...core, job };
}
function keptOf(raw) {
  const what = "the tools you approved for a chat";
  return list(record(raw, what).kept, what).map((one) => {
    const row = record(one, what);
    return { chatId: text3(row.chatId, what), tool: text3(row.tool, what), at: numberOrNull(row.at, what) };
  });
}
function runCounts(events) {
  let usage = null;
  let agents = 0;
  let tools = 0;
  let lore = { added: 0, dropped: 0 };
  const files = new Set;
  const jobs = new Set;
  for (const { event } of events) {
    if (event.kind === "agent_started")
      agents += 1;
    else if (event.kind === "agent_entry") {
      const { entry } = event;
      if (entry.kind === "answer")
        tools += Array.isArray(entry.calls) ? entry.calls.length : 0;
      else if (entry.kind === "result") {
        for (const file of Array.isArray(entry.files) ? entry.files : [])
          files.add(`${file.area}\x00${file.path}`);
        const changed = loreChangesOf(entry);
        if (changed !== null)
          lore = { added: changed.added.length, dropped: changed.dropped.length };
      }
    } else if (event.kind === "usage")
      usage = event.turn;
    else if (event.kind === "job")
      jobs.add(event.job.id);
    else if (event.kind === "turn_ended")
      usage = event.usage;
  }
  return { usage, agents, tools, lore, changes: files.size, jobs: jobs.size };
}
function lastOfLive(view, kind, kept) {
  const counts = runCounts(view.events);
  return {
    turn: view.turn,
    kind,
    messageId: kept?.messageId ?? view.messageId,
    startedAt: view.startedAt,
    ended: view.ended,
    usage: counts.usage,
    agents: counts.agents,
    tools: counts.tools,
    lore: counts.lore,
    changes: counts.changes,
    jobs: counts.jobs,
    transcript: kept?.transcript ?? null,
    did: replyDid(view.events)
  };
}
function lastOfRecord(reply, stored) {
  const { record: record2 } = reply;
  const counts = stored === null ? null : runCounts(stored.events);
  const state2 = stored?.ended.status ?? "done";
  const reason = stored?.ended.reason;
  const cause = stored !== null && state2 === "failed" ? causeOf(stored.events) : null;
  return {
    turn: record2.generationId,
    kind: record2.kind,
    messageId: reply.messageId,
    startedAt: stored?.startedAt ?? record2.began ?? record2.at,
    ended: { state: state2, at: stored?.ended.at ?? record2.at, ...reason !== undefined ? { reason } : {}, ...cause !== null ? { cause } : {} },
    usage: record2.usage,
    agents: counts?.agents ?? 0,
    tools: counts?.tools ?? 0,
    lore: counts?.lore ?? { added: 0, dropped: 0 },
    changes: counts?.changes ?? record2.changed ?? 0,
    jobs: counts?.jobs ?? record2.jobs?.length ?? 0,
    transcript: stored === null ? null : record2.transcript ?? null,
    ...stored !== null ? { did: replyDid(stored.events) } : {}
  };
}

// src/extension/backend/defs.ts
var strings = (raw) => Array.isArray(raw) ? raw.filter((s) => typeof s === "string" && s !== "") : [];
var records = (raw) => {
  const out = {};
  if (isRecord2(raw)) {
    for (const [id, one] of Object.entries(raw))
      if (isRecord2(one))
        out[id] = one;
  }
  return out;
};
function storedOf(raw) {
  const off = isRecord2(raw.off) ? raw.off : {};
  return { agents: records(raw.agents), skills: records(raw.skills), off: { agents: strings(off.agents), skills: strings(off.skills), tools: strings(off.tools) }, mcp: strings(raw.mcp) };
}
var DEF_ID = /^[a-z][a-z0-9_-]{0,63}$/;
function idOf(id, what) {
  if (!DEF_ID.test(id))
    throw new UiRefused("invalid", `${what} is named by lower-case letters, digits, "_" and "-", starting with a letter (64 at most).`, [{ path: ["id"], message: "Not a name a definition can have." }]);
  return id;
}
var KIND_KEY = { agent: "agents", skill: "skills", tool: "tools" };

class Definitions {
  deps;
  now;
  revs = new Map;
  changed = [];
  constructor(deps, now) {
    this.deps = deps;
    this.now = now;
  }
  onChange(listener) {
    this.changed.push(listener);
  }
  rev(userId) {
    let rev = this.revs.get(userId);
    if (rev === undefined) {
      rev = this.now();
      this.revs.set(userId, rev);
    }
    return rev;
  }
  moved(userId) {
    this.revs.set(userId, this.rev(userId) + 1);
    for (const listener of this.changed)
      listener(userId);
  }
  async mcpOn(userId) {
    return storedOf(await this.deps.settings.definitions(userId)).mcp;
  }
  async edit(userId, change) {
    const raw = await this.deps.settings.definitions(userId);
    const stored = storedOf(raw);
    change(stored);
    await this.deps.settings.setDefinitions(userId, { ...raw, agents: stored.agents, skills: stored.skills, off: stored.off, mcp: stored.mcp });
    this.moved(userId);
  }
  async approval(userId) {
    const core = (await this.deps.settings.values(userId))[this.deps.coreKey];
    const approval = isRecord2(core) && isRecord2(core.approval) ? core.approval : {};
    const choice2 = (v2) => v2 === "ask" ? "ask" : "allow";
    const tiers = isRecord2(approval.tiers) ? approval.tiers : {};
    const tools = {};
    if (isRecord2(approval.tools)) {
      for (const [name, rule] of Object.entries(approval.tools))
        if (rule === "ask" || rule === "allow")
          tools[name] = rule;
    }
    return { tiers: { read: choice2(tiers.read), write: choice2(tiers.write), external: choice2(tiers.external) }, tools };
  }
  async view(userId) {
    const merged2 = await this.deps.asks.ask(userId, "definitions.get", {});
    const servers = await this.deps.mcp.servers(userId);
    const mcp = servers.map((s) => ({ id: s.id, name: s.name, off: !s.on, status: !s.enabled ? "stopped" : s.problem !== null ? "failed" : "ready", ...s.problem !== null ? { problem: s.problem } : {}, tools: s.tools.length }));
    return defsView(merged2, await this.approval(userId), mcp);
  }
  async merged(userId) {
    const merged2 = await this.deps.asks.ask(userId, "definitions.get", {});
    return isRecord2(merged2) ? merged2 : {};
  }
  async saveAgent(userId, agent) {
    const id = idOf(agent.id, "An agent");
    const merged2 = await this.merged(userId);
    const tools = merged2.tools;
    const names = [...new Set([...(Array.isArray(tools) ? tools : []).flatMap((t) => isRecord2(t) && typeof t.name === "string" ? [t.name, ...typeof t.family === "string" && t.family !== "" ? [`@${t.family}`] : []] : []), ADDED_TOOLS])];
    const row = (Array.isArray(merged2.agents) ? merged2.agents : []).find((a) => isRecord2(a) && a.id === id);
    const owned = isRecord2(row) && (row.source === "extension" || row.over === "extension") && Array.isArray(row.owns) ? row.owns.filter((field) => typeof field === "string") : [];
    const given = { ...agent };
    for (const field of owned)
      if (field !== "tools" && isRecord2(row))
        given[field] = row[field];
    if (owned.includes("tools"))
      delete given.tools;
    const checked = checkAgent(given, names);
    const kept = checked.agent;
    if (kept === null || checked.problems.length > 0)
      throw new UiRefused("invalid", "The agent wasn't saved: it has something the core refuses.", checked.problems.map((p) => ({ path: [...p.path], message: p.message })));
    const { owns: _owns, ...stored } = kept;
    for (const field of owned)
      delete stored[field];
    if (owned.includes("instructions"))
      delete stored.text;
    await this.edit(userId, (defs) => {
      defs.agents[id] = stored;
    });
    await this.deps.settings.change(userId, [], [[this.deps.coreKey, "agents", id]]);
    return this.view(userId);
  }
  async saveSkill(userId, skill) {
    const id = idOf(skill.id, "A skill");
    const skills = (await this.merged(userId)).skills;
    if ((Array.isArray(skills) ? skills : []).some((s) => isRecord2(s) && s.id === id && s.owned === true))
      throw new UiRefused("forbidden", "This skill belongs to the extension. You change it on that extension's own pages.");
    const checked = checkSkill(skill);
    const kept = checked.skill;
    if (kept === null || checked.problems.length > 0)
      throw new UiRefused("invalid", "The skill wasn't saved: it has something the core refuses.", checked.problems.map((p) => ({ path: [...p.path], message: p.message })));
    const { owned: _owned, ...stored } = kept;
    await this.edit(userId, (defs) => {
      defs.skills[id] = stored;
    });
    return this.view(userId);
  }
  async remove(userId, kind, id) {
    const held = storedOf(await this.deps.settings.definitions(userId))[KIND_KEY[kind]];
    if (!Object.hasOwn(held, id))
      throw new UiRefused("not_found", `You have no ${kind} of your own named "${id}". A built-in or an extension's can be switched off, not removed.`);
    const { agents } = await this.merged(userId);
    const alone = kind === "agent" && (Array.isArray(agents) ? agents : []).some((a) => isRecord2(a) && a.id === id && a.over === undefined);
    await this.edit(userId, (stored) => {
      delete stored[KIND_KEY[kind]][id];
    });
    if (alone)
      await this.deps.settings.change(userId, [], [[this.deps.coreKey, "agents", id]]);
    return this.view(userId);
  }
  async switch(userId, kind, id, off) {
    await this.merged(userId);
    await this.edit(userId, (stored) => {
      const list2 = kind === "mcp" ? stored.mcp : stored.off[KIND_KEY[kind]];
      const listed = kind === "mcp" ? !off : off;
      const at2 = list2.indexOf(id);
      if (listed && at2 < 0)
        list2.push(id);
      if (!listed && at2 >= 0)
        list2.splice(at2, 1);
    });
    return this.view(userId);
  }
  async approve(userId, path, value) {
    await this.merged(userId);
    await this.deps.settings.change(userId, value === null ? [] : [{ path, value }], value === null ? [path] : []);
    this.moved(userId);
    return this.view(userId);
  }
  toolApproval(userId, name, approval) {
    return this.approve(userId, [this.deps.coreKey, "approval", "tools", name], approval);
  }
  tierApproval(userId, tier, approval) {
    return this.approve(userId, [this.deps.coreKey, "approval", "tiers", tier], approval);
  }
}

// src/extension/backend/mcp.ts
var MCP_PREFIX = "mcp:";
function mcpSlug(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return slug === "" ? "server" : slug;
}
function mcpSlugs(servers) {
  const out = new Map;
  const taken = new Set;
  for (const s of [...servers].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))) {
    const base = mcpSlug(s.name);
    let slug = base;
    for (let n = 2;taken.has(slug); n++)
      slug = `${base}-${n}`;
    taken.add(slug);
    out.set(s.id, slug);
  }
  return out;
}
function mcpNameOf(name) {
  if (!name.startsWith(MCP_PREFIX))
    return null;
  const rest = name.slice(MCP_PREFIX.length);
  const at2 = rest.indexOf(":");
  return at2 <= 0 || at2 === rest.length - 1 ? null : { slug: rest.slice(0, at2), tool: rest.slice(at2 + 1) };
}
var words = (error) => error instanceof Error ? error.message : String(error);

class Mcp {
  host;
  deps;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
  }
  async read(userId) {
    const servers = await this.host.mcp.servers(userId);
    const on = await this.deps.on(userId);
    const slugs = mcpSlugs(servers);
    const tools = [];
    const states = [];
    for (const server of servers) {
      const slug = slugs.get(server.id) ?? mcpSlug(server.name);
      const state2 = { id: server.id, name: server.name, slug, enabled: server.enabled, on: on.includes(server.id), tools: [], problem: null };
      states.push(state2);
      if (!state2.on)
        continue;
      if (!server.enabled) {
        state2.problem = `"${server.name}" is switched off in Lumiverse, so its tools aren't offered. Switch it on in Lumiverse's MCP settings.`;
        continue;
      }
      try {
        for (const t of await this.host.mcp.tools(server.id, userId)) {
          const tool = { name: `${MCP_PREFIX}${slug}:${t.name}`, family: `${MCP_PREFIX}${slug}`, serverId: server.id, serverName: server.name, tool: t.name, description: t.description, parameters: t.parameters };
          tools.push(tool);
          state2.tools.push(tool.name);
        }
      } catch (error) {
        state2.problem = `"${server.name}" couldn't be reached, so its tools aren't offered (${words(error)}). Check it in Lumiverse's MCP settings.`;
      }
    }
    return { states, tools };
  }
  async servers(userId) {
    return (await this.read(userId)).states;
  }
  async tools(userId) {
    if ((await this.deps.on(userId)).length === 0)
      return [];
    return (await this.read(userId)).tools;
  }
  async call(userId, name, args, signal) {
    const named = mcpNameOf(name);
    if (named === null)
      throw new Error(`"${name}" isn't an MCP tool's name: one is ${MCP_PREFIX}<server>:<tool>.`);
    const servers = await this.host.mcp.servers(userId);
    const slugs = mcpSlugs(servers);
    const server = servers.find((s) => slugs.get(s.id) === named.slug);
    if (server === undefined)
      throw new Error(`There is no MCP server "${named.slug}" now: it was removed or renamed in Lumiverse.`);
    if (!(await this.deps.on(userId)).includes(server.id))
      throw new Error(`The MCP server "${server.name}" isn't switched on for LumiAH's agents.`);
    if (!server.enabled)
      throw new Error(`The MCP server "${server.name}" is switched off in Lumiverse.`);
    signal.throwIfAborted();
    const { promise, resolve, reject } = Promise.withResolvers();
    const ended = () => reject(signal.reason instanceof Error ? signal.reason : new Error("The call was cancelled."));
    signal.addEventListener("abort", ended, { once: true });
    const callMs = await this.deps.callMs(userId);
    const late = this.deps.later(callMs, () => reject(new Error(`The MCP tool ${name} didn't answer within ${spanWords(callMs)}. ${transportWait(["mcp", "callMs"], this.deps)} says how long one call may take.`)));
    this.host.mcp.call(server.id, named.tool, args, callMs, userId).then(resolve, reject);
    try {
      return await promise;
    } finally {
      late();
      signal.removeEventListener("abort", ended);
    }
  }
}

// src/extension/backend/extension.ts
function offerOf(extension) {
  if (extension === undefined)
    return null;
  return { name: extension.name, members: EXTENSION_MEMBERS.filter((member) => typeof extension[member] === "function") };
}
function harnessExtension(extension, userId) {
  return {
    name: extension.name,
    ...extension.definitions ? { definitions: (ask) => extension.definitions?.(userId, ask.chatId) ?? Promise.resolve({}) } : {},
    ...extension.claim ? { claim: (ask) => extension.claim?.({ ...ask, userId }, userId) ?? Promise.resolve(null) } : {},
    ...extension.writerRequest ? { writerRequest: (request) => extension.writerRequest?.({ ...request, userId }, userId) ?? Promise.resolve(null) } : {},
    ...extension.runBegan ? { runBegan: (run) => extension.runBegan?.({ ...run, userId }, userId) ?? Promise.resolve() } : {},
    ...extension.agentModel ? { agentModel: (ask) => extension.agentModel?.({ ...ask, userId }, userId) ?? Promise.resolve(null) } : {},
    ...extension.releasing ? { releasing: (release) => extension.releasing?.({ ...release, userId }, userId) ?? Promise.resolve(null) } : {},
    ...extension.released ? { released: (release) => extension.released?.({ ...release, userId }, userId) ?? Promise.resolve() } : {},
    ...extension.replyWritten ? { replyWritten: (reply) => extension.replyWritten?.({ ...reply, userId }, userId) ?? Promise.resolve() } : {},
    ...extension.runEnded ? { runEnded: (run) => extension.runEnded?.({ ...run, userId }, userId) ?? Promise.resolve() } : {}
  };
}
var said = (name) => name.length > CEILINGS.nameChars ? `${name.slice(0, CEILINGS.nameChars)}\u2026` : name;
async function callExtension(extension, member, arg2, userId, chats) {
  if (typeof member !== "string" || !EXTENSION_MEMBERS.includes(member))
    throw new LinkRefused("bad_request", `An extension has no member ${said(String(member))}: update the runtime and the extension to the same build.`);
  const none = { supplied: false, value: null };
  if (extension === undefined)
    return none;
  const core = harnessExtension(extension, userId);
  const given = arg2;
  const json = (value) => value === undefined ? null : value;
  const ownChat = async () => {
    if (!isRecord2(arg2) || typeof arg2.chatId !== "string")
      throw new LinkRefused("bad_request", `${member} is told of a run, which names its chat: update the runtime and the extension to the same build.`);
    if (arg2.chatId !== "")
      await chats.own(userId, arg2.chatId);
  };
  switch (member) {
    case "definitions": {
      if (core.definitions === undefined)
        return none;
      const chatId = isRecord2(arg2) && typeof arg2.chatId === "string" && arg2.chatId !== "" ? (await chats.own(userId, arg2.chatId)).id : null;
      return { supplied: true, value: json(await core.definitions({ userId, chatId })) };
    }
    case "claim": {
      if (core.claim === undefined)
        return none;
      const chat = isRecord2(arg2) && isRecord2(arg2.chat) ? arg2.chat : arg2;
      if (!isRecord2(chat) || typeof chat.id !== "string")
        throw new LinkRefused("bad_request", "A claim is asked about a chat.");
      const ask = await chats.claimAsk(userId, chat.id);
      if (ask === null)
        throw new LinkRefused("not_found", "There is no such chat in this account.");
      return { supplied: true, value: json(await core.claim(ask)) };
    }
    case "writerRequest":
      if (core.writerRequest === undefined)
        return none;
      await ownChat();
      return { supplied: true, value: json(await core.writerRequest(given)) };
    case "runBegan":
      if (core.runBegan === undefined)
        return none;
      await ownChat();
      await core.runBegan(given);
      return { supplied: true, value: null };
    case "agentModel":
      if (core.agentModel === undefined)
        return none;
      await ownChat();
      return { supplied: true, value: json(await core.agentModel(given)) };
    case "releasing": {
      if (core.releasing === undefined)
        return none;
      await ownChat();
      const verdict = await core.releasing(given);
      return { supplied: true, value: isRecord2(verdict) && typeof verdict.refused === "string" ? { refused: verdict.refused } : null };
    }
    case "released":
      if (core.released === undefined)
        return none;
      await ownChat();
      await core.released(given);
      return { supplied: true, value: null };
    case "replyWritten":
      if (core.replyWritten === undefined)
        return none;
      await ownChat();
      await core.replyWritten(given);
      return { supplied: true, value: null };
    case "runEnded":
      if (core.runEnded === undefined)
        return none;
      await ownChat();
      await core.runEnded(given);
      return { supplied: true, value: null };
  }
}

class RemoteTools {
  own;
  mcp;
  log;
  constructor(own, mcp, log) {
    this.own = own;
    this.mcp = mcp;
    this.log = log;
  }
  async list(userId, chatId) {
    const own = this.own === undefined ? [] : (await this.own.list(chatId, userId)).map((tool) => ({ ...tool, source: "extension" }));
    const taken = new Set(own.map((tool) => tool.name));
    let mcp = [];
    try {
      mcp = (await this.mcp.tools(userId)).filter((tool) => !taken.has(tool.name)).map((tool) => ({ name: tool.name, family: tool.family, tier: "external", description: tool.description, parameters: tool.parameters, source: "user" }));
    } catch (error) {
      this.log("warn", `[LumiAH] the MCP servers' tools couldn't be listed (${wordsOf(error)})`);
    }
    return [...own, ...mcp];
  }
  async call(userId, call, signal) {
    const ownIt = this.own !== undefined && (mcpNameOf(call.name) === null || (await this.own.list(call.chatId, userId)).some((tool) => tool.name === call.name));
    try {
      if (ownIt && this.own !== undefined)
        return await this.own.call(call, signal, userId);
      if (mcpNameOf(call.name) !== null)
        return { text: await this.mcp.call(userId, call.name, call.args, signal) };
      return { text: `There is no tool ${said(call.name)} in this extension now. Go on without it.`, error: true };
    } catch (error) {
      if (signal.aborted)
        throw error;
      return { text: wordsOf(error), error: true };
    }
  }
}

// src/extension/backend/forget.ts
function storedOf2(raw) {
  if (!isRecord2(raw) || raw.v !== 1 || !isRecord2(raw.chats))
    return null;
  const chats = {};
  for (const [chatId, at2] of Object.entries(raw.chats))
    if (typeof at2 === "number")
      chats[chatId] = at2;
  return { v: 1, chats };
}

class Forgotten {
  host;
  deps;
  docs;
  handing = new Map;
  queued = new Set;
  owed = new Set;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
    this.docs = new UserDocs(host, "forget.json", storedOf2, () => ({ v: 1, chats: {} }));
  }
  deleted(userId, chatId) {
    this.docs.change(userId, (doc) => {
      doc.chats[chatId] = this.deps.now();
    }).then(() => this.handOver(userId)).catch((error) => this.host.log("warn", `[LumiAH] the deleted chat ${chatId} couldn't be kept for the runtime to forget (${wordsOf(error)})`));
  }
  handOver(userId) {
    if (this.queued.has(userId))
      return;
    this.queued.add(userId);
    const next = (this.handing.get(userId) ?? Promise.resolve()).then(() => {
      this.queued.delete(userId);
      return this.run(userId);
    }).catch((error) => this.host.log("warn", `[LumiAH] the chats deleted while the runtime was away couldn't be handed to it (${wordsOf(error)})`));
    this.handing.set(userId, next);
    next.finally(() => {
      if (this.handing.get(userId) === next)
        this.handing.delete(userId);
    });
  }
  pinged(userId) {
    if (this.owed.delete(userId))
      this.handOver(userId);
  }
  async run(userId) {
    const chats = Object.keys((await this.docs.get(userId)).chats);
    if (chats.length === 0 || !await this.deps.isLinked(userId))
      return;
    for (const chatId of chats) {
      try {
        await this.deps.asks.ask(userId, "chats.forget", { chatId }, { patient: true });
      } catch (error) {
        if (!(error instanceof UiRefused))
          throw error;
        if (error.code === "unavailable")
          return;
        if (error.code === "conflict") {
          this.owed.add(userId);
          continue;
        }
        this.host.log("warn", `[LumiAH] the runtime couldn't forget the deleted chat ${chatId} (${error.message}); it is asked again when it next links`);
        continue;
      }
      await this.docs.change(userId, (doc) => {
        delete doc.chats[chatId];
      });
    }
  }
  settle() {
    return this.docs.settle();
  }
}

// src/extension/backend/jobs.ts
function jobOver(job) {
  return job.state !== "queued" && job.state !== "running" && job.state !== "spent" && job.state !== "paused";
}
var TASK_CHARS = 80;
function named(job) {
  const task = job.task.replace(/\s+/g, " ").trim();
  return `"${task.length > TASK_CHARS ? `${task.slice(0, TASK_CHARS).trimEnd()}\u2026` : task}"`;
}
function endNotice(job, openingChars) {
  const base = { chatId: job.chatId, jobId: job.id };
  const opening = job.opening?.trim() ?? "";
  switch (job.state) {
    case "done":
      return { ...base, kind: "job_done", text: `The job ${named(job)} finished${opening === "" ? "." : `: ${opening.length > openingChars ? `${opening.slice(0, openingChars).trimEnd()}\u2026` : opening}`}` };
    case "failed":
      return { ...base, kind: "job_failed", text: `The job ${named(job)} failed${job.reason !== undefined ? `: ${job.reason}` : "."}` };
    case "interrupted":
      return { ...base, kind: "job_interrupted", text: `The job ${named(job)} was cut off by a restart. Start it again from the Jobs page.` };
    case "off_path":
      return { ...base, kind: "job_failed", text: `The job ${named(job)} was stopped: the reply it belonged to is no longer on the chat's path${job.reason !== undefined ? ` (${job.reason})` : ""}.` };
    default:
      return null;
  }
}
var TOLD_KEPT = 4096;

class JobsBoard {
  notices;
  now;
  noticeChars;
  users = new Map;
  total = 0;
  changed = [];
  constructor(notices, now, noticeChars) {
    this.notices = notices;
    this.now = now;
    this.noticeChars = noticeChars;
  }
  onChange(listener) {
    this.changed.push(listener);
  }
  of(userId) {
    let user = this.users.get(userId);
    if (user === undefined) {
      user = { active: new Map, changed: this.now(), told: new Set, runs: new Map };
      this.users.set(userId, user);
    }
    return user;
  }
  known(userId) {
    return this.users.has(userId);
  }
  seed(userId, jobs) {
    const user = this.of(userId);
    for (const job of jobs)
      if (!jobOver(job) && !user.active.has(job.id))
        this.hold(userId, user, job, null);
  }
  hold(userId, user, job, relay) {
    if (!user.active.has(job.id))
      this.total += 1;
    user.active.set(job.id, job);
    if (relay !== null)
      user.runs.set(job.id, relay);
    if (user.active.size > CEILINGS.jobsActive)
      this.letGo(user, job.id);
    if (this.total <= CEILINGS.jobsActiveTotal)
      return;
    let most = { userId, user, spare: user.active.size - 1 };
    for (const [otherId, other] of this.users)
      if (other !== user && other.active.size > most.spare)
        most = { userId: otherId, user: other, spare: other.active.size };
    this.letGo(most.user, job.id);
    if (most.user === user)
      return;
    most.user.changed += 1;
    for (const listener of this.changed)
      listener(most.userId);
  }
  letGo(user, keep) {
    let oldest = null;
    for (const [id, job] of user.active) {
      if (id === keep)
        continue;
      oldest ??= id;
      if (job.state === "running")
        continue;
      oldest = id;
      break;
    }
    if (oldest === null)
      return;
    user.active.delete(oldest);
    user.runs.delete(oldest);
    this.total -= 1;
  }
  async took(userId, job, relay) {
    const user = this.of(userId);
    const before = user.active.get(job.id);
    const over = jobOver(job);
    if (over) {
      if (user.active.delete(job.id))
        this.total -= 1;
      user.runs.delete(job.id);
    } else
      this.hold(userId, user, job, relay);
    user.changed += 1;
    for (const listener of this.changed)
      listener(userId);
    if (!over) {
      const needs = job.state === "spent" ? `The job ${named(job)} used up what it was allowed to spend. Grant it more on the Jobs page, or cancel it.` : job.state === "paused" ? `The job ${named(job)} was held when a restart cut it off. Let it go on from the Jobs page, or cancel it.` : null;
      if (needs !== null)
        await this.notices.add(userId, { kind: "job_needs_user", chatId: job.chatId, jobId: job.id, text: needs });
      else if (before?.state === "spent" || before?.state === "paused")
        await this.notices.settle(userId, job.id, "job_needs_user");
      return;
    }
    if (user.told.has(job.id))
      return;
    user.told.add(job.id);
    if (user.told.size > TOLD_KEPT)
      user.told.delete(user.told.values().next().value ?? "");
    await this.notices.settle(userId, job.id, "job_needs_user");
    const notice = endNotice(job, await this.noticeChars(userId));
    if (notice !== null)
      await this.notices.add(userId, notice);
  }
  async waits(userId, jobId, tool) {
    const job = this.users.get(userId)?.active.get(jobId);
    if (job === undefined)
      return;
    if (tool === null)
      await this.notices.settle(userId, jobId, "job_needs_user");
    else
      await this.notices.add(userId, { kind: "job_needs_user", chatId: job.chatId, jobId, text: `The job ${named(job)} waits for your word on a call of ${tool}.` });
  }
  active(userId, jobId) {
    return this.users.get(userId)?.active.get(jobId) ?? null;
  }
  runsIn(userId, jobId) {
    return this.users.get(userId)?.runs.get(jobId) ?? null;
  }
  state(userId, off, paused) {
    const user = this.users.get(userId);
    return { active: user === undefined ? [] : [...user.active.values()], off, paused, changed: user?.changed ?? 0 };
  }
}

// src/extension/backend/notices.ts
var FILE = "notices.json";
var KINDS = { job_done: true, job_failed: true, job_interrupted: true, job_needs_user: true };
function noticeOf(raw) {
  if (!isRecord2(raw))
    return null;
  const { id, at: at2, kind, chatId, jobId, text: text4 } = raw;
  if (typeof id !== "string" || typeof at2 !== "number" || typeof kind !== "string" || !Object.hasOwn(KINDS, kind) || typeof chatId !== "string" || typeof jobId !== "string" || typeof text4 !== "string")
    return null;
  return { id, at: at2, kind, chatId, jobId, text: text4 };
}
function docOf(raw) {
  if (!isRecord2(raw) || raw.v !== 1 || !Array.isArray(raw.notices))
    return null;
  const notices = [];
  for (const one of raw.notices) {
    const notice = noticeOf(one);
    if (notice !== null)
      notices.push(notice);
  }
  return { v: 1, notices };
}

class Notices {
  env;
  docs;
  changed = [];
  constructor(host, env) {
    this.env = env;
    this.docs = new UserDocs(host, FILE, docOf, () => ({ v: 1, notices: [] }));
  }
  onChange(listener) {
    this.changed.push(listener);
  }
  tell(userId) {
    for (const listener of this.changed)
      listener(userId);
  }
  async list(userId) {
    return [...(await this.docs.get(userId)).notices].reverse();
  }
  async add(userId, notice) {
    const kept = Math.max(1, await this.env.kept(userId));
    const made = { id: this.env.id(), at: this.env.now(), ...notice };
    await this.docs.change(userId, (doc) => {
      doc.notices = doc.notices.filter((n) => !(n.jobId === made.jobId && n.kind === made.kind));
      doc.notices.push(made);
      if (doc.notices.length > kept)
        doc.notices.splice(0, doc.notices.length - kept);
    });
    this.tell(userId);
    return made;
  }
  async settle(userId, jobId, kind) {
    if (!(await this.docs.get(userId)).notices.some((n) => n.jobId === jobId && n.kind === kind))
      return;
    await this.docs.change(userId, (doc) => {
      doc.notices = doc.notices.filter((n) => !(n.jobId === jobId && n.kind === kind));
    });
    this.tell(userId);
  }
  async dismiss(userId, id) {
    const before = (await this.docs.get(userId)).notices;
    if (id === null ? before.length > 0 : before.some((n) => n.id === id)) {
      await this.docs.change(userId, (doc) => {
        doc.notices = id === null ? [] : doc.notices.filter((n) => n.id !== id);
      });
      this.tell(userId);
    }
    return this.list(userId);
  }
  settled() {
    return this.docs.settle();
  }
}

// src/extension/backend/proxy.ts
var RETRY_MS = 2 * 60000;
var CORS_PROXY = "cors_proxy";
var SEP2 = "\x00";
function cleaned(words2, secret) {
  return secret === "" ? words2 : words2.replaceAll(secret, "\u2026");
}
function within(promise, ms2, late) {
  const { promise: timeout, reject } = Promise.withResolvers();
  const timer = setTimeout(() => reject(new Error(late)), ms2);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class ProxyRoad {
  deps;
  roads = new Map;
  constructor(deps) {
    this.deps = deps;
  }
  get granted() {
    return this.deps.host.granted(CORS_PROXY);
  }
  heard(userId, relay, session, secret) {
    const key2 = `${userId}${SEP2}${relay}`;
    const road = this.roads.get(key2);
    if (road !== undefined && road.session === session && road.secret === secret)
      return;
    const fresh = { secret, session, checked: null, probing: null, failed: null };
    this.roads.set(key2, fresh);
    if (this.granted)
      this.probe(userId, relay, fresh);
  }
  forget(userId, relay) {
    if (this.roads.delete(`${userId}${SEP2}${relay}`))
      this.deps.changed(userId);
  }
  permission(granted) {
    const users = new Set;
    for (const [key2, road] of this.roads) {
      const [userId = "", relay = ""] = key2.split(SEP2);
      users.add(userId);
      road.checked = null;
      road.failed = null;
      if (granted)
        this.probe(userId, relay, road);
    }
    for (const userId of users)
      this.deps.changed(userId);
  }
  async open(userId, relay) {
    if (!this.granted)
      return null;
    const road = this.roads.get(`${userId}${SEP2}${relay}`);
    if (road === undefined)
      return null;
    const now = this.deps.now();
    if (road.failed !== null && now - road.failed.at < RETRY_MS)
      return null;
    const checked = road.checked;
    const address = await this.deps.address(userId, relay);
    const base = address !== null && isLoopback(address.listen) ? roadBase(address.listen, address.port) : null;
    if (checked !== null && checked.held && checked.session === road.session && checked.base === base && road.failed === null)
      return { base: checked.base, secret: road.secret };
    if (base !== null && road.probing === null && (checked === null || checked.session !== road.session || checked.base !== base || road.failed !== null))
      this.probe(userId, relay, road);
    return null;
  }
  probe(userId, relay, road) {
    road.probing ??= (async () => {
      const at2 = this.deps.now();
      const address = await this.deps.address(userId, relay);
      if (address === null || !isLoopback(address.listen)) {
        road.checked = { base: "", session: road.session, held: false, at: at2, why: null };
        return;
      }
      const base = roadBase(address.listen, address.port);
      const nonce = this.deps.nonce();
      const waitMs = (await this.deps.transport(userId)).pages.proxyMs;
      let why = null;
      try {
        const reply = await within(this.deps.host.cors(`${base}${ASK_PATH}`, { method: "POST", headers: { [PROBE_HEADER]: nonce, "Content-Type": "application/json" }, body: "{}" }), waitMs, `it didn't answer within ${spanWords(waitMs)}`);
        let said2 = null;
        try {
          said2 = JSON.parse(reply.body);
        } catch {}
        const proof = isRecord2(said2) && typeof said2.proof === "string" ? said2.proof : "";
        if (reply.status !== 200 || !await sameSecret(proof, await roadProof(road.secret, relay, nonce)))
          why = "what answers there didn't prove it is this runtime";
      } catch (error) {
        why = cleaned(error instanceof Error ? error.message : String(error), road.secret);
      }
      if (this.roads.get(`${userId}${SEP2}${relay}`) !== road)
        return;
      road.checked = { base, session: road.session, held: why === null, at: at2, why };
      if (why === null)
        road.failed = null;
    })().finally(() => {
      road.probing = null;
      this.deps.changed(userId);
    });
    return road.probing;
  }
  async send(userId, relay, opened, body) {
    let reply;
    try {
      reply = await this.deps.host.cors(`${opened.base}${ASK_PATH}`, { method: "POST", headers: { Authorization: `Bearer ${opened.secret}`, "Content-Type": "application/json" }, body });
    } catch (error) {
      this.failed(userId, relay, cleaned(error instanceof Error ? error.message : String(error), opened.secret));
      return { kind: "failed" };
    }
    if (reply.status === TOO_LARGE_STATUS)
      return { kind: "too_large" };
    let said2 = null;
    try {
      said2 = JSON.parse(reply.body);
    } catch {}
    if (reply.status !== 200 || !isRecord2(said2) || !("value" in said2) || !(said2.refusal === null || isRecord2(said2.refusal))) {
      this.failed(userId, relay, reply.status === 401 ? "the runtime didn't take its secret (it may have been rotated)" : `it answered ${reply.status}`);
      return { kind: "failed" };
    }
    const took = typeof said2.took === "number" && Number.isFinite(said2.took) && said2.took >= 0 ? said2.took : null;
    return { kind: "answer", value: said2.value ?? null, refusal: isRecord2(said2.refusal) ? said2.refusal : null, took, got: reply.body.length };
  }
  failed(userId, relay, why) {
    const road = this.roads.get(`${userId}${SEP2}${relay}`);
    if (road === undefined)
      return;
    road.failed = { at: this.deps.now(), why };
    this.deps.changed(userId);
  }
  sweep(userId) {
    for (const key2 of [...this.roads.keys()]) {
      const [owner = "", relay = ""] = key2.split(SEP2);
      if (owner === userId && !this.deps.isLinked(userId, relay))
        this.forget(userId, relay);
    }
  }
  async view(userId, relays) {
    const { name } = this.deps;
    const granted = this.granted;
    const declined = this.deps.declined.has(CORS_PROXY);
    const offer = granted ? null : declined ? `Pages reach your runtime over the link alone: ${name} doesn't ask Lumiverse for the permission "${CORS_PROXY}", which opens a faster road.` : `Granting ${name} the permission "${CORS_PROXY}" (Extensions \u2192 ${name} \u2192 Permissions; only an owner or an admin can) lets its pages, and the tools of an extension that builds it in, reach a runtime on this machine through Lumiverse's own proxy, so a request doesn't wait behind a reply's or a job's traffic on the link. Without it everything still works over the link.`;
    const out = {};
    for (const { id, linked } of relays) {
      const road = this.roads.get(`${userId}${SEP2}${id}`);
      const address = await this.deps.address(userId, id);
      if (!linked || road === undefined)
        out[id] = { road: "link", why: "It isn't linked now.", at: null };
      else if (!granted)
        out[id] = { road: "link", why: `${name} doesn't hold the permission "${CORS_PROXY}".`, at: null };
      else if (address === null || !isLoopback(address.listen))
        out[id] = { road: "link", why: `It listens on ${address?.listen ?? "an address it hasn't said"}, not on a loopback address: Lumiverse's proxy reaches only a runtime on Lumiverse's own machine.`, at: null };
      else if (road.failed !== null)
        out[id] = { road: "link", why: `The faster road failed (${road.failed.why}). It is checked again within ${spanWords(RETRY_MS)}; the link carries every request meanwhile.`, at: road.failed.at };
      else if (road.checked === null || road.checked.session !== road.session || road.probing !== null)
        out[id] = { road: "link", why: "Checking that Lumiverse's proxy reaches it\u2026", at: null };
      else if (!road.checked.held)
        out[id] = { road: "link", why: `Lumiverse's proxy didn't reach it at ${road.checked.base} (${road.checked.why ?? "no answer"}): it may run on another machine, or behind a firewall that keeps Lumiverse out. ${transportWait(["pages", "proxyMs"], this.deps)} says how long the check waits.`, at: road.checked.at };
      else
        out[id] = { road: "proxy", why: null, at: road.checked.at };
    }
    return { granted, offer, relays: out };
  }
}

// src/extension/backend/open.ts
var KINDS2 = { new: true, regenerate: true, swipe: true, continue: true };
function openOf(turn, raw) {
  if (!isRecord2(raw) || typeof raw.chatId !== "string" || typeof raw.kind !== "string" || !Object.hasOwn(KINDS2, raw.kind) || typeof raw.at !== "number")
    return null;
  const target = raw.target;
  if (!isRecord2(target) || !(target.message === null || typeof target.message === "string") || typeof target.swipe !== "number" || !Number.isSafeInteger(target.swipe) || target.swipe < 0)
    return null;
  return { turn, chatId: raw.chatId, kind: raw.kind, target: { message: target.message, swipe: target.swipe }, at: raw.at };
}
function storedOf3(raw) {
  if (!isRecord2(raw) || raw.v !== 1 || !isRecord2(raw.open))
    return null;
  const open = {};
  for (const [turn, value] of Object.entries(raw.open)) {
    const one = openOf(turn, value);
    if (one !== null)
      open[turn] = one;
  }
  return { v: 1, open };
}

class OpenTurns {
  kept;
  docs;
  constructor(host, kept) {
    this.kept = kept;
    this.docs = new UserDocs(host, "turns.json", storedOf3, () => ({ v: 1, open: {} }));
  }
  async put(userId, turn) {
    const most = Math.max(1, await this.kept(userId));
    await this.docs.change(userId, (doc) => {
      delete doc.open[turn.turn];
      doc.open[turn.turn] = turn;
      const ids = Object.keys(doc.open);
      for (const id of ids.slice(0, Math.max(0, ids.length - most)))
        delete doc.open[id];
    });
  }
  async get(userId, turn) {
    const held = (await this.docs.get(userId)).open;
    return Object.hasOwn(held, turn) ? held[turn] ?? null : null;
  }
  async list(userId) {
    return Object.values((await this.docs.get(userId)).open);
  }
  async drop(userId, turn) {
    if (!Object.hasOwn((await this.docs.get(userId)).open, turn))
      return;
    await this.docs.change(userId, (doc) => {
      delete doc.open[turn];
    });
  }
  settle() {
    return this.docs.settle();
  }
}

// src/extension/backend/connections.ts
var LOOPBACK_PROVIDER = "custom";
function anyLoopbackModel(c) {
  return c.provider === LOOPBACK_PROVIDER && (c.model === MODEL_ID || c.model.startsWith(`${MODEL_ID}-`));
}

class Connections {
  host;
  deps;
  told = new Map;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
  }
  pageSaid(userId, active) {
    if (this.told.has(userId) && this.told.get(userId) === active)
      return false;
    this.told.set(userId, active);
    return true;
  }
  loops(c, bases) {
    return c.provider === LOOPBACK_PROVIDER && loopsBack(c, this.deps.model, bases);
  }
  raw(userId) {
    return this.host.connections.list(userId);
  }
  async views(userId) {
    const bases = await this.deps.bases(userId);
    return (await this.raw(userId)).map((c) => ({ id: c.id, name: c.name, provider: c.provider, model: c.model === "" ? null : c.model, loopback: this.loops(c, bases) }));
  }
  async lumiverse(userId) {
    const bases = await this.deps.bases(userId);
    return (await this.raw(userId)).filter((c) => !this.loops(c, bases) && !anyLoopbackModel(c)).map((c) => ({ id: c.id, name: c.name, provider: c.provider, baseUrl: c.url === "" ? null : c.url, model: c.model === "" ? null : c.model }));
  }
  async one(userId, connectionId) {
    if (connectionId !== null)
      return this.host.connections.get(connectionId, userId);
    return (await this.raw(userId)).find((c) => c.isDefault) ?? null;
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
    const pinned = typeof pin === "string" && pin.trim() !== "" ? await this.host.connections.get(pin.trim(), userId) : null;
    const c = pinned ?? await this.unpinned(userId);
    if (c === null)
      return null;
    const theirs = c.provider === LOOPBACK_PROVIDER && c.model !== this.deps.model ? c.model === MODEL_ID ? EXTENSION_IDENTIFIER : c.model.startsWith(`${MODEL_ID}-`) ? c.model.slice(MODEL_ID.length + 1) : null : null;
    return { id: c.id, name: c.name, loopback: this.loops(c, await this.deps.bases(userId)), foreign: theirs };
  }
  async selectedId(userId) {
    const said2 = await this.host.connections.active(userId);
    return said2 !== undefined ? said2 : this.told.get(userId) ?? null;
  }
  async unpinned(userId) {
    const selected = await this.selectedId(userId);
    const active = selected === null ? null : await this.host.connections.get(selected, userId);
    if (active !== null)
      return active;
    const all = await this.raw(userId);
    return all.find((c) => c.isDefault) ?? all[0] ?? null;
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
    const key2 = `${KEY_PREFIX}${randomHex(256)}`;
    const hash = await sha256(key2);
    await registry.change(userId, (r) => {
      r.key = { hash, print: hash.slice(0, 8), at: now() };
    });
    const relay = (await relays.linked(userId))[0];
    if (relay === undefined)
      return { key: key2, connection: null };
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
    if (!relays.push(userId, relay.id, { link: LINK, type: "connection", ref, key: key2, name: this.deps.connectionName }))
      this.waiting.get(k)?.(null);
    const made = await promise;
    if (made === null)
      this.host.log("warn", `[LumiAH] runtime "${relay.name}" didn't say it put the new loopback key in a connection`);
    else if (made.problem !== null)
      this.host.log("warn", `[LumiAH] runtime "${relay.name}" couldn't put the new loopback key in a connection: ${made.problem}`);
    return { key: key2, connection: made?.connection ?? null };
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

// src/extension/backend/live.ts
var SEP3 = "\x00";
var streamKey = (userId, stream) => `${userId}${SEP3}${stream}`;
var PINGS_WITHOUT = 2;
function begunBy(record2) {
  const { event } = record2;
  if (record2.seq !== 1 || event.kind !== "turn_started")
    return null;
  const stream = event.generation === "job" ? event.job ?? record2.turn : event.generation === "side" ? event.side : undefined;
  if (stream === undefined || stream === "")
    return null;
  return { stream, chatId: record2.chatId === "" ? null : record2.chatId, turn: record2.turn, kind: event.generation, messageId: null };
}
function oldestEnded(account) {
  for (const turn of account.streams.values())
    if (turn.ended !== null)
      return turn;
  return;
}
function givesWay(account) {
  let first;
  for (const turn of account.streams.values()) {
    if (turn.ended !== null)
      continue;
    if (turn.told)
      return turn;
    first ??= turn;
  }
  return first;
}
var crowdedOut = (most, whose) => `At most ${most} runs under way are followed ${whose}, and this was the one that gave way when another began: its live view ends here. The run itself wasn't stopped.`;

class LiveBuffer {
  host;
  env;
  ceilings;
  accounts = new Map;
  held = 0;
  kept = 0;
  watchers = new Map;
  changed = [];
  finished = [];
  constructor(host, env, ceilings = CEILINGS) {
    this.host = host;
    this.env = env;
    this.ceilings = ceilings;
  }
  onChange(listener) {
    this.changed.push(listener);
  }
  onEnded(listener) {
    this.finished.push(listener);
  }
  tell(userId) {
    for (const listener of this.changed)
      listener(userId);
  }
  send(turn, push) {
    const sessions = this.watchers.get(streamKey(turn.userId, turn.stream));
    if (sessions === undefined)
      return;
    for (const session of sessions)
      this.host.frontend.send(push, turn.userId, session);
  }
  say(turn, change) {
    this.send(turn, { lah: UI_VERSION, type: "lah.live", stream: turn.stream, change });
  }
  viewOf(turn, events) {
    const partials = [...turn.partials].map(([agentId, p]) => ({ agentId, call: p.call, text: p.text, reasoning: p.reasoning, at: p.at }));
    return { stream: turn.stream, chatId: turn.chatId, turn: turn.turn, kind: turn.kind, messageId: turn.messageId, startedAt: turn.startedAt, ended: turn.ended, events, partials };
  }
  causeFor(turn, ended) {
    if (ended.cause !== undefined)
      return ended.cause;
    if (ended.state !== "failed")
      return null;
    return this.env.missing?.() === true ? "permission" : causeOf(turn.events);
  }
  end(turn, ended) {
    if (turn.ended !== null)
      return;
    turn.partials.clear();
    const cause = this.causeFor(turn, ended);
    turn.ended = { ...ended, ...cause !== null ? { cause } : {} };
    turn.paused = false;
    this.tell(turn.userId);
    for (const listener of this.finished)
      listener({ userId: turn.userId, stream: turn.stream, chatId: turn.chatId, turn: turn.turn, kind: turn.kind, messageId: turn.messageId, ended: turn.ended });
  }
  forget(turn) {
    const account = this.accounts.get(turn.userId);
    if (account === undefined || account.runs.get(turn.turn) !== turn)
      return;
    account.runs.delete(turn.turn);
    account.streams.delete(turn.stream);
    this.held--;
    this.kept -= turn.events.length;
    if (account.streams.size === 0)
      this.accounts.delete(turn.userId);
  }
  uncrowd(userId) {
    const account = this.accounts.get(userId);
    if (account === undefined)
      return;
    let under = 0;
    for (const turn of account.streams.values())
      if (turn.ended === null)
        under++;
    if (under < this.ceilings.liveRunning)
      return;
    const going = givesWay(account);
    if (going !== undefined)
      this.lose(going, crowdedOut(this.ceilings.liveRunning, "for one account"));
  }
  roomForAll() {
    while (this.held >= this.ceilings.liveRunsTotal) {
      let fullest = null;
      let spare = null;
      let spareOf = 0;
      for (const account of this.accounts.values()) {
        if (fullest === null || account.streams.size > fullest.streams.size)
          fullest = account;
        if (spare !== null && account.streams.size <= spareOf)
          continue;
        const ended = oldestEnded(account);
        if (ended === undefined)
          continue;
        spare = ended;
        spareOf = account.streams.size;
      }
      const going = spare ?? (fullest === null ? undefined : givesWay(fullest));
      if (going === undefined)
        return;
      this.lose(going, crowdedOut(this.ceilings.liveRunsTotal, "for all accounts together"));
      this.forget(going);
      this.tell(going.userId);
    }
  }
  add(userId, relay, run, told) {
    const mine = this.accounts.get(userId);
    for (const earlier of [mine?.streams.get(run.stream), mine?.runs.get(run.turn)])
      if (earlier !== undefined)
        this.forget(earlier);
    this.uncrowd(userId);
    this.roomForAll();
    let account = this.accounts.get(userId);
    if (account === undefined) {
      account = { streams: new Map, runs: new Map };
      this.accounts.set(userId, account);
    }
    const turn = { ...run, userId, relay, startedAt: this.env.now(), ended: null, events: [], overAt: null, unnamed: 0, partials: new Map, answered: new Map, paused: false, told };
    account.streams.set(run.stream, turn);
    account.runs.set(turn.turn, turn);
    this.held++;
    this.say(turn, { view: this.viewOf(turn, []) });
    this.tell(userId);
    return turn;
  }
  room(userId, chats) {
    const account = this.accounts.get(userId);
    if (account === undefined)
      return;
    const most = Math.min(chats, this.ceilings.liveChats);
    for (const held of [...account.streams.values()]) {
      if (account.streams.size <= most)
        break;
      if (held.ended === null)
        continue;
      this.forget(held);
      this.tell(userId);
    }
  }
  async begin(userId, relay, run) {
    this.add(userId, relay, run, false);
    this.room(userId, (await this.env.transport(userId)).live.chats);
  }
  async push(userId, relay, records2) {
    const { live } = await this.env.transport(userId);
    const most = Math.min(live.events, this.ceilings.liveEvents);
    let taken = 0;
    const fresh = new Map;
    for (const raw of records2) {
      const record2 = raw;
      if (record2 === null || typeof record2 !== "object" || typeof record2.turn !== "string" || typeof record2.seq !== "number" || typeof record2.event !== "object" || record2.event === null)
        continue;
      let turn = this.accounts.get(userId)?.runs.get(record2.turn);
      if (turn === undefined) {
        const run = begunBy({ turn: record2.turn, chatId: typeof record2.chatId === "string" ? record2.chatId : "", seq: record2.seq, event: record2.event });
        if (run === null)
          continue;
        turn = this.add(userId, relay, run, true);
        this.room(userId, live.chats);
      }
      if (record2.seq <= turn.events.length) {
        taken++;
        continue;
      }
      if (record2.seq !== turn.events.length + 1 || turn.events.length >= most || this.kept >= this.ceilings.liveEventsTotal)
        continue;
      const kept = { turn: turn.turn, chatId: typeof record2.chatId === "string" ? record2.chatId : turn.chatId ?? "", seq: record2.seq, event: record2.event };
      turn.events.push(kept);
      this.kept++;
      taken++;
      const list2 = fresh.get(turn) ?? [];
      list2.push(kept);
      fresh.set(turn, list2);
      const event = kept.event;
      if (event.kind === "turn_started")
        turn.startedAt = event.at;
      if (event.kind === "agent_entry" && (event.entry.kind === "answer" || event.entry.kind === "tools_refused" || event.entry.kind === "retry" || event.entry.kind === "stop"))
        turn.partials.delete(event.agentId);
      if (event.kind === "agent_entry" && event.entry.kind === "answer")
        turn.answered.set(event.agentId, (turn.answered.get(event.agentId) ?? 0) + 1);
      if (event.kind === "agent_idle")
        turn.partials.delete(event.agentId);
      if ((event.kind === "turn_paused" || event.kind === "turn_resumed") && turn.ended === null && turn.paused !== (event.kind === "turn_paused")) {
        turn.paused = event.kind === "turn_paused";
        this.tell(userId);
      }
      if (event.kind === "turn_ended")
        this.end(turn, { state: event.status, at: event.at, ...event.reason !== undefined ? { reason: event.reason } : {} });
    }
    for (const [turn, events] of fresh)
      if (this.accounts.get(userId)?.runs.get(turn.turn) === turn)
        this.say(turn, { turn: turn.turn, events, ended: turn.ended });
    return taken;
  }
  deltas(userId, relay, deltas) {
    for (const delta of deltas) {
      const turn = this.accounts.get(userId)?.runs.get(delta.turn);
      if (turn === undefined || turn.relay !== relay || turn.ended !== null)
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
      this.send(turn, { lah: UI_VERSION, type: "lah.live.delta", stream: turn.stream, delta: { turn: turn.turn, agentId: delta.agentId, call: delta.call, ...delta.text !== undefined ? { text: delta.text } : {}, ...delta.reasoning !== undefined ? { reasoning: delta.reasoning } : {}, before, at: delta.at } });
    }
  }
  lose(turn, reason) {
    if (turn.ended !== null)
      return;
    this.end(turn, { state: "lost", at: this.env.now(), reason });
    this.say(turn, { turn: turn.turn, events: [], ended: turn.ended });
  }
  named(userId, relay, turns) {
    const named2 = new Set(turns);
    for (const turn of this.accounts.get(userId)?.runs.values() ?? []) {
      if (turn.relay !== relay || turn.ended !== null)
        continue;
      if (named2.has(turn.turn))
        turn.unnamed = 0;
      else if (++turn.unnamed >= PINGS_WITHOUT)
        this.lose(turn, "The runtime stopped working on this without saying how it ended (it restarted, or its trace never arrived).");
    }
  }
  over(generationId) {
    for (const account of this.accounts.values()) {
      const turn = account.runs.get(generationId);
      if (turn !== undefined && turn.overAt === null)
        turn.overAt = this.env.now();
    }
  }
  async tick() {
    const now = this.env.now();
    for (const [userId, account] of [...this.accounts]) {
      const waiting = [...account.streams.values()].filter((turn) => turn.ended === null);
      if (waiting.length === 0)
        continue;
      const { live, runtime } = await this.env.transport(userId);
      for (const turn of waiting) {
        if (turn.ended !== null || account.runs.get(turn.turn) !== turn)
          continue;
        if (turn.overAt !== null && now - turn.overAt > live.lostMs) {
          this.lose(turn, "Lumiverse ended this reply's generation and the runtime never said how its turn ended.");
          continue;
        }
        const gone = this.env.linkGoneFor(userId, turn.relay);
        if (gone !== null && gone >= runtime.lostMs)
          this.lose(turn, `The runtime this ran in went away: its link has been gone for ${Math.round(gone / 1000)} seconds. The run ended with the runtime${turn.kind === "job" ? "; once the runtime is back, the job shows as interrupted" : ""}.`);
      }
    }
  }
  running(userId, stream, turnId) {
    const turn = this.accounts.get(userId)?.runs.get(turnId);
    return turn !== undefined && turn.stream === stream && turn.ended === null ? { relay: turn.relay, kind: turn.kind, chatId: turn.chatId, paused: turn.paused } : null;
  }
  streamOf(userId, turnId) {
    return this.accounts.get(userId)?.runs.get(turnId)?.stream ?? null;
  }
  whole(userId, stream) {
    const turn = this.accounts.get(userId)?.streams.get(stream);
    return turn === undefined ? null : this.viewOf(turn, [...turn.events]);
  }
  runningOf(userId) {
    const out = [];
    for (const turn of this.accounts.get(userId)?.streams.values() ?? []) {
      if (turn.ended !== null)
        continue;
      out.push({ stream: turn.stream, chatId: turn.chatId, turn: turn.turn, kind: turn.kind, startedAt: turn.startedAt, paused: turn.paused });
    }
    return out;
  }
  chatsOf(userId) {
    const out = [];
    for (const turn of this.accounts.get(userId)?.streams.values() ?? [])
      if (turn.chatId !== null && turn.stream === turn.chatId)
        out.push(turn.chatId);
    return out;
  }
  async open(userId, stream, session) {
    if (session !== undefined) {
      const key2 = streamKey(userId, stream);
      const sessions = this.watchers.get(key2) ?? new Set;
      sessions.add(session);
      this.watchers.set(key2, sessions);
    }
    const page = (await this.env.transport(userId)).live.page;
    const turn = this.accounts.get(userId)?.streams.get(stream);
    if (turn === undefined)
      return { live: null, next: null };
    const events = turn.events.slice(0, page);
    return { live: this.viewOf(turn, events), next: turn.events.length > events.length ? events.length + 1 : null };
  }
  async events(userId, stream, turnId, from) {
    const page = (await this.env.transport(userId)).live.page;
    const turn = this.accounts.get(userId)?.streams.get(stream);
    if (turn === undefined || turn.turn !== turnId)
      return null;
    const events = turn.events.slice(from - 1, from - 1 + page);
    const read2 = from - 1 + events.length;
    return { events, next: turn.events.length > read2 ? read2 + 1 : null };
  }
  close(userId, stream, session) {
    if (session === undefined)
      return;
    const key2 = streamKey(userId, stream);
    const sessions = this.watchers.get(key2);
    if (sessions === undefined)
      return;
    sessions.delete(session);
    if (sessions.size === 0)
      this.watchers.delete(key2);
  }
  sessionClosed(session) {
    for (const [key2, sessions] of this.watchers) {
      sessions.delete(session);
      if (sessions.size === 0)
        this.watchers.delete(key2);
    }
  }
}

// src/link/frames.ts
var text4 = (v2) => typeof v2 === "string";
var count = (v2) => typeof v2 === "number" && Number.isSafeInteger(v2) && v2 >= 0;
var REQUEST_TYPES = {
  register: true,
  hello: true,
  ping: true,
  models: true,
  "turn.begin": true,
  "turn.commit": true,
  "stream.ack": true,
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
  "tools.list": true,
  "tool.call": true,
  "approval.ask": true,
  "extension.call": true,
  "blob.list": true,
  "blob.remove": true,
  "mirror.release": true,
  "doc.list": true,
  "chat.info": true,
  "chat.anchors": true,
  "job.changed": true,
  "ask.answer": true,
  "recall.lore.read": true,
  "recall.lore.activated": true,
  "recall.chat.messages": true,
  "recall.embedder": true,
  "recall.embed": true,
  "recall.memory.enabled": true,
  "recall.memory.search": true,
  "recall.memory.entity": true,
  "recall.memory.entities": true,
  "recall.memory.arcs": true,
  "recall.databanks.list": true,
  "recall.databanks.documents": true,
  "recall.databanks.content": true,
  "recall.web.enabled": true,
  "recall.web.search": true,
  "book.read": true,
  "host.read": true,
  "own.read": true,
  "turn.lore": true
};
function isLinkFrame(raw) {
  return isRecord2(raw) && raw.link === LINK;
}
function requestOf(raw) {
  if (!isLinkFrame(raw))
    return null;
  const id = text4(raw.id) && raw.id !== "" ? raw.id : null;
  if (id === null)
    return { malformed: "A link request has no id.", id: null };
  if (!text4(raw.type) || !hasOwn2(REQUEST_TYPES, raw.type))
    return { malformed: `There is no link request ${String(raw.type)}: update LumiAH in Lumiverse, or the runtime, so both are the same build.`, id };
  return { request: raw };
}
function deltaOf(raw) {
  if (!isRecord2(raw) || !text4(raw.turn) || !text4(raw.chatId) || !text4(raw.agentId) || !count(raw.call) || raw.call < 1 || typeof raw.at !== "number")
    return null;
  if (raw.text !== undefined && !text4(raw.text) || raw.reasoning !== undefined && !text4(raw.reasoning))
    return null;
  return { turn: raw.turn, chatId: raw.chatId, agentId: raw.agentId, call: raw.call, ...raw.text !== undefined ? { text: raw.text } : {}, ...raw.reasoning !== undefined ? { reasoning: raw.reasoning } : {}, at: raw.at };
}
function noticeOf2(raw) {
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
  const short = (v2) => text4(v2) && v2.length <= REPORT_TEXT_MAX;
  const path = (v2) => text4(v2) && v2.length <= REPORT_PATH_MAX;
  const { name, build, host, listen, port, scheduler, turns } = raw;
  const { bun, script, unit } = raw.runtime;
  const { valid, expiresAt, checkedAt } = raw.session;
  if (!short(name) || !short(build) || !short(host) || !short(listen) || !count(port) || port < 1 || port > 65535 || !text4(scheduler) || !hasOwn2(SCHEDULER, scheduler) || !count(turns))
    return null;
  if (!(bun === null || path(bun)) || !path(script) || !(unit === null || short(unit)))
    return null;
  if (!(valid === null || typeof valid === "boolean") || !(expiresAt === null || short(expiresAt)) || !(checkedAt === null || typeof checkedAt === "number"))
    return null;
  return { name, build, runtime: { bun, script, unit }, host, listen, port, scheduler, session: { valid, expiresAt, checkedAt }, turns };
}

// src/extension/backend/mirror.ts
var FILE2 = "mirror-holder.json";
var id = (v2) => typeof v2 === "string" && MIRROR_ID.test(v2);
function holderDocOf(raw) {
  if (!isRecord2(raw) || raw.v !== 1 || typeof raw.gen !== "number" || !Number.isSafeInteger(raw.gen) || raw.gen < 0)
    return null;
  const h = raw.holder;
  if (h === null)
    return { v: 1, holder: null, gen: raw.gen };
  if (!isRecord2(h) || typeof h.relay !== "string" || !id(h.copy) || !id(h.process) || typeof h.owner !== "string")
    return null;
  return { v: 1, holder: { relay: h.relay, copy: h.copy, process: h.process, owner: h.owner }, gen: raw.gen };
}
function askOf(raw) {
  if (!isRecord2(raw) || !id(raw.copy) || !id(raw.process) || typeof raw.asks !== "boolean" || typeof raw.seen !== "number" || !Number.isSafeInteger(raw.seen) || raw.seen < 0)
    return null;
  return { copy: raw.copy, process: raw.process, asks: raw.asks, seen: raw.seen };
}

class Mirrors {
  host;
  env;
  docs;
  live = new Map;
  sessions = new Map;
  started;
  raising = new Set;
  constructor(host, env) {
    this.host = host;
    this.env = env;
    this.docs = new UserDocs(host, FILE2, holderDocOf, () => ({ v: 1, holder: null, gen: 0 }));
    this.started = env.now();
  }
  liveOf(userId) {
    let live = this.live.get(userId);
    if (live === undefined) {
      live = { session: null, heardAt: this.started, pushed: false, missed: false };
      this.live.set(userId, live);
    }
    return live;
  }
  sessionsOf(userId) {
    let sessions = this.sessions.get(userId);
    if (sessions === undefined) {
      sessions = new Map;
      this.sessions.set(userId, sessions);
    }
    return sessions;
  }
  async hello(caller, raw, report) {
    const { userId, session } = caller;
    const relay = caller.relay.id;
    this.sessionsOf(userId).set(session, relay);
    const ask = askOf(raw);
    const doc = await this.docs.get(userId);
    const held = doc.holder;
    if (ask === null || !ask.asks)
      return { held: false, holder: held?.owner ?? null, gen: doc.gen };
    const live = this.liveOf(userId);
    const same = held !== null && held.relay === relay && held.copy === ask.copy;
    if (held !== null && !same && this.env.now() - live.heardAt <= await this.env.quietMs(userId))
      return { held: false, holder: held.owner, gen: doc.gen };
    const said2 = runtimeReportOf(report);
    const owner = said2 === null ? caller.relay.name : `${said2.name} (${said2.host})`;
    const moved = held === null || held.process !== ask.process || !same;
    if (moved || held.owner !== owner) {
      await this.docs.change(userId, (d) => {
        d.holder = { relay, copy: ask.copy, process: ask.process, owner };
      });
    }
    live.session = session;
    live.heardAt = this.env.now();
    live.pushed = false;
    live.missed = false;
    if (moved) {
      const told = { link: LINK, type: "mirror", held: false, holder: owner, gen: doc.gen };
      for (const other of this.sessionsOf(userId).keys())
        if (other !== session)
          this.env.send(told, userId, other);
    }
    return { held: true, holder: null, gen: doc.gen, ...ask.seen < doc.gen ? { dropped: { docs: [], blobs: [], all: true } } : {} };
  }
  async write(caller, mark, changed, apply) {
    const { userId } = caller;
    const doc = await this.docs.get(userId);
    const held = doc.holder;
    const { name } = this.env;
    if (mark !== undefined) {
      if (held === null || held.relay !== caller.relay.id || held.process !== mark) {
        throw new LinkRefused("conflict", `${held === null ? "No runtime keeps" : `Another runtime (${held.owner}) keeps`} ${name}'s storage now, so ${name} takes nothing from this runtime's own copy of it: this runtime reads and writes the storage directly from now on.`);
      }
      const live = this.liveOf(userId);
      live.heardAt = this.env.now();
      live.session ??= caller.session;
      await apply();
      return;
    }
    if (changed.docs.includes(MARK_PATH))
      throw new LinkRefused("bad_request", `${MARK_PATH} is where the runtime that keeps ${name}'s storage notes its copy: no other runtime writes it.`);
    await apply();
    if (changed.docs.length > 0 || changed.blobs.length > 0)
      await this.tell(userId, changed);
  }
  async tell(userId, changed) {
    const doc = await this.docs.get(userId);
    const live = this.liveOf(userId);
    if (doc.holder !== null && live.session !== null) {
      this.env.send({ link: LINK, type: "mirror", held: true, holder: null, gen: doc.gen, dropped: { ...changed, all: false } }, userId, live.session);
      live.pushed = true;
      return;
    }
    await this.raise(userId);
  }
  async raise(userId) {
    const live = this.liveOf(userId);
    if (live.missed)
      return;
    live.missed = true;
    const raised = this.docs.change(userId, (d) => {
      d.gen += 1;
    }).catch((error) => {
      live.missed = false;
      throw error;
    });
    const held = raised.then(() => {
      return;
    }, () => {
      return;
    });
    this.raising.add(held);
    held.then(() => this.raising.delete(held));
    await raised;
  }
  async release(caller, mark) {
    const { userId, session } = caller;
    const held = (await this.docs.get(userId)).holder;
    if (held === null || held.relay !== caller.relay.id || held.process !== mark)
      return false;
    const gen = await this.docs.change(userId, (d) => {
      d.holder = null;
      return d.gen;
    });
    const live = this.liveOf(userId);
    live.session = null;
    live.pushed = false;
    live.missed = false;
    const told = { link: LINK, type: "mirror", held: false, holder: null, gen };
    for (const other of this.sessionsOf(userId).keys())
      if (other !== session)
        this.env.send(told, userId, other);
    return true;
  }
  async pinged(userId, relay) {
    if ((await this.docs.get(userId)).holder?.relay === relay)
      this.liveOf(userId).heardAt = this.env.now();
  }
  sessionClosed(session) {
    for (const [userId, sessions] of this.sessions) {
      if (!sessions.delete(session))
        continue;
      const live = this.live.get(userId);
      if (live === undefined || live.session !== session)
        continue;
      live.session = null;
      if (live.pushed)
        this.raise(userId).catch((error) => this.host.log("warn", `[LumiAH] the runtime that keeps the storage may keep a change another runtime made, as that couldn't be noted: ${wordsOf(error)}`));
    }
  }
  async settle() {
    await Promise.all(this.raising);
    await this.docs.settle();
  }
}

// src/host/lore.ts
function ids(value) {
  return Array.isArray(value) ? value.filter((id2) => typeof id2 === "string" && id2 !== "") : [];
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
    for (const id2 of wanted) {
      if (id2 === null || seen.has(id2))
        continue;
      seen.add(id2);
      const book = await lore.book(id2, userId).catch(() => null);
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

// src/extension/backend/reads.ts
var blobPath = (hash) => `blobs/${hash.slice(0, 2)}/${hash}`;

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
  async putBlob(userId, hash, text5) {
    if (typeof text5 !== "string")
      throw new LinkRefused("bad_request", "A blob is text.");
    await this.host.storage.write(blobPath(Storage.hash(hash)), text5, userId);
  }
  async blobSize(userId, hash) {
    return (await this.host.storage.stat(blobPath(Storage.hash(hash)), userId))?.bytes ?? null;
  }
  async doc(userId, path) {
    const text5 = await this.host.storage.read(Storage.path(path), userId);
    if (text5 === null)
      return null;
    try {
      return JSON.parse(text5);
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
  async docs(userId, prefix) {
    if (typeof prefix !== "string" || !DOC_PREFIX.test(prefix))
      throw new LinkRefused("bad_request", "A documents' prefix is names of letters, digits, '.', '_' and '-' joined by '/'.");
    const cut = prefix.lastIndexOf("/");
    const dir = cut < 0 ? "" : prefix.slice(0, cut);
    const found = await this.host.storage.list(dir === "" ? "docs" : `docs/${dir}`, userId);
    return found.map((rel) => dir === "" ? rel : `${dir}/${rel}`).filter((path) => path.startsWith(prefix));
  }
  async blobs(userId, cursor) {
    const at2 = cursor === null || cursor === undefined ? 0 : typeof cursor === "string" && /^[0-9a-f]{2}$/.test(cursor) ? Number.parseInt(cursor, 16) : -1;
    if (at2 < 0)
      throw new LinkRefused("bad_request", "That page of the stored blobs isn't one LumiAH gave.");
    const pair = at2.toString(16).padStart(2, "0");
    const blobs = [];
    for (const name of await this.host.storage.list(`blobs/${pair}`, userId)) {
      if (!BLOB_HASH.test(name))
        continue;
      const stat = await this.host.storage.stat(blobPath(name), userId);
      if (stat !== null)
        blobs.push({ hash: name, bytes: stat.bytes, at: stat.writtenAt });
    }
    return { blobs, next: at2 < 255 ? (at2 + 1).toString(16).padStart(2, "0") : null };
  }
  async removeBlobs(userId, hashes) {
    if (!Array.isArray(hashes))
      throw new LinkRefused("bad_request", "The blobs to remove are named by their hashes.");
    for (const hash of hashes)
      await this.host.storage.remove(blobPath(Storage.hash(hash)), userId);
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

// src/host/recall.ts
var strings2 = (value) => Array.isArray(value) ? value.filter((s) => typeof s === "string" && s !== "") : [];

class RecallReads {
  host;
  deps;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
  }
  async lore(userId, chatId, known = {}) {
    const chat = await this.deps.chats.own(userId, chatId);
    const [books, sources] = await Promise.all([this.deps.lore.books(userId, chat), this.sources(userId, chat)]);
    const read2 = await Promise.all(books.map(async (book) => {
      const record2 = await this.host.lore.record(book.id, userId);
      if (record2 === null)
        return null;
      const over = record2.updatedAt > 0 && this.deps.now() >= (Math.floor(record2.updatedAt / 1000) + 1) * 1000;
      const stamp = over ? record2.updatedAt : 0;
      const entries = stamp > 0 && known[book.id] === stamp ? null : (await this.host.lore.records(book.id, userId)).map(({ extensions: _kept, ...entry }) => entry);
      return { id: record2.id, name: record2.name, description: record2.description, source: sources.get(record2.id) ?? null, updatedAt: stamp, entries };
    }));
    return read2.filter((book) => book !== null);
  }
  async sources(userId, chat) {
    const { lore } = this.host;
    const [ofCharacter, ofPersona, global] = await Promise.all([
      chat.characterId !== null ? lore.ofCharacter(chat.characterId, userId).catch(() => []) : [],
      lore.ofPersona(null, userId).catch(() => null),
      lore.global(userId).catch(() => [])
    ]);
    const out = new Map;
    for (const id2 of global)
      out.set(id2, "global");
    for (const id2 of strings2(chat.metadata.chat_world_book_ids))
      out.set(id2, "chat");
    if (ofPersona !== null)
      out.set(ofPersona, "persona");
    for (const id2 of ofCharacter)
      out.set(id2, "character");
    return out;
  }
  async messages(userId, chatId, from, to) {
    await this.deps.chats.own(userId, chatId);
    return (await this.deps.chats.range(chatId, from, to)).map((m) => ({ id: m.id, index: m.index, role: m.role, name: m.name, swipeId: m.swipeId, content: m.content, at: m.at }));
  }
}

// src/extension/backend/recall.ts
var SAME_BUILD = "update the runtime and LumiAH to the same build";
function text5(value, what) {
  if (typeof value !== "string" || value === "")
    throw new LinkRefused("bad_request", `The request names no ${what}: ${SAME_BUILD}.`);
  return value;
}
function whole5(value, what) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new LinkRefused("bad_request", `The request's ${what} isn't a whole number: ${SAME_BUILD}.`);
  return value;
}
function givenUp(work, signal) {
  if (signal === undefined)
    return work;
  const { promise, resolve, reject } = Promise.withResolvers();
  const ended = () => reject(signal.reason instanceof Error ? signal.reason : new Error("The call was cancelled."));
  work.then(resolve, reject).finally(() => signal.removeEventListener("abort", ended));
  if (signal.aborted)
    ended();
  else
    signal.addEventListener("abort", ended, { once: true });
  return promise;
}
function bookEntryOf(e) {
  const own = e.extensions.lumibooks;
  const kept = e.extensions.lumibooks_summary;
  const extensions = {};
  if (isRecord2(own)) {
    extensions.lumibooks = {
      ...typeof own.chatId === "string" ? { chatId: own.chatId } : {},
      ...typeof own.tier === "number" ? { tier: own.tier } : {},
      ...Array.isArray(own.msgIds) ? { msgIds: strings2(own.msgIds) } : {},
      ...typeof own.firstMsgIdx === "number" ? { firstMsgIdx: own.firstMsgIdx } : {},
      ...typeof own.lastMsgIdx === "number" ? { lastMsgIdx: own.lastMsgIdx } : {},
      ...typeof own.title === "string" ? { title: own.title } : {},
      ...own.isRoot === true ? { isRoot: true } : {}
    };
  }
  if (isRecord2(kept)) {
    extensions.lumibooks_summary = {
      ...typeof kept.tier === "number" ? { tier: kept.tier } : {},
      ...Array.isArray(kept.messageIndices) ? { messageIndices: kept.messageIndices.filter((n) => typeof n === "number") } : {}
    };
  }
  return { id: e.id, comment: e.title, content: e.content, extensions };
}
var LUMIBOOKS_MARKS = ["lumibooks_chat_id", "lumibooks_codex_chat_id"];
var KEPT_HASH = /^[0-9a-f]{64}$/;
function keptHashesOf(metadata) {
  const filed = isRecord2(metadata.extensions) ? metadata.extensions.lumibooks_summary : undefined;
  const mark = isRecord2(metadata.lumibooks_summary) ? metadata.lumibooks_summary : filed;
  if (!isRecord2(mark) || !Array.isArray(mark.messages))
    return null;
  const out = new Map;
  for (const m of mark.messages)
    if (isRecord2(m) && typeof m.index === "number" && Number.isSafeInteger(m.index) && m.index >= 0 && typeof m.hash === "string" && KEPT_HASH.test(m.hash))
      out.set(m.index, m.hash);
  return [...out].map(([index, hash]) => ({ index, hash }));
}

class Recall {
  host;
  deps;
  reads;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
    this.reads = new RecallReads(host, deps);
  }
  ports(userId) {
    const { embeddings, databanks, web } = this.host;
    return {
      lore: { read: (chatId, known) => this.reads.lore(userId, chatId, known), activated: (chatId, generationId) => this.activated(userId, chatId, generationId) },
      chat: { messages: (chatId, from, to) => this.reads.messages(userId, chatId, from, to) },
      embeddings: { connection: () => embeddings.connection(userId), embed: (texts, kind, signal) => this.embed(userId, texts, kind, signal) },
      memory: {
        enabled: (chatId) => this.memoryOn(userId, chatId),
        search: (chatId, query, options, signal) => this.memorySearch(userId, chatId, query, options, signal),
        entity: (chatId, name) => this.memoryEntity(userId, chatId, name),
        entities: (chatId, limit2) => this.memoryEntities(userId, chatId, limit2),
        arcs: (chatId) => this.memoryArcs(userId, chatId)
      },
      databanks: { list: (chatId) => this.databanks(userId, chatId), documents: (databankId) => databanks.documents(databankId, userId), content: (documentId) => databanks.content(documentId, userId) },
      web: { enabled: () => web.enabled(userId), search: (query, options, signal) => this.webSearch(userId, query, options, signal) }
    };
  }
  book(userId) {
    return { read: (chatId) => this.chatBook(userId, chatId) };
  }
  async serve(userId, type, r) {
    const { embeddings, databanks, web } = this.host;
    switch (type) {
      case "recall.lore.read": {
        const known = {};
        if (isRecord2(r.known)) {
          for (const [id2, at2] of Object.entries(r.known))
            if (typeof at2 === "number" && Number.isFinite(at2))
              known[id2] = at2;
        }
        return { books: await this.reads.lore(userId, text5(r.chat, "chat"), known) };
      }
      case "recall.lore.activated":
        return { entries: await this.activated(userId, text5(r.chat, "chat"), text5(r.generation, "generation")) };
      case "recall.chat.messages":
        return { messages: await this.reads.messages(userId, text5(r.chat, "chat"), whole5(r.from, "range"), whole5(r.to, "range")) };
      case "recall.embedder":
        return { connection: await embeddings.connection(userId) };
      case "recall.embed": {
        if (!Array.isArray(r.texts) || !r.texts.every((t) => typeof t === "string") || r.kind !== "query" && r.kind !== "stored")
          throw new LinkRefused("bad_request", `The request to embed is malformed: ${SAME_BUILD}.`);
        return this.embed(userId, r.texts, r.kind);
      }
      case "recall.memory.enabled":
        return { enabled: await this.memoryOn(userId, text5(r.chat, "chat")) };
      case "recall.memory.search":
        return { hits: await this.memorySearch(userId, text5(r.chat, "chat"), typeof r.query === "string" ? r.query : "", { limit: whole5(r.limit, "limit"), entities: strings2(r.entities) }) };
      case "recall.memory.entity":
        return { entity: await this.memoryEntity(userId, text5(r.chat, "chat"), text5(r.name, "entity")) };
      case "recall.memory.entities":
        return { entities: await this.memoryEntities(userId, text5(r.chat, "chat"), whole5(r.limit, "limit")) };
      case "recall.memory.arcs":
        return { arcs: await this.memoryArcs(userId, text5(r.chat, "chat")) };
      case "recall.databanks.list":
        return { databanks: await this.databanks(userId, text5(r.chat, "chat")) };
      case "recall.databanks.documents":
        return { documents: await databanks.documents(text5(r.databank, "databank"), userId) };
      case "recall.databanks.content":
        return { text: await databanks.content(text5(r.document, "document"), userId) };
      case "recall.web.enabled":
        return { enabled: await web.enabled(userId) };
      case "recall.web.search":
        return { results: await this.webSearch(userId, typeof r.query === "string" ? r.query : "", { count: whole5(r.count, "count"), pages: r.pages === true }) };
      case "book.read":
        return { book: await this.chatBook(userId, text5(r.chat, "chat")) };
    }
  }
  async activated(userId, chatId, generationId) {
    return Promise.all(this.deps.activated(userId, chatId, generationId).map(async (a) => {
      const entry = await this.host.lore.entry(a.entryId, userId).catch(() => null);
      return { entryId: a.entryId, bookId: a.bookId ?? entry?.bookId ?? null, title: a.title !== "" ? a.title : entry?.title ?? "", how: a.how ?? null, ...a.score !== undefined ? { score: a.score } : {}, ...entry !== null ? { content: entry.content } : {} };
    }));
  }
  async embed(userId, texts, kind, signal) {
    if (texts.length === 0 || texts.length > EMBED_BATCH_MAX)
      throw new LinkRefused("bad_request", `One call embeds from 1 to ${EMBED_BATCH_MAX} texts, and this one has ${texts.length}.`);
    const wrong = texts.findIndex((t) => t.trim() === "" || t.length > EMBED_TEXT_MAX);
    if (wrong >= 0)
      throw new LinkRefused("bad_request", `A text to embed is not blank and has ${EMBED_TEXT_MAX} characters at most: text ${wrong + 1} of this call isn't so.`);
    const out = await this.host.embeddings.embed(texts, kind, userId, signal);
    if (out.vectors.length !== texts.length)
      throw new Error(`The embedding connection answered ${out.vectors.length} vectors for ${texts.length} texts.`);
    return out;
  }
  async memoryOn(userId, chatId) {
    const chat = await this.deps.chats.own(userId, chatId);
    const own = chat.metadata.cortex_settings;
    if (chat.metadata.temporary === true || isRecord2(own) && own.enabled === false)
      return false;
    return this.host.memory.enabled(userId);
  }
  async memorySearch(userId, chatId, query, options, signal) {
    signal?.throwIfAborted();
    await this.deps.chats.own(userId, chatId);
    return givenUp(this.host.memory.search(chatId, query, options, userId), signal);
  }
  async memoryEntity(userId, chatId, name) {
    await this.deps.chats.own(userId, chatId);
    return this.host.memory.entity(chatId, name, userId);
  }
  async memoryEntities(userId, chatId, limit2) {
    await this.deps.chats.own(userId, chatId);
    return this.host.memory.entities(chatId, limit2, userId);
  }
  async memoryArcs(userId, chatId) {
    await this.deps.chats.own(userId, chatId);
    return this.host.memory.arcs(chatId, userId);
  }
  async databanks(userId, chatId) {
    const chat = await this.deps.chats.own(userId, chatId);
    const on = (await this.host.databanks.list(userId)).filter((bank) => bank.enabled);
    if (on.length === 0)
      return [];
    const character = chat.metadata.memory_isolation === true ? null : chat.characterId;
    const named2 = new Set([...strings2(chat.metadata.chat_databank_ids), ...character !== null ? await this.host.databanks.ofCharacter(character, userId).catch(() => []) : []]);
    return on.filter((bank) => bank.scope === "global" || bank.scope === "chat" && bank.scopeId === chat.id || bank.scope === "character" && character !== null && bank.scopeId === character || named2.has(bank.id)).map((bank) => ({ id: bank.id, name: bank.name, description: bank.description, scope: bank.scope, documents: bank.documents }));
  }
  async webSearch(userId, query, options, signal) {
    signal?.throwIfAborted();
    if (options.count < 1)
      return [];
    return givenUp(this.host.web.search(query, { count: options.count, pages: options.pages }, userId), signal);
  }
  async chatBook(userId, chatId) {
    const chat = await this.deps.chats.own(userId, chatId);
    const { lore } = this.host;
    const claimed = chat.metadata.lumibooks_book_id;
    const named2 = typeof claimed === "string" && claimed !== "" ? await lore.record(claimed, userId) : null;
    const own = named2 !== null && named2.metadata.lumibooks_chat_id === chat.id ? await lore.records(named2.id, userId) : [];
    let entries = own.length > 0 ? own : null;
    let kept = null;
    for (const id2 of strings2(chat.metadata.chat_world_book_ids)) {
      if (kept !== null && entries !== null)
        break;
      const record2 = await lore.record(id2, userId);
      if (record2 === null || LUMIBOOKS_MARKS.some((mark) => record2.metadata[mark] !== undefined))
        continue;
      const hashes = keptHashesOf(record2.metadata);
      if (entries !== null) {
        kept ??= hashes;
        continue;
      }
      const summaries = await lore.records(id2, userId);
      if (hashes === null && !summaries.some((e) => isRecord2(e.extensions.lumibooks_summary)))
        continue;
      entries = summaries;
      kept = hashes ?? [];
    }
    return entries === null ? null : { entries: entries.map(bookEntryOf), hashes: await this.hashes(chat.id, kept ?? []) };
  }
  async hashes(chatId, kept) {
    if (kept.length === 0)
      return [];
    const first = kept.reduce((least, k) => Math.min(least, k.index), Number.POSITIVE_INFINITY);
    const last = kept.reduce((most, k) => Math.max(most, k.index), 0);
    const now = new Map((await this.deps.chats.range(chatId, first, last + 1)).map((m) => [m.index, m]));
    const out = [];
    for (const k of kept) {
      const m = now.get(k.index);
      out.push({ index: k.index, kept: k.hash, now: m === undefined ? null : await textHash(JSON.stringify([m.role, m.content])) });
    }
    return out.sort((a, b) => a.index - b.index);
  }
}

// src/extension/backend/registry.ts
var FILE3 = "registry.json";
var port = (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
function registryOf(raw) {
  if (!isRecord2(raw) || raw.v !== 1)
    return null;
  const out = { v: 1, key: null, relays: {}, replied: raw.replied === true };
  const k = raw.key;
  if (isRecord2(k) && typeof k.hash === "string" && typeof k.print === "string" && typeof k.at === "number")
    out.key = { hash: k.hash, print: k.print, at: k.at };
  if (isRecord2(raw.relays)) {
    for (const [id2, x] of Object.entries(raw.relays)) {
      if (!isRecord2(x) || typeof x.name !== "string" || typeof x.secret !== "string" || !port(x.port))
        continue;
      out.relays[id2] = { id: id2, name: x.name, secret: x.secret, build: typeof x.build === "string" ? x.build : "", host: typeof x.host === "string" ? x.host : "", listen: typeof x.listen === "string" ? x.listen : "127.0.0.1", port: x.port, registeredAt: typeof x.registeredAt === "number" ? x.registeredAt : 0, report: runtimeReportOf(x.report) };
    }
  }
  return out;
}

class RegistryStore {
  docs;
  constructor(host) {
    this.docs = new UserDocs(host, FILE3, registryOf, () => ({ v: 1, key: null, relays: {}, replied: false }));
  }
  read(userId) {
    return this.docs.get(userId);
  }
  change(userId, fn) {
    return this.docs.change(userId, fn);
  }
  async keyIs(userId, key2) {
    const stored = (await this.read(userId)).key;
    return stored !== null && stored.hash === await sha256(key2);
  }
  settle() {
    return this.docs.settle();
  }
}

// src/extension/backend/identity.ts
var LUMIAH = { identifier: EXTENSION_IDENTIFIER, name: OWN_BACKEND.name, connectionName: OWN_BACKEND.connection, anchorKey: EXTENSION_IDENTIFIER };
function identityOf(given = {}) {
  const identifier = given.identifier ?? LUMIAH.identifier;
  const own = identifier === LUMIAH.identifier;
  const name = given.name ?? (own ? LUMIAH.name : identifier);
  return { identifier, name, connectionName: given.connectionName ?? name, anchorKey: given.anchorKey ?? (own ? LUMIAH.anchorKey : identifier), ...given.settingsAt !== undefined ? { settingsAt: given.settingsAt } : {} };
}
function linkedBackend(identity) {
  return { name: identity.name, connection: identity.connectionName, ...identity.settingsAt !== undefined ? { settingsAt: identity.settingsAt } : {} };
}

// src/extension/backend/relays.ts
var SEP4 = "\x00";
var key2 = (userId, relay) => `${userId}${SEP4}${relay}`;
var short = (v2) => typeof v2 === "string" && v2.length <= REPORT_TEXT_MAX;
var installOf = (r) => r === null ? "" : JSON.stringify([r.name, r.build, r.runtime, r.host, r.listen, r.port]);
var SHA256 = /^[0-9a-f]{64}$/;

class Relays {
  host;
  registry;
  settings;
  env;
  live = new Map;
  sessions = new Map;
  outgoing = new Map;
  goneAt = new Map;
  changed = [];
  pinged = [];
  checking = new Map;
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
    const k = key2(userId, relay);
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
    const state2 = this.stateOf(live, (await this.settings.transport(userId)).link.quietMs);
    if (state2 === live.shown)
      return;
    live.shown = state2;
    this.tell(userId);
  }
  authenticate(secret, userId, session) {
    const hashing = typeof secret === "string" && secret !== "" ? sha256(secret) : null;
    hashing?.catch(() => {
      return;
    });
    const checked = (this.checking.get(session) ?? Promise.resolve()).then(() => this.check(hashing, userId, session));
    const ended = checked.then(() => {
      return;
    }, () => {
      return;
    });
    this.checking.set(session, ended);
    ended.then(() => {
      if (this.checking.get(session) === ended)
        this.checking.delete(session);
    });
    return checked;
  }
  async check(hashing, userId, session) {
    const { name: shown } = this.env.identity;
    const refused2 = new LinkRefused("forbidden", `${shown} doesn't know this runtime (its registration was forgotten or replaced): run its start line on ${shown}'s Runtime page again.`);
    if (hashing === null)
      throw refused2;
    const hash = await hashing;
    const relays = (await this.registry.read(userId)).relays;
    let relay = Object.values(relays).find((r) => r.secret === hash);
    if (relay !== undefined)
      this.outgoing.delete(key2(userId, relay.id));
    else {
      relay = Object.values(relays).find((r) => {
        const old = this.outgoing.get(key2(userId, r.id));
        return old !== undefined && old.hash === hash && this.env.now() <= old.until;
      });
      if (relay === undefined)
        throw refused2;
    }
    const live = this.liveOf(userId, relay.id);
    if (live.session !== session) {
      if (live.session !== null)
        this.sessions.delete(live.session);
      live.session = session;
      this.sessions.set(session, key2(userId, relay.id));
      this.goneAt.delete(key2(userId, relay.id));
    }
    return { userId, relay, session };
  }
  async register(fields, userId) {
    const { name, build, host, listen, port: port2 } = fields;
    if (typeof name !== "string" || !RUNTIME_NAME.test(name))
      throw new LinkRefused("bad_request", "A runtime's name is lowercase letters, digits, _ and -, up to 40.");
    const { identity } = this.env;
    if (!short(build) || !short(host) || !short(listen) || listen === "" || typeof port2 !== "number" || !Number.isInteger(port2) || port2 < 1 || port2 > 65535)
      throw new LinkRefused("bad_request", `The runtime's registration is malformed: update the runtime and ${identity.name} to the same build.`);
    const most = (await this.settings.transport(userId)).link.relays;
    const shown = typeof fields.secret === "string" && fields.secret !== "" ? await sha256(fields.secret) : null;
    const secret = randomHex(256);
    const hash = await sha256(secret);
    const now = this.env.now();
    const made = await this.registry.change(userId, (registry) => {
      const held = Object.values(registry.relays).find((r) => r.name === name);
      if (held === undefined && Object.keys(registry.relays).length >= most)
        return null;
      const relay = held?.id ?? randomHex(64);
      const stands2 = held !== undefined && held.secret === shown;
      registry.relays[relay] = { id: relay, name, secret: stands2 ? held.secret : hash, build, host, listen, port: port2, registeredAt: stands2 ? held.registeredAt : now, report: held?.report ?? null };
      return { relay, stands: stands2 };
    });
    if (made === null)
      throw new LinkRefused("conflict", `This account has ${most} runtimes registered already: forget one on ${identity.name}'s Runtime page first.`);
    const { relay: id2, stands } = made;
    if (!stands) {
      const live = this.liveOf(userId, id2);
      if (live.session !== null) {
        this.sessions.delete(live.session);
        this.goneAt.set(key2(userId, id2), this.env.now());
      }
      live.session = null;
      live.refused = null;
      this.outgoing.delete(key2(userId, id2));
    }
    this.host.log("info", `[LumiAH] runtime "${name}" ${stands ? "set up again: its registration stands" : "registered"}`);
    this.tell(userId);
    return { relay: id2, secret: stands && typeof fields.secret === "string" ? fields.secret : secret, model: loopbackModel(identity.identifier), user: userId, backend: linkedBackend(identity) };
  }
  offer() {
    const shipped = this.env.runtime;
    const dir = this.host.install.dir;
    if (shipped === undefined || dir === null || !SHA256.test(shipped.sha256) || !Number.isSafeInteger(shipped.size) || shipped.size <= 0)
      return null;
    return { build: this.env.build, path: `${dir}/lumiah.js`, sha256: shipped.sha256 };
  }
  offerTo(caller, report) {
    const offer = this.offer();
    if (offer === null || report === null || report.build === this.env.build)
      return;
    this.env.send({ link: LINK, type: "update", ...offer }, caller.userId, caller.session);
  }
  async hello(caller, fields) {
    const live = this.liveOf(caller.userId, caller.relay.id);
    const version = fields.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version))
      throw new LinkRefused("bad_request", `The runtime's hello names no link version: update the runtime with its start line on ${this.env.identity.name}'s Runtime page.`);
    const report = runtimeReportOf(fields.report);
    if (version !== LINK_VERSION) {
      live.refused = versionWords(version, LINK_VERSION, this.env.identity.name);
      live.seenAt = this.env.now();
      if (report !== null)
        live.report = report;
      live.shown = "refused";
      this.tell(caller.userId);
      this.offerTo(caller, report);
      throw new LinkRefused("version", live.refused);
    }
    live.refused = null;
    await this.heard(caller, fields.report);
    this.offerTo(caller, report);
  }
  start() {
    this.host.frontend.everyone({ link: LINK, type: "greet" });
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
    this.goneAt.set(k, this.env.now());
    live.turns = [];
    live.shown = this.stateOf(live, 0);
    this.tell(k.slice(0, k.indexOf(SEP4)));
  }
  async tick() {
    const now = this.env.now();
    for (const [k, old] of this.outgoing)
      if (now > old.until)
        this.outgoing.delete(k);
    for (const [k, live] of this.live)
      if (live.session !== null)
        await this.follow(k.slice(0, k.indexOf(SEP4)), live).catch(() => {
          return;
        });
  }
  isLinked(userId, relay) {
    return (this.live.get(key2(userId, relay))?.session ?? null) !== null;
  }
  goneFor(userId, relay) {
    const at2 = this.goneAt.get(key2(userId, relay));
    return at2 === undefined ? null : Math.max(0, this.env.now() - at2);
  }
  push(userId, relay, push) {
    const session = this.live.get(key2(userId, relay))?.session ?? null;
    if (session === null)
      return false;
    this.env.send(push, userId, session);
    return true;
  }
  async ready(userId) {
    return (await this.linked(userId)).length > 0 && (await this.registry.read(userId)).key !== null && await this.env.hasLoopback(userId);
  }
  async linked(userId) {
    const quietMs = (await this.settings.transport(userId)).link.quietMs;
    const seen = (r) => this.live.get(key2(userId, r.id))?.seenAt ?? 0;
    return Object.values((await this.registry.read(userId)).relays).filter((r) => this.stateOf(this.live.get(key2(userId, r.id)), quietMs) === "linked").sort((a, b) => seen(b) - seen(a));
  }
  async bases(userId) {
    return Object.values((await this.registry.read(userId)).relays).map((r) => runtimeBase(r.listen, r.port));
  }
  async rotate(userId, relay) {
    const held = (await this.registry.read(userId)).relays[relay];
    if (held === undefined)
      throw new LinkRefused("not_found", "There is no such runtime.");
    const transport = await this.settings.transport(userId);
    if (this.stateOf(this.live.get(key2(userId, relay)), transport.link.quietMs) !== "linked")
      throw new LinkRefused("unavailable", "This runtime isn't linked now, so it couldn't take a new secret. Start it first, or forget it and run its start line again.");
    const secret = randomHex(256);
    const hash = await sha256(secret);
    this.outgoing.set(key2(userId, relay), { hash: held.secret, until: this.env.now() + transport.runtime.requestMs });
    await this.registry.change(userId, (r) => {
      const record2 = r.relays[relay];
      if (record2 !== undefined)
        record2.secret = hash;
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
    const k = key2(userId, relay);
    const session = this.live.get(k)?.session ?? null;
    if (session !== null)
      this.sessions.delete(session);
    if (!this.goneAt.has(k))
      this.goneAt.set(k, this.env.now());
    this.live.delete(k);
    this.outgoing.delete(k);
    this.tell(userId);
  }
  relayOf(userId, session) {
    const bound = this.sessions.get(session);
    return bound !== undefined && bound.startsWith(`${userId}${SEP4}`) ? bound.slice(userId.length + SEP4.length) : null;
  }
  turnsOf(userId, relay) {
    return this.live.get(key2(userId, relay))?.turns ?? [];
  }
  reachable(userId, relay) {
    return (this.live.get(key2(userId, relay))?.session ?? null) !== null;
  }
  async view(userId, issues) {
    const quietMs = (await this.settings.transport(userId)).link.quietMs;
    const { bun, dir } = this.host.install;
    const { identity } = this.env;
    const script = dir === null ? null : `${dir}/lumiah.js`;
    const named2 = identity.identifier === EXTENSION_IDENTIFIER ? [] : ["--extension", identity.identifier];
    const relays = Object.values((await this.registry.read(userId)).relays).sort((a, b) => a.registeredAt - b.registeredAt).map((r) => {
      const live = this.live.get(key2(userId, r.id));
      const report = live?.report ?? r.report;
      const link = this.stateOf(live, quietMs);
      if (live !== undefined)
        live.shown = link;
      const unit = report?.runtime.unit ?? null;
      const updateBun = bun ?? report?.runtime.bun ?? null;
      const loginBun = report?.runtime.bun ?? bun;
      const problem = link === "linked" ? null : link === "refused" ? live?.refused ?? null : link === "quiet" ? `${identity.name} hasn't heard from this runtime for over ${Math.round(quietMs / 1000)} seconds. Check that it is still running${unit !== null ? ` (systemctl --user status ${unit})` : ""}.` : `This runtime isn't connected to Lumiverse now. ${unit !== null ? `Check its service (systemctl --user status ${unit}), or run its update line.` : "Start it with its line."}`;
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
          update: updateBun !== null && script !== null ? [updateBun, script, "up", "--name", r.name, ...named2, ...unit !== null ? ["--systemd"] : []].map(shellWord).join(" ") : null,
          login: report !== null && loginBun !== null ? [loginBun, report.runtime.script, "login", "--name", r.name].map(shellWord).join(" ") : null
        }
      };
    });
    const missing = [...bun === null ? ["the path of Lumiverse's Bun (use the full path of your own bun)"] : [], ...script === null ? [`where this extension is installed (the runtime is dist/lumiah.js in ${identity.name}'s extension folder)`] : []];
    const line = (systemd) => bun === null || script === null ? null : `${[bun, script, "up", "--url"].map(shellWord).join(" ")} ${[URL_SLOT, ...named2.map(shellWord), ...systemd ? ["--systemd"] : []].join(" ")}`;
    return { build: this.env.build, link: LINK_VERSION, model: loopbackModel(identity.identifier), relays, start: { service: line(true), foreground: line(false), missing }, issues, ready: await this.ready(userId), selfUpdate: this.offer() !== null, ...this.env.switchedBy !== undefined ? { switchedBy: this.env.switchedBy } : {} };
  }
}

// src/link/parts.ts
var PART_UNITS = 512 * 1024;
var ENVELOPE_BYTES = 1024;
var encoder = new TextEncoder;
function needsParts(text6) {
  if (text6.length * 3 + ENVELOPE_BYTES <= FRAME_LIMIT)
    return false;
  return encoder.encode(text6).length + ENVELOPE_BYTES > FRAME_LIMIT;
}
function splitFrame(text6, id2) {
  const count2 = Math.max(1, Math.ceil(text6.length / PART_UNITS));
  const parts = [];
  for (let index = 0;index < count2; index++)
    parts.push({ link: LINK, type: "part", id: id2, index, count: count2, data: text6.slice(index * PART_UNITS, (index + 1) * PART_UNITS) });
  return parts;
}
function partOf(raw) {
  if (!isRecord2(raw) || raw.link !== LINK || raw.type !== "part")
    return null;
  const { id: id2, index, count: count2, data } = raw;
  if (typeof id2 !== "string" || id2 === "" || typeof data !== "string")
    return null;
  if (typeof index !== "number" || typeof count2 !== "number" || !Number.isSafeInteger(index) || !Number.isSafeInteger(count2) || count2 < 1 || index < 0 || index >= count2)
    return null;
  return { link: LINK, type: "part", id: id2, index, count: count2, data };
}
var millions = (units) => (units / 1048576).toFixed(0);

class PartJoiner {
  limits;
  groups = new Map;
  units = 0;
  constructor(limits) {
    this.limits = limits;
  }
  get waiting() {
    return this.groups.size;
  }
  get held() {
    return this.units;
  }
  take(part, now, from = "") {
    const { maxUnits, maxFrames, maxHeldUnits, shared } = this.limits();
    this.purge(now);
    const key3 = `${from}\x00${part.id}`;
    const tooLarge = () => {
      this.drop(key3);
      return { refused: `That frame is over ${millions(maxUnits)} million characters, the most LumiAH's link puts together.`, id: part.id, over: "frame" };
    };
    if (part.count * PART_UNITS - PART_UNITS >= maxUnits)
      return tooLarge();
    let group = this.groups.get(key3);
    if (group === undefined || group.count !== part.count) {
      this.drop(key3);
      if (maxFrames !== undefined && this.groups.size >= maxFrames)
        return { refused: `LumiAH's link is already putting together ${this.groups.size} frames that came in parts, the most it does at once.`, id: part.id, over: "frames" };
      if (shared !== undefined && this.groups.size >= shared.frames)
        return { refused: "LumiAH is busy: its link is putting together as many frames that came in parts as it does at once, for every account together.", id: part.id, over: "shared" };
      group = { from, count: part.count, pieces: new Array(part.count), got: 0, units: 0, at: now };
      this.groups.set(key3, group);
    }
    if (group.pieces[part.index] === undefined) {
      group.pieces[part.index] = part.data;
      group.got++;
      group.units += part.data.length;
      this.units += part.data.length;
    }
    if (group.units > maxUnits)
      return tooLarge();
    if (maxHeldUnits !== undefined && this.units > maxHeldUnits) {
      this.drop(key3);
      return { refused: `That frame would have LumiAH's link hold over ${millions(maxHeldUnits)} million characters of frames that come in parts, the most it holds at once.`, id: part.id, over: "held" };
    }
    if (shared !== undefined && this.units > shared.units) {
      this.drop(key3);
      return { refused: "LumiAH is busy: its link holds as much as it does at once of frames that come in parts, for every account together.", id: part.id, over: "shared" };
    }
    if (group.got < group.count)
      return { waiting: true };
    this.drop(key3);
    return { text: group.pieces.join("") };
  }
  purge(now) {
    const { staleMs } = this.limits();
    for (const [key3, group] of this.groups)
      if (now - group.at > staleMs)
        this.drop(key3);
  }
  clear(from) {
    for (const [key3, group] of this.groups)
      if (from === undefined || group.from === from)
        this.drop(key3);
  }
  drop(key3) {
    const group = this.groups.get(key3);
    if (group === undefined)
      return;
    this.groups.delete(key3);
    this.units -= group.units;
  }
}

// src/extension/backend/server.ts
var text6 = (v2, what) => {
  if (typeof v2 !== "string" || v2 === "")
    throw new LinkRefused("bad_request", `The request names no ${what}: update the runtime and LumiAH to the same build.`);
  return v2;
};
var whole6 = (v2, what) => {
  if (typeof v2 !== "number" || !Number.isSafeInteger(v2) || v2 < 0)
    throw new LinkRefused("bad_request", `The request's ${what} isn't a whole number: update the runtime and LumiAH to the same build.`);
  return v2;
};
var short2 = (v2) => typeof v2 === "string" && v2 !== "";
var asOf = (v2) => v2 === undefined || typeof v2 === "string";
function toolCallOf(raw) {
  if (!isRecord2(raw) || !short2(raw.name) || !isRecord2(raw.args) || !short2(raw.turn) || typeof raw.chatId !== "string" || !short2(raw.agentId) || typeof raw.role !== "string" || !short2(raw.callId) || !short2(raw.kind) || typeof raw.main !== "boolean" || !asOf(raw.as) || !Array.isArray(raw.above) || !raw.above.every((over) => isRecord2(over) && short2(over.agentId) && typeof over.role === "string" && asOf(over.as))) {
    throw new LinkRefused("bad_request", "The tool call is malformed: update the runtime and LumiAH to the same build.");
  }
  const above = raw.above.map(({ agentId, role, as }) => ({ agentId, role, ...as !== undefined ? { as } : {} }));
  return { name: raw.name, args: raw.args, turn: raw.turn, chatId: raw.chatId, agentId: raw.agentId, role: raw.role, callId: raw.callId, kind: raw.kind, main: raw.main, above, ...raw.as !== undefined ? { as: raw.as } : {} };
}
function approvalAskOf(raw) {
  if (!isRecord2(raw) || !short2(raw.turn) || typeof raw.chatId !== "string" || !short2(raw.agentId) || typeof raw.role !== "string" || !short2(raw.callId) || !short2(raw.tool) || !(raw.tier === "read" || raw.tier === "write" || raw.tier === "external") || !isRecord2(raw.args) || typeof raw.at !== "number" || !(raw.until === null || typeof raw.until === "number")) {
    throw new LinkRefused("bad_request", "The held call is malformed: update the runtime and LumiAH to the same build.");
  }
  return { turn: raw.turn, chatId: raw.chatId, agentId: raw.agentId, role: raw.role, callId: raw.callId, tool: raw.tool, tier: raw.tier, args: raw.args, at: raw.at, until: raw.until };
}
function jobOf2(raw) {
  if (!isRecord2(raw) || !short2(raw.id) || !short2(raw.chatId) || typeof raw.agent !== "string" || typeof raw.task !== "string" || typeof raw.state !== "string" || typeof raw.createdAt !== "number") {
    throw new LinkRefused("bad_request", "The job is malformed: update the runtime and LumiAH to the same build.");
  }
  return raw;
}
var streamId = (v2) => {
  if (typeof v2 !== "string" || !STREAM_ID.test(v2))
    throw new LinkRefused("bad_request", "A stream is named by 32 hex characters: update the runtime and LumiAH to the same build.");
  return v2;
};
var strings3 = (v2) => Array.isArray(v2) ? v2.filter((s) => typeof s === "string") : [];
function openOf2(v2) {
  if (!Array.isArray(v2))
    return [];
  return v2.flatMap((o) => isRecord2(o) && typeof o.stream === "string" && typeof o.seq === "number" && Number.isSafeInteger(o.seq) && o.seq >= 0 ? [{ stream: o.stream, seq: o.seq }] : []);
}
function joinAdvice(over, name) {
  const setting = (title) => `"${title}" (${name} \u2192 Settings \u2192 Transport \u2192 Link)`;
  if (over === "shared")
    return "Send this one again in a moment.";
  if (over === "frame")
    return `Raise ${setting("Largest frame joined")} to send one that large.`;
  return `Those frames are this account's own: send this one again once they are done, or raise ${setting(over === "frames" ? "Frames joined at once" : "Characters held while joining")}.`;
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
  send(frame, userId, session, id2 = randomHex(64)) {
    const whole7 = JSON.stringify(frame);
    if (!needsParts(whole7)) {
      this.host.frontend.send(frame, userId, session);
      return;
    }
    const parts = splitFrame(whole7, id2);
    const next = (at2) => {
      const part = parts[at2];
      if (part === undefined)
        return;
      this.host.frontend.send(part, userId, session);
      this.deps.later(0, () => next(at2 + 1));
    };
    next(0);
  }
  answer(id2, userId, session, body, took) {
    const frame = { link: LINK, type: "result", id: id2, body, ...took !== undefined ? { took } : {} };
    if (session === undefined)
      this.host.frontend.send(frame, userId);
    else
      this.send(frame, userId, session, id2);
  }
  refuse(id2, userId, session, code, message, took) {
    const frame = { link: LINK, type: "error", id: id2, code, message, ...took !== undefined ? { took } : {} };
    this.host.frontend.send(frame, userId, session);
  }
  sessionClosed(session) {
    for (const [userId, joiner] of this.joiners) {
      joiner.clear(session);
      if (joiner.waiting === 0)
        this.joiners.delete(userId);
    }
  }
  sweep() {
    const now = this.deps.now();
    for (const [userId, joiner] of this.joiners) {
      joiner.purge(now);
      if (joiner.waiting === 0)
        this.joiners.delete(userId);
    }
  }
  joining(userId) {
    const joiner = this.joiners.get(userId);
    return { frames: joiner?.waiting ?? 0, units: joiner?.held ?? 0 };
  }
  async frame(payload, userId, session) {
    if (!isLinkFrame(payload))
      return false;
    let raw = payload;
    const part = partOf(payload);
    if (part !== null) {
      if (!this.limits.has(userId))
        this.limits.set(userId, (await this.deps.settings.transport(userId)).link);
      let joiner = this.joiners.get(userId);
      if (joiner === undefined) {
        joiner = new PartJoiner(() => {
          const link = this.limits.get(userId) ?? TRANSPORT_DEFAULTS.link;
          const shared = { frames: CEILINGS.joinFramesTotal, units: CEILINGS.joinHeldUnitsTotal };
          for (const [other, theirs] of this.joiners) {
            if (other === userId)
              continue;
            shared.frames -= theirs.waiting;
            shared.units -= theirs.held;
          }
          return { maxUnits: Math.min(link.joinMaxUnits, CEILINGS.joinMaxUnits), staleMs: Math.min(link.partStaleMs, CEILINGS.partStaleMs), maxFrames: Math.min(link.joinFrames, CEILINGS.joinFrames), maxHeldUnits: Math.min(link.joinHeldUnits, CEILINGS.joinHeldUnits), shared };
        });
        this.joiners.set(userId, joiner);
      }
      const joined = joiner.take(part, this.deps.now(), session ?? "");
      if (joiner.waiting === 0)
        this.joiners.delete(userId);
      if ("waiting" in joined)
        return true;
      if ("refused" in joined) {
        this.refuse(joined.id, userId, session, joined.over === "frame" ? "too_large" : "unavailable", `${joined.refused} ${joinAdvice(joined.over, this.deps.identity.name)}`);
        return true;
      }
      try {
        raw = JSON.parse(joined.text);
      } catch {
        this.refuse(part.id, userId, session, "bad_request", "A frame sent in parts didn't read as JSON once put together.");
        return true;
      }
    }
    const notice = noticeOf2(raw);
    if (notice !== null) {
      const relay = session === undefined ? null : this.deps.relays.relayOf(userId, session);
      if (relay !== null)
        this.deps.live.deltas(userId, relay, notice.deltas);
      return true;
    }
    const read2 = requestOf(raw);
    if (read2 === null)
      return isLinkFrame(raw);
    if ("malformed" in read2) {
      if (read2.id !== null)
        this.refuse(read2.id, userId, session, "bad_request", read2.malformed);
      return true;
    }
    const request = read2.request;
    const at2 = this.deps.now();
    try {
      if (session === undefined)
        throw new LinkRefused("unavailable", "This Lumiverse doesn't say which connection a runtime's requests come from, so LumiAH can't answer them: update Lumiverse.");
      const body = await this.serve(request.type, request, userId, session);
      this.answer(request.id, userId, session, body, this.deps.now() - at2);
    } catch (error) {
      if (error instanceof LinkRefused)
        this.refuse(request.id, userId, session, error.code, error.message, this.deps.now() - at2);
      else {
        this.host.log("error", `[LumiAH] ${request.type} failed: ${wordsOf(error)}`);
        this.refuse(request.id, userId, session, "internal", `LumiAH couldn't do that (${wordsOf(error)}).`, this.deps.now() - at2);
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
    d.road.heard(userId, relay, session, r.secret);
    switch (type) {
      case "hello": {
        await d.relays.hello(caller, r);
        return { relay, version: LINK_VERSION, build: d.build, lost: d.streams.resume(userId, relay, openOf2(r.open)), settings: await d.settings.revision(userId), extension: offerOf(d.extension), backend: linkedBackend(d.identity), copy: await d.copy.offer(userId, relay), mirror: await d.mirror.hello(caller, r.mirror, r.report) };
      }
      case "ping": {
        await d.relays.ping(caller, r);
        d.copy.pinged(userId, relay);
        return { lost: d.streams.missing(userId, relay, strings3(r.streams)), told: d.copy.toldTo(userId, relay) };
      }
      case "models": {
        if (typeof r.key !== "string" || !await d.registry.keyIs(userId, r.key))
          throw wrongKey(d.identity.name);
        return { models: [{ id: loopbackModel(d.identity.identifier) }] };
      }
      case "turn.begin":
        return d.turns.begin(userId, relay, r.key, r.tag, r.request);
      case "turn.commit":
        return { anchoring: await d.turns.commit(userId, r.turn, r.chat, r.target, r.record) };
      case "stream.ack":
        return { done: d.streams.ack(userId, relay, streamId(r.stream), whole6(r.seq, "chunk number")) };
      case "stream.cancel":
        return { cancelled: d.streams.cancel(userId, relay, streamId(r.stream), typeof r.reason === "string" ? r.reason : "") };
      case "settings.get": {
        const snapshot = await d.settings.snapshot(userId);
        const kept = snapshot.definitions;
        return d.without.length > 0 ? { ...snapshot, definitions: { ...typeof kept === "object" && kept !== null && !Array.isArray(kept) ? kept : {}, without: [...d.without] } } : snapshot;
      }
      case "trace.push":
        return { taken: await d.live.push(userId, relay, Array.isArray(r.records) ? r.records : []) };
      case "setup.connection": {
        const made = isRecord2(r.connection) && typeof r.connection.id === "string" && typeof r.connection.name === "string" ? { id: r.connection.id, name: r.connection.name } : null;
        d.connectionMade(userId, text6(r.ref, "connection request"), made, typeof r.problem === "string" ? r.problem : null);
        return { taken: true };
      }
      case "blob.get":
        return { text: await d.storage.blob(userId, r.hash) };
      case "blob.put":
        await d.mirror.write(caller, r.mirror, { docs: [], blobs: [] }, () => d.storage.putBlob(userId, r.hash, r.text));
        return { stored: true };
      case "doc.get":
        return { doc: await d.storage.doc(userId, r.path) };
      case "doc.put":
        await d.mirror.write(caller, r.mirror, { docs: typeof r.path === "string" ? [r.path] : [], blobs: [] }, () => d.storage.putDoc(userId, r.path, r.doc));
        return { written: true };
      case "doc.remove":
        await d.mirror.write(caller, r.mirror, { docs: typeof r.path === "string" ? [r.path] : [], blobs: [] }, () => d.storage.removeDoc(userId, r.path));
        return { removed: true };
      case "chat.path":
        return { messages: await d.chats.path(userId, text6(r.chat, "chat")) };
      case "chat.messages":
        return { messages: await d.chats.messages(userId, text6(r.chat, "chat"), whole6(r.from, "range"), whole6(r.to, "range")) };
      case "chat.anchor": {
        if (r.record === undefined || r.record === null)
          throw new LinkRefused("bad_request", "The request has no record.");
        return { written: await d.chats.anchor(userId, text6(r.chat, "chat"), text6(r.message, "message"), whole6(r.swipe, "swipe"), r.record) };
      }
      case "lore.books":
        return { books: await d.lore.books(userId, await d.chats.own(userId, text6(r.chat, "chat"))) };
      case "lore.entries":
        return { entries: await d.lore.entries(userId, r.book) };
      case "lore.activated":
        return { entries: await d.turns.activated(userId, text6(r.chat, "chat"), text6(r.generation, "generation")) };
      case "preset.blocks": {
        const chat = typeof r.chat === "string" && r.chat !== "" ? (await d.chats.own(userId, r.chat)).id : null;
        return { blocks: await d.presets.blocks(userId, r.preset, chat) };
      }
      case "tools.list":
        return { tools: await d.tools.list(userId, typeof r.chat === "string" && r.chat !== "" ? (await d.chats.own(userId, r.chat)).id : "") };
      case "tool.call": {
        const stream = streamId(r.stream);
        const call = toolCallOf(r.call);
        if (call.chatId !== "")
          await d.chats.own(userId, call.chatId);
        const writer = d.streams.open(userId, relay, stream, call.turn, (await d.settings.transport(userId)).streams);
        if (writer !== null) {
          d.tools.call(userId, call, writer.signal).then((out) => writer.value(out.error === true ? { text: out.text, error: true } : { text: out.text }), (error) => writer.error(wordsOf(error), writer.signal.aborted ? "cancelled" : "tool_failed"));
        }
        return { accepted: true };
      }
      case "approval.ask": {
        const stream = streamId(r.stream);
        const ask = approvalAskOf(r.ask);
        if (ask.chatId !== "")
          await d.chats.own(userId, ask.chatId);
        const writer = d.streams.open(userId, relay, stream, ask.turn, (await d.settings.transport(userId)).streams);
        if (writer !== null) {
          holdCall(d, userId, ask, writer.signal).then((answer) => writer.value(answer), (error) => writer.error(wordsOf(error), "cancelled"));
        }
        return { accepted: true };
      }
      case "extension.call":
        return callExtension(d.extension, r.member, r.arg, userId, { own: (owner, chatId) => d.chats.own(owner, chatId), claimAsk: (owner, chatId) => d.chatSwitch.claimAsk(owner, chatId) });
      case "blob.list":
        return d.storage.blobs(userId, r.cursor);
      case "blob.remove":
        await d.mirror.write(caller, r.mirror, { docs: [], blobs: strings3(r.hashes) }, () => d.storage.removeBlobs(userId, r.hashes));
        return { removed: true };
      case "mirror.release":
        return { released: await d.mirror.release(caller, r.mirror) };
      case "doc.list":
        return { paths: await d.storage.docs(userId, r.prefix) };
      case "chat.info":
        return { chat: await d.chatSwitch.info(userId, text6(r.chat, "chat")) };
      case "chat.anchors":
        return d.chats.anchors(userId, typeof r.cursor === "string" && r.cursor !== "" ? r.cursor : null);
      case "job.changed":
        await d.jobs.took(userId, jobOf2(r.job), relay);
        return { taken: true };
      case "ask.answer":
        d.asks.answered(userId, relay, r.ask, r.value, r.refusal, r.took);
        return { taken: true };
      case "recall.lore.read":
      case "recall.lore.activated":
      case "recall.chat.messages":
      case "recall.embedder":
      case "recall.embed":
      case "recall.memory.enabled":
      case "recall.memory.search":
      case "recall.memory.entity":
      case "recall.memory.entities":
      case "recall.memory.arcs":
      case "recall.databanks.list":
      case "recall.databanks.documents":
      case "recall.databanks.content":
      case "recall.web.enabled":
      case "recall.web.search":
      case "book.read":
        return d.recall.serve(userId, type, r);
      case "host.read":
        return d.copy.read(userId, r.port, r.method, r.args);
      case "own.read":
        return d.copy.own(userId, r.chat);
      case "turn.lore":
        return d.copy.turnLore(userId, r.chat, r.character);
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
  async put(text7, kept = true) {
    const hash = await textHash(text7);
    const under = this.writing.get(hash);
    if (under) {
      await under;
      return hash;
    }
    const write = this.host.blobs.put(hash, text7);
    this.writing.set(hash, write);
    try {
      await write;
    } finally {
      this.writing.delete(hash);
    }
    if (kept)
      this.remember(hash, text7);
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
    const text7 = await this.host.blobs.get(hash);
    if (text7 === null)
      return null;
    if (await textHash(text7) !== hash) {
      this.host.log("warn", `the stored blob ${hash} doesn't match its hash, so it is read as missing`);
      return null;
    }
    this.remember(hash, text7);
    return text7;
  }
  async getJson(hash) {
    const text7 = await this.get(hash);
    return text7 === null ? undefined : parseJson(text7);
  }
  remember(hash, text7) {
    const limit2 = this.keep();
    const before = this.kept.get(hash);
    if (before !== undefined) {
      this.kept.delete(hash);
      this.chars -= before.length;
    }
    if (text7.length <= limit2) {
      this.kept.set(hash, text7);
      this.chars += text7.length;
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
function storedOf4(raw) {
  if (!isRecord(raw) || raw.v !== 1 || raw.kind !== "prompt" || !isRecord(raw.request) || !Array.isArray(raw.messages) || typeof raw.keep !== "number" || !Number.isSafeInteger(raw.keep) || raw.keep < 0)
    return null;
  if (raw.base !== null && !isHash(raw.base))
    return null;
  return raw;
}
async function readCallPrompt(blobs, hash) {
  const chain = [];
  for (let at2 = hash;at2 !== null; ) {
    if (!isHash(at2))
      return null;
    const text7 = await blobs.get(at2);
    if (text7 === null || await textHash(text7) !== at2)
      return null;
    const stored = storedOf4(parseJson(text7));
    if (!stored)
      return null;
    chain.push(stored);
    at2 = stored.keep > 0 ? stored.base : null;
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
function receiptOf(segment, sizes, texts) {
  const reply = String(segment.reply);
  const chars = sizes.receiptChars;
  const short3 = (text7) => text7.length <= chars ? text7 : texts.render(TEXT.session.receiptClipped, { text: text7.slice(0, cutAt(text7, chars)), chars: String(text7.length), reply });
  const named2 = (args, step) => {
    const json = JSON.stringify(args);
    return json.length <= sizes.receiptArgChars ? json : texts.render(TEXT.session.receiptArgsClipped, { text: json.slice(0, cutAt(json, sizes.receiptArgChars)), chars: String(json.length), reply, step: String(step) });
  };
  const lines = segment.steps.map((step, i) => {
    if (step.kind === "said")
      return texts.render(TEXT.session.receiptSaid, { text: short3(step.text) });
    if (step.kind === "call")
      return texts.render(step.error ? TEXT.session.receiptFailed : TEXT.session.receiptCall, { tool: step.name, args: named2(step.args, i + 1), result: short3(step.result) });
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
    { role: "assistant", content: receiptOf(turn.segment, input, texts) }
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
var isCount3 = (v2) => typeof v2 === "number" && Number.isSafeInteger(v2) && v2 >= 0;
function stepOf(raw) {
  if (!isRecord(raw))
    return null;
  if (raw.kind === "said" && typeof raw.text === "string")
    return { kind: "said", text: raw.text };
  if (raw.kind === "call" && typeof raw.name === "string" && isRecord(raw.args) && typeof raw.result === "string")
    return { kind: "call", name: raw.name, args: raw.args, result: raw.result, ...raw.error === true ? { error: true } : {} };
  if (raw.kind === "reply" && isCount3(raw.chars))
    return { kind: "reply", chars: raw.chars };
  if (raw.kind === "stop" && typeof raw.reason === "string")
    return { kind: "stop", reason: raw.reason };
  return null;
}
function segmentOf(raw) {
  if (!isRecord(raw) || raw.v !== 1 || raw.kind !== "segment" || !isCount3(raw.reply) || typeof raw.generationId !== "string" || !isTurnKind(raw.turn) || typeof raw.at !== "number" || !isRecord(raw.request) || !Array.isArray(raw.steps))
    return null;
  const { messages, last } = raw.request;
  return { v: 1, kind: "segment", reply: raw.reply, generationId: raw.generationId, turn: raw.turn, at: raw.at, request: { messages: isCount3(messages) ? messages : 0, last: isCount3(last) ? last : null }, steps: raw.steps.flatMap((s) => stepOf(s) ?? []) };
}
function usageOf(raw) {
  const out = emptyUsage();
  if (!isRecord(raw))
    return out;
  const n = (key3) => {
    const v2 = raw[key3];
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
var JOB_STATES2 = ["queued", "running", "done", "failed", "cancelled", "interrupted", "off_path", "spent", "paused"];
function recordJobOf(raw) {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.agent !== "string" || typeof raw.state !== "string" || !JOB_STATES2.includes(raw.state))
    return null;
  return { id: raw.id, agent: raw.agent, state: raw.state, ...isHash(raw.report) ? { report: raw.report } : {} };
}
function recordOf(anchor) {
  if (!isRecord(anchor) || anchor.v !== 1 || typeof anchor.generationId !== "string" || !isTurnKind(anchor.kind) || typeof anchor.at !== "number" || typeof anchor.path !== "string" || !isHash(anchor.segment))
    return null;
  const summary = isHash(anchor.summary) ? anchor.summary : undefined;
  const jobs = Array.isArray(anchor.jobs) ? anchor.jobs.flatMap((job) => recordJobOf(job) ?? []) : [];
  return {
    v: 1,
    generationId: anchor.generationId,
    kind: anchor.kind,
    ...typeof anchor.began === "number" ? { began: anchor.began } : {},
    ...typeof anchor.heard === "number" ? { heard: anchor.heard } : {},
    at: anchor.at,
    path: anchor.path,
    segment: anchor.segment,
    ...isHash(anchor.transcript) ? { transcript: anchor.transcript } : {},
    ...summary !== undefined ? { summary, kept: Array.isArray(anchor.kept) ? anchor.kept.filter(isHash) : [], folded: isCount3(anchor.folded) ? anchor.folded : 0 } : {},
    ...summary !== undefined && typeof anchor.rolledBack === "number" ? { rolledBack: anchor.rolledBack } : {},
    ...isHash(anchor.workspace) ? { workspace: anchor.workspace } : {},
    ...isCount3(anchor.changed) && anchor.changed > 0 ? { changed: anchor.changed } : {},
    ...jobs.length > 0 ? { jobs } : {},
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
  return path.flatMap((m, at2) => {
    const record2 = recordOf(m.anchor);
    return record2 ? [{ at: at2, index: m.index, messageId: m.id, swipeId: m.swipeId, record: record2, onPath: record2.path === before[at2] }] : [];
  });
}
function sessionAt(turns) {
  const segments = [];
  const dropped = [];
  let fresh = null;
  let rolledBack = null;
  let rolledBackAt = null;
  let rollbackFresh = false;
  let latest = 0;
  for (let i = turns.length - 1;i >= 0; i--) {
    const turn = turns[i];
    if (!turn.onPath) {
      dropped.unshift(turn.index);
      continue;
    }
    fresh ??= [...dropped];
    const { record: record2 } = turn;
    segments.unshift(record2.segment);
    latest = Math.max(latest, record2.at);
    if (record2.summary === undefined)
      continue;
    if (record2.rolledBack !== undefined) {
      if (rolledBack === null) {
        rolledBack = record2.summary;
        rolledBackAt = record2.rolledBack;
        rollbackFresh = latest <= record2.rolledBack;
      }
      continue;
    }
    return { summary: record2.summary, segments: [...record2.kept ?? [], ...segments], dropped, fresh, rolledBack, rolledBackAt, rollbackFresh };
  }
  return { summary: null, segments, dropped, fresh: fresh ?? [...dropped], rolledBack, rolledBackAt, rollbackFresh };
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
    const at2 = found < 0 ? path.length : found;
    const hashes = await pathHashes(path);
    const earlier = (await pathTurns(path, hashes)).filter((t) => t.at < at2);
    const walked = sessionAt(earlier);
    const target = path[at2];
    const shown = target ? recordOf(target.anchor) : null;
    const again = shown && shown.path === hashes[at2] ? shown : null;
    const held = again && again.summary !== undefined && again.rolledBack !== undefined ? { summary: again.summary, kept: again.kept ?? [], folded: again.folded ?? 0, rolledBack: again.rolledBack } : null;
    const refs = held && again ? { ...walked, rolledBack: held.summary, rolledBackAt: held.rolledBack, rollbackFresh: again.at <= held.rolledBack } : walked;
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
    const own = turn.kind === "continue" ? again : null;
    const before = own ? segmentOf(await this.blobs.getJson(own.segment)) : null;
    const continued = own && before ? { reply: before.reply, hash: own.segment, segment: before } : null;
    return { refs, summary, turns, missing, before: path.slice(0, at2), reply: target ? target.index : (path.at(-1)?.index ?? -1) + 1, path: hashes[at2] ?? ROOT_PATH, continued, records: earlier.filter((t) => t.onPath).map((t) => t.record), own, held };
  }
  segment(segment) {
    return this.blobs.putJson(segment);
  }
  async compact(summary, kept, folded) {
    return { summary: await this.blobs.put(summary), kept: kept.map((t) => t.hash), folded };
  }
}
async function rollback(host, chatId, messageId, swipeId) {
  const path = await host.chat.path(chatId);
  const message = path.find((m) => m.id === messageId);
  if (!message)
    return { refused: "That reply is no longer on the chat's active path." };
  if (message.swipeId !== swipeId)
    return { refused: "The chat shows another swipe of that reply now. Switch to the swipe whose summary you want to roll back, then try again." };
  const turns = await pathTurns(path);
  const turn = turns.find((t) => t.messageId === messageId);
  if (!turn)
    return { refused: "That reply has no record of LumiAH's." };
  const { record: record2 } = turn;
  if (record2.summary === undefined)
    return { refused: "No summary was made at that turn, so there is nothing to roll back." };
  if (record2.rolledBack !== undefined)
    return { refused: "That summary was already rolled back." };
  if (!turn.onPath)
    return { refused: "An earlier message of the chat changed since that turn, so its notes and its summary are no longer read: there is nothing to roll back." };
  const later = turns.find((t) => t.at > turn.at && t.onPath && t.record.summary !== undefined && t.record.rolledBack === undefined);
  if (later)
    return { refused: `A later summary, made at reply #${later.index}, stands over this one: the notes are read from that one on. Roll that one back first.` };
  const marked = { ...record2, rolledBack: host.clock.now() };
  if (!await host.chat.anchor(chatId, messageId, swipeId, marked))
    return { refused: "That reply is gone, so its record couldn't be written." };
  return { record: marked };
}
async function compactionAsked(host, chatId) {
  const doc = await host.store.read(DOC.session(chatId));
  return isRecord(doc) && doc.v === 1 && doc.kind === "session" && typeof doc.compactAsked === "number" ? doc.compactAsked : null;
}
function compactionDue(input) {
  let last = input.rolledBackAt ?? 0;
  for (const record2 of input.records)
    if (record2.summary !== undefined)
      last = Math.max(last, record2.rolledBack ?? record2.at);
  if (input.asked !== null && input.asked > last)
    return "due";
  if (input.tokens <= input.limit)
    return "no";
  if (input.rolledBackAt !== null && input.tokens <= input.tokensAtRollback + input.margin)
    return "held";
  return "due";
}

// src/core/transcript.ts
function transcriptOf(text7) {
  const raw = parseJson(text7);
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
  const { record: record2 } = turn;
  if (record2.summary === undefined)
    return "none";
  if (record2.rolledBack !== undefined)
    return turns.some((t) => t.onPath && t.record.at > (record2.rolledBack ?? 0)) ? "done" : "pending";
  return turn.onPath && record2.summary === standing ? "available" : "none";
}
function latestRecord(path, turn) {
  for (let at2 = path.length - 1;at2 >= 0; at2--) {
    const message = path[at2];
    const record2 = message === undefined ? null : recordOf(message.anchor);
    if (message !== undefined && record2 !== null && (turn === null || record2.generationId === turn))
      return { message, record: record2 };
  }
  return null;
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
      anchor: (chatId, messageId, swipeId, record2) => chats.anchor(userId, chatId, messageId, swipeId, record2)
    };
  }
  async caughtUp(userId, chatId) {
    const waitMs = (await this.deps.settings.transport(userId)).pages.settleMs;
    const { promise, resolve } = Promise.withResolvers();
    const cancel = this.deps.later(waitMs, () => resolve(`Your runtime didn't say within ${Math.round(waitMs / 100) / 10} s that it had sent ${this.deps.name} everything it saved.`));
    this.deps.settle(userId, chatId).then(() => resolve(null), (error) => resolve(wordsOf(error))).finally(cancel);
    return promise;
  }
  async text(userId, hash) {
    const text7 = await this.deps.storage.blob(userId, hash);
    if (text7 !== null)
      return { text: text7, behind: null };
    const behind = await this.caughtUp(userId, null);
    return { text: await this.deps.storage.blob(userId, hash), behind };
  }
  async session(userId, chatId, path) {
    const { storage, settings } = this.deps;
    const why = await this.caughtUp(userId, chatId);
    const behind = why === null ? null : `${why} This shows what ${this.deps.name}'s storage holds, which may lack the newest. Look again in a moment.`;
    const snapshot = await settings.snapshot(userId);
    const core = settingsOf(snapshot.values.core);
    const blobs = new Blobs({ blobs: { get: (hash) => storage.blob(userId, hash), put: async () => {
      return;
    } }, log: () => {
      return;
    } }, () => 0);
    const resumed = await new Sessions({ chat: { ...this.chatPort(userId), path: async () => path } }, blobs).resume({ chatId: "", target: { messageId: null, swipeId: 0 }, kind: "new" });
    const sizes = { receiptChars: core.session.receiptChars, receiptArgChars: core.session.receiptArgChars, charsPerToken: core.loop.charsPerToken, texts: textsOf(snapshot.texts) };
    const { tokens } = carriedOf({ summary: resumed.summary, turns: resumed.turns }, sizes);
    const { rolledBackAt } = resumed.refs;
    const asked = await compactionAsked({ store: { read: (doc) => storage.doc(userId, doc), write: async () => {
      return;
    }, remove: async () => {
      return;
    } } }, chatId);
    const standing = {
      asked,
      records: resumed.records,
      rolledBackAt,
      tokensAtRollback: rolledBackAt === null ? 0 : carriedOf({ summary: resumed.summary, turns: resumed.turns.filter((t) => t.segment.at <= rolledBackAt) }, sizes).tokens,
      margin: core.session.rollbackMarginTokens
    };
    return {
      turns: resumed.turns.length,
      tokens,
      summary: resumed.summary !== null,
      dropped: resumed.refs.dropped.length,
      missing: resumed.missing,
      asked: compactionDue({ ...standing, tokens: 0, limit: 0 }) === "due" ? asked : null,
      held: compactionDue({ ...standing, tokens, limit: limitOf(core.session.summarizeAtTokens) }) === "held",
      ...behind !== null ? { behind } : {}
    };
  }
  async view(userId, chatId) {
    return this.session(userId, chatId, await this.deps.chats.path(userId, chatId));
  }
  row(turn, turns, standing, preview) {
    const { record: record2 } = turn;
    return {
      turn: record2.generationId,
      messageId: turn.messageId,
      index: turn.index,
      swipe: turn.swipeId,
      at: record2.at,
      kind: record2.kind,
      onPath: turn.onPath,
      preview,
      transcript: record2.transcript ?? null,
      compaction: record2.summary !== undefined ? { summary: record2.summary, replaced: record2.folded ?? 0, rollback: rollbackState(turn, turns, standing) } : null,
      usage: record2.usage,
      changes: record2.changed ?? 0
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
      const text7 = m.content.replace(/\s+/g, " ").trim();
      out.set(m.index, text7.length > chars ? `${text7.slice(0, chars).trimEnd()}\u2026` : text7);
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
      session: await this.session(userId, chatId, path)
    };
  }
  async stored(userId, hash) {
    const { text: text7, behind } = await this.text(userId, hashOf(hash, "A transcript"));
    return { transcript: text7 === null ? null : transcriptOf(text7), behind };
  }
  missing(what, behind) {
    return new UiRefused("not_found", behind === null ? `${what} is no longer stored.` : `${what} isn't in ${this.deps.name}'s storage yet. ${behind} Look again in a moment.`);
  }
  async transcript(userId, hash, from) {
    const { transcript: stored, behind } = await this.stored(userId, hash);
    if (stored === null)
      throw this.missing("That turn's transcript", behind);
    const size = (await this.deps.settings.transport(userId)).live.page;
    const events = stored.events.slice(from - 1, from - 1 + size);
    const read2 = from - 1 + events.length;
    const { ended } = stored;
    return {
      view: {
        stream: stored.chatId,
        chatId: stored.chatId === "" ? null : stored.chatId,
        turn: stored.turn,
        kind: stored.generation,
        messageId: stored.messageId,
        startedAt: stored.startedAt,
        ended: { state: ended.status, at: ended.at, ...ended.reason !== undefined ? { reason: ended.reason } : {} },
        events,
        partials: []
      },
      next: stored.events.length > read2 ? read2 + 1 : null
    };
  }
  async last(userId, chatId, live) {
    if (live !== null && isReply(live.kind)) {
      const kept2 = live.ended === null ? null : latestRecord(await this.deps.chats.path(userId, chatId), live.turn);
      return lastOfLive(live, live.kind, kept2 === null ? null : { messageId: kept2.message.id, transcript: kept2.record.transcript ?? null });
    }
    const kept = latestRecord(await this.deps.chats.path(userId, chatId), null);
    if (kept === null)
      return null;
    const stored = kept.record.transcript === undefined ? null : (await this.stored(userId, kept.record.transcript)).transcript;
    return lastOfRecord({ messageId: kept.message.id, record: kept.record }, stored);
  }
  async prompt(userId, hash) {
    let behind = null;
    const get = async (h) => {
      const read2 = await this.text(userId, h);
      behind ??= read2.behind;
      return read2.text;
    };
    const prompt = await readCallPrompt({ get }, hashOf(hash, "A call's prompt"));
    if (prompt === null)
      throw this.missing("That call's prompt", behind);
    return prompt;
  }
  async blob(userId, hash) {
    const { text: text7, behind } = await this.text(userId, hashOf(hash, "A stored text"));
    if (text7 === null)
      throw this.missing("That text", behind);
    return text7;
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
    return { turn: this.row(turn, turns, sessionAt(turns).summary, previews.get(turn.index) ?? ""), session: await this.session(userId, chatId, path) };
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
var FILE4 = "settings.json";
var FORBIDDEN_KEYS = Object.assign(Object.create(null), { __proto__: true, constructor: true, prototype: true });
var isPath2 = (v2) => Array.isArray(v2) && v2.every((k) => typeof k === "string");
function capped(schema, value) {
  if (!isRecord2(schema))
    return value;
  if (typeof value === "number")
    return typeof schema.maximum === "number" && value > schema.maximum ? schema.maximum : value;
  if (!isRecord2(value) || !isRecord2(schema.properties))
    return value;
  for (const [key3, child] of Object.entries(schema.properties))
    if (hasOwn2(value, key3))
      value[key3] = capped(child, value[key3]);
  return value;
}
function unretired(path, value, retired) {
  for (const gone of retired) {
    if (within2(path, gone))
      return;
    if (!within2(gone, path))
      continue;
    const parent = at2(value, gone.slice(path.length, -1));
    if (isRecord2(parent))
      delete parent[gone.at(-1) ?? ""];
  }
  return value;
}
function storedOf5(raw, schema, retired) {
  if (!isRecord2(raw) || raw.v !== 1)
    return null;
  const own = [];
  if (Array.isArray(raw.own))
    for (const o of raw.own) {
      if (!isRecord2(o) || !isPath2(o.path) || o.path.length === 0 || o.value === undefined)
        continue;
      const value = unretired(o.path, o.value, retired);
      if (value === undefined)
        continue;
      let rule = schema;
      for (const key3 of o.path)
        rule = isRecord2(rule) && isRecord2(rule.properties) && hasOwn2(rule.properties, key3) ? rule.properties[key3] : undefined;
      own.push({ path: o.path, value: capped(rule, value) });
    }
  const texts = {};
  if (isRecord2(raw.texts)) {
    for (const [id2, text7] of Object.entries(raw.texts))
      if (typeof text7 === "string")
        texts[id2] = text7;
  }
  return { v: 1, rev: typeof raw.rev === "number" && Number.isSafeInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0, own, texts, ...isRecord2(raw.definitions) ? { definitions: raw.definitions } : {} };
}
var clone2 = (value) => JSON.parse(JSON.stringify(value));
var within2 = (path, under) => under.length <= path.length && under.every((key3, i) => path[i] === key3);
function at2(root, path) {
  let node = root;
  for (const key3 of path) {
    if (!isRecord2(node) || !hasOwn2(node, key3))
      return;
    node = node[key3];
  }
  return node;
}
function put(root, path, value) {
  let node = root;
  for (const key3 of path.slice(0, -1)) {
    const next = node[key3];
    if (!isRecord2(next))
      node[key3] = {};
    node = node[key3];
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
    this.docs = new UserDocs(host, FILE4, (raw) => storedOf5(raw, this.schema(), this.sections.flatMap((section) => (section.retired ?? []).map((path) => [section.key, ...path]))), () => ({ v: 1, rev: 0, own: [], texts: {} }));
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
    const stored = await this.docs.get(userId);
    const values = {};
    for (const o of [...stored.own].sort((a, b) => a.path.length - b.path.length))
      put(values, o.path, clone2(o.value));
    return { revision: stored.rev, values, texts: { ...stored.texts }, definitions: clone2(stored.definitions ?? {}) };
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
      const bad = path.find((key3) => hasOwn2(FORBIDDEN_KEYS, key3) || key3 === "");
      if (bad !== undefined)
        return { path: [...path], message: `"${bad}" can't name a setting.` };
      const section = path[0];
      if (section !== undefined && !this.sections.some((s) => s.key === section))
        return { path: [...path], message: `There is no settings section "${section}".` };
      return null;
    };
    const place = (path, value) => {
      const above = own.find((o) => o.path.length < path.length && within2(path, o.path));
      own = own.filter((o) => !within2(o.path, path));
      if (above !== undefined) {
        const rest = path.slice(above.path.length);
        if (!isRecord2(above.value))
          above.value = {};
        put(above.value, rest, value ?? at2(defaults, path));
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
    for (const section of this.sections) {
      for (const tail of await section.fixed?.(userId) ?? []) {
        const fixed = [section.key, ...tail];
        own = own.filter((o) => !within2(o.path, fixed));
        for (const o of own) {
          if (!within2(fixed, o.path))
            continue;
          const parent = at2(o.value, fixed.slice(o.path.length, -1));
          if (isRecord2(parent))
            delete parent[fixed.at(-1) ?? ""];
        }
      }
    }
    const values = this.valuesOf(own);
    for (const section of this.sections)
      for (const p of await section.check(values[section.key], userId))
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
  async text(userId, id2, text7) {
    if (!this.textsDef.defs.some((d) => d.id === id2))
      throw new SettingsRefused(`There is no text "${id2}".`, [{ path: [id2], message: "There is no such text." }]);
    if (text7 !== null) {
      const refused2 = this.textsDef.check(id2, text7);
      if (refused2 !== null)
        throw new SettingsRefused(refused2, [{ path: [id2], message: refused2 }]);
    }
    const revision = await this.docs.change(userId, (doc) => {
      if (text7 === null)
        delete doc.texts[id2];
      else
        doc.texts[id2] = text7;
      return ++doc.rev;
    });
    for (const listener of this.listeners)
      listener(userId, revision);
    return this.texts(userId);
  }
  async definitions(userId) {
    return clone2((await this.docs.get(userId)).definitions ?? {});
  }
  async setDefinitions(userId, definitions) {
    const kept = clone2(definitions);
    const revision = await this.docs.change(userId, (doc) => {
      doc.definitions = kept;
      return ++doc.rev;
    });
    for (const listener of this.listeners)
      listener(userId, revision);
  }
  settle() {
    return this.docs.settle();
  }
}

// src/link/stream.ts
class StreamSender {
  held = null;
  finished = false;
  push(chunk) {
    if (this.finished)
      return null;
    this.finished = true;
    this.held = chunk;
    return { seq: 1, chunk };
  }
  from(from) {
    return this.held !== null && from <= 1 ? [{ seq: 1, chunk: this.held }] : [];
  }
  ack(seq) {
    if (!this.finished || seq < 1)
      return false;
    this.held = null;
    return true;
  }
}

// src/extension/backend/streams.ts
var key3 = (userId, stream) => `${userId}\x00${stream}`;

class StreamRegistry {
  env;
  streams = new Map;
  held = new Map;
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
  end(sent, chunk) {
    if (sent.endedAt !== null || this.streams.get(key3(sent.userId, sent.stream)) !== sent)
      return;
    this.emit(sent, chunk);
    sent.endedAt = this.env.now();
  }
  open(userId, relay, stream, turn, tuning) {
    const k = key3(userId, stream);
    if (this.streams.has(k))
      return null;
    const own = this.held.get(userId) ?? 0;
    if (own >= CEILINGS.streams)
      throw new LinkRefused("unavailable", `This account already has ${own} calls on LumiAH's link that are under way or whose answers its runtimes haven't acknowledged, the most one account may have at once. Try again once some have ended.`);
    if (this.streams.size >= CEILINGS.streamsTotal)
      throw new LinkRefused("unavailable", "LumiAH is busy: its link holds as many calls' answers as it does at once, for every account together. Try again in a moment.");
    const sent = { userId, relay, stream, turn, sender: new StreamSender, abort: new AbortController, keepMs: Math.min(tuning.keepMs, CEILINGS.streamKeepMs), endedAt: null };
    this.streams.set(k, sent);
    this.held.set(userId, own + 1);
    return {
      signal: sent.abort.signal,
      value: (value) => this.end(sent, { kind: "value", value }),
      error: (message, code) => this.end(sent, { kind: "error", message, code })
    };
  }
  of(userId, relay, stream) {
    const sent = this.streams.get(key3(userId, stream));
    return sent !== undefined && sent.relay === relay ? sent : null;
  }
  drop(sent) {
    if (!this.streams.delete(key3(sent.userId, sent.stream)))
      return;
    const left = (this.held.get(sent.userId) ?? 1) - 1;
    if (left > 0)
      this.held.set(sent.userId, left);
    else
      this.held.delete(sent.userId);
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
    const named2 = new Set;
    for (const { stream, seq } of open) {
      named2.add(stream);
      const sent = this.of(userId, relay, stream);
      if (sent === null)
        lost.push(stream);
      else
        for (const n of sent.sender.from(seq + 1))
          this.env.push(userId, relay, { link: LINK, type: "chunk", stream, seq: n.seq, chunk: n.chunk });
    }
    for (const sent of [...this.streams.values()]) {
      if (sent.userId !== userId || sent.relay !== relay || named2.has(sent.stream))
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
var MARK = "lumiah_chat_";
function storedOf6(raw) {
  if (!isRecord2(raw) || raw.v !== 1 || !isRecord2(raw.on))
    return null;
  const on = {};
  for (const [chatId, s] of Object.entries(raw.on)) {
    if (!isRecord2(s) || typeof s.since !== "number")
      continue;
    on[chatId] = { since: s.since, prior: typeof s.prior === "string" ? s.prior : null, priorModel: s.priorModel === undefined ? null : s.priorModel };
  }
  const story = {};
  if (isRecord2(raw.story)) {
    for (const [chatId, chosen] of Object.entries(raw.story)) {
      const word2 = storyWordOf(chosen);
      if (Object.keys(word2).length > 0)
        story[chatId] = word2;
    }
  }
  return { v: 1, on, story };
}

class ChatSwitch {
  host;
  deps;
  docs;
  markKey;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
    this.docs = new UserDocs(host, "chats.json", storedOf6, () => ({ v: 1, on: {}, story: {} }));
    this.markKey = `${MARK}${deps.identity.identifier}`;
  }
  marks(chat) {
    const out = [];
    for (const [key4, mark] of Object.entries(chat.metadata)) {
      if (!key4.startsWith(MARK) || key4 === this.markKey)
        continue;
      if (!isRecord2(mark) || mark.chat !== chat.id)
        continue;
      const identifier = key4.slice(MARK.length);
      out.push({ key: key4, identifier, name: typeof mark.name === "string" && mark.name !== "" ? mark.name : identifier, prior: typeof mark.prior === "string" && mark.prior !== "" ? mark.prior : null, priorModel: mark.priorModel === undefined ? null : mark.priorModel });
    }
    return out;
  }
  other(chat, connection) {
    const [marked] = this.marks(chat);
    if (marked !== undefined)
      return { identifier: marked.identifier, name: marked.name };
    return connection !== null && connection.foreign !== null ? { identifier: connection.foreign, name: connection.name } : null;
  }
  async takeFrom(userId, chat, connection, loops) {
    const marks = this.marks(chat);
    const patch = {};
    for (const mark of marks)
      patch[mark.key] = null;
    if (connection === null || connection.foreign === null)
      return patch;
    if (chat.metadata[PIN] !== connection.id)
      throw new UiRefused("unavailable", `This chat generates on "${connection.name}" because that is the connection selected in Lumiverse, and its replies go to that connection's own runtime. Select another connection in Lumiverse, then take the chat over.`);
    const said2 = marks.find((mark) => mark.prior !== null);
    const prior = said2?.prior ?? null;
    const back = prior !== null && prior !== connection.id && !loops.includes(prior) && await this.deps.connections.one(userId, prior) !== null ? prior : null;
    patch[PIN] = back;
    patch[PIN_MODEL] = back !== null ? said2?.priorModel ?? null : null;
    return patch;
  }
  async viewOf(userId, chat) {
    const connection = await this.deps.connections.ofChat(userId, chat);
    const switched = (await this.docs.get(userId)).on[chat.id];
    const other = this.other(chat, connection);
    const pinned = connection?.loopback === true && chat.metadata[PIN] === connection.id;
    const on = other === null && switched !== undefined && pinned;
    const runtime = on ? await this.deps.runtimeOf(userId, chat.id) : null;
    const away = on && runtime === null;
    return { chatId: chat.id, name: chat.name === "" ? null : chat.name, on, since: on ? switched.since : null, connection: connection === null ? null : { id: connection.id, name: connection.name, loopback: connection.loopback }, ...other !== null ? { other } : {}, ...runtime !== null ? { runtime } : {}, ...away ? { away: true } : {} };
  }
  async view(userId, chatId) {
    return this.viewOf(userId, await this.deps.chats.own(userId, chatId));
  }
  async storyChoice(userId, chatId) {
    const chosen = (await this.docs.get(userId)).story[chatId];
    return chosen === undefined ? {} : { ...chosen };
  }
  async info(userId, chatId) {
    const info = await this.deps.chats.info(userId, chatId);
    if (info === null)
      return null;
    const [chosen, sovereignHand] = await Promise.all([this.storyChoice(userId, chatId), this.host.chats.sovereignHand(chatId, userId)]);
    return { ...info, ...Object.keys(chosen).length > 0 ? { story: chosen } : {}, sovereignHand };
  }
  async claimAsk(userId, chatId, setting) {
    const chat = await this.info(userId, chatId);
    if (chat === null)
      return null;
    const sovereignHand = chat.sovereignHand ?? null;
    const below = storyHolds({ chat: chat.story ?? null, user: setting ?? await this.deps.storySetting(userId), sovereignHand });
    return { userId, chatId: chat.id, chat, story: below.source, sovereignHand };
  }
  async story(userId, chatId) {
    await this.deps.chats.own(userId, chatId);
    const setting = await this.deps.storySetting(userId);
    const ask = await this.claimAsk(userId, chatId, setting);
    if (ask === null)
      throw new LinkRefused("not_found", "There is no such chat in this account.");
    const chosen = ask.chat.story ?? {};
    const answered = this.deps.claim === undefined ? null : await this.deps.claim(ask, userId);
    const said2 = answered !== null && "claim" in answered ? answered : null;
    const word2 = storyWordOf(said2?.claim.story);
    const claimed = said2 !== null && Object.keys(word2).length > 0 ? { by: said2.by, story: word2 } : null;
    return { chatId, chosen, setting, claimed, sovereignHand: ask.sovereignHand, holds: storyHolds({ claim: claimed?.story ?? null, chat: chosen, user: setting, sovereignHand: ask.sovereignHand }) };
  }
  async lead(userId, chatId) {
    await this.deps.chats.own(userId, chatId);
    if (this.deps.claim === undefined)
      return null;
    const ask = await this.claimAsk(userId, chatId);
    if (ask === null)
      throw new LinkRefused("not_found", "There is no such chat in this account.");
    const said2 = await this.deps.claim(ask, userId);
    if (said2 === null)
      return null;
    if ("failed" in said2)
      return { by: said2.by, unanswered: said2.failed };
    const { mainAgent, reply } = said2.claim;
    return { by: said2.by, lead: typeof mainAgent === "string" && mainAgent !== "" ? mainAgent : null, released: reply === "released" };
  }
  async setStory(userId, chatId, story) {
    await this.deps.chats.own(userId, chatId);
    const chosen = storyWordOf(story);
    await this.docs.change(userId, (doc) => {
      if (Object.keys(chosen).length === 0)
        delete doc.story[chatId];
      else
        doc.story[chatId] = chosen;
    });
    return this.story(userId, chatId);
  }
  unpin(chat, switched, loops) {
    const pin = typeof chat.metadata[PIN] === "string" ? chat.metadata[PIN] : null;
    if (pin === null || !loops.includes(pin))
      return {};
    const prior = switched?.prior ?? null;
    const back = prior !== null && !loops.includes(prior) ? prior : null;
    return { [PIN]: back, [PIN_MODEL]: back !== null ? switched?.priorModel ?? null : null };
  }
  async set(userId, chatId, on, takeover = false) {
    const { chats, connections, identity } = this.deps;
    const chat = await chats.own(userId, chatId);
    const doc = await this.docs.get(userId);
    const switched = doc.on[chatId];
    const loops = (await connections.loopbacks(userId)).map((c) => c.id);
    const pin = typeof chat.metadata[PIN] === "string" ? chat.metadata[PIN] : null;
    const pinnedLoop = pin !== null && loops.includes(pin);
    if (!on) {
      const patch = { ...this.unpin(chat, switched, loops), ...chat.metadata[this.markKey] !== undefined ? { [this.markKey]: null } : {} };
      if (Object.keys(patch).length > 0)
        await this.host.chats.patchMetadata(chatId, patch, userId);
      if (switched !== undefined) {
        await this.docs.change(userId, (d) => {
          delete d.on[chatId];
        });
      }
      return this.viewOf(userId, await chats.own(userId, chatId));
    }
    const blocked = this.deps.blocked();
    if (blocked !== null)
      throw new UiRefused("unavailable", blocked);
    const connection = await connections.ofChat(userId, chat);
    const other = this.other(chat, connection);
    if (other !== null && !takeover)
      throw new UiRefused("unavailable", `${other.name} answers this chat. Switch it off there first: two harnesses would both work on each of its replies. Or take the chat over here, which takes it from ${other.name}.`);
    const loop = loops[0];
    if (loop === undefined)
      throw new UiRefused("unavailable", `There is no runtime to answer this chat yet. Start one with its line on ${identity.name}'s Runtime page and mint its key there, then switch the chat on.`);
    const taken = other !== null ? await this.takeFrom(userId, chat, connection, loops) : {};
    const pinBefore = PIN in taken ? typeof taken[PIN] === "string" ? taken[PIN] : null : pin;
    const modelBefore = PIN in taken ? taken[PIN_MODEL] ?? null : chat.metadata[PIN_MODEL] ?? null;
    const prior = pinnedLoop ? switched?.prior ?? null : pinBefore;
    const priorModel = pinnedLoop ? switched?.priorModel ?? null : modelBefore;
    const since = switched?.since ?? this.deps.now();
    const mark = { v: 1, chat: chatId, name: identity.name, since, ...prior !== null ? { prior, priorModel } : {} };
    await this.host.chats.patchMetadata(chatId, { ...taken, ...pinnedLoop ? {} : { [PIN]: loop, [PIN_MODEL]: null }, [this.markKey]: mark }, userId);
    if (switched === undefined || !pinnedLoop) {
      await this.docs.change(userId, (d) => {
        d.on[chatId] = { since, prior, priorModel };
      });
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
        for (const chatId of gone) {
          delete doc.on[chatId];
          delete doc.story[chatId];
        }
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
var KINDS3 = { normal: "new", regenerate: "regenerate", swipe: "swipe", continue: "continue" };
var TAGGED_TYPES = ["normal", "regenerate", "swipe", "continue"];
function cutoff(messages, history) {
  if (history.keep === "all")
    return [];
  const places = messages.flatMap((m, i) => m.history ? [i] : []);
  return places.slice(0, Math.max(0, places.length - history.count));
}
var waitWords = (ms2) => ms2 >= 1000 ? `${Math.round(ms2 / 1000)} s` : `${ms2} ms`;

class Turns {
  host;
  deps;
  accounts = new Map;
  home = new Map;
  unowned = new Map;
  unownedLatest = new Map;
  swipesDeleted = 0;
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
  turn(id2) {
    return this.home.get(id2)?.byTurn.get(id2);
  }
  ofChat(userId, chatId) {
    return this.accounts.get(userId)?.byChat.get(chatId);
  }
  of(userId) {
    let account = this.accounts.get(userId);
    if (account === undefined) {
      const { checkMs, known, held } = TRANSPORT_DEFAULTS.tags;
      account = { userId, mine: new Map, checkMs, known, held, generations: new Map, latest: new Map, byTag: new Map, byTurn: new Map, byChat: new Map, pending: new Map };
      this.accounts.set(userId, account);
    }
    return account;
  }
  generation(id2) {
    return this.home.get(id2)?.generations.get(id2) ?? this.unowned.get(id2);
  }
  let(account, id2) {
    if (this.home.get(id2) === account && !account.generations.has(id2) && !account.byTurn.has(id2) && !account.pending.has(id2))
      this.home.delete(id2);
  }
  keep(account, generation) {
    account.generations.set(generation.id, generation);
    this.home.set(generation.id, account);
  }
  dropGeneration(account, id2) {
    const generation = account.generations.get(id2);
    if (generation === undefined)
      return;
    account.generations.delete(id2);
    if (account.latest.get(generation.chatId) === id2)
      account.latest.delete(generation.chatId);
    this.let(account, id2);
  }
  adopt(account, generation) {
    this.unowned.delete(generation.id);
    if (this.unownedLatest.get(generation.chatId) === generation.id)
      this.unownedLatest.delete(generation.chatId);
    generation.userId = account.userId;
    this.keep(account, generation);
    account.latest.set(generation.chatId, generation.id);
  }
  forget(account, turn) {
    account.byTag.delete(turn.tag);
    if (account.byTurn.get(turn.turn) === turn)
      account.byTurn.delete(turn.turn);
    if (account.byChat.get(turn.chatId) === turn)
      account.byChat.delete(turn.chatId);
    this.let(account, turn.turn);
  }
  trim(account) {
    while (account.byTag.size > account.held) {
      const oldest = account.byTag.values().next().value;
      if (oldest === undefined)
        break;
      this.forget(account, oldest);
    }
    while (account.generations.size > account.held * 2) {
      const oldest = account.generations.keys().next().value;
      if (oldest === undefined)
        break;
      this.dropGeneration(account, oldest);
    }
  }
  shed(most, count2, drop) {
    let total = 0;
    for (const account of this.accounts.values())
      total += count2(account);
    while (total > most) {
      let largest;
      for (const account of this.accounts.values())
        if (largest === undefined || count2(account) > count2(largest))
          largest = account;
      if (largest === undefined || count2(largest) === 0)
        return;
      drop(largest);
      total--;
    }
  }
  bound() {
    this.shed(CEILINGS.turnsTotal, (a) => a.byTag.size, (a) => {
      const oldest = a.byTag.values().next().value;
      if (oldest !== undefined)
        this.forget(a, oldest);
    });
    this.shed(CEILINGS.turnsTotal * 2, (a) => a.generations.size, (a) => this.dropGeneration(a, a.generations.keys().next().value ?? ""));
    this.shed(CEILINGS.verdictsTotal, (a) => a.mine.size, (a) => void a.mine.delete(a.mine.keys().next().value ?? ""));
    this.shed(CEILINGS.recordsTotal, (a) => a.pending.size, (a) => this.early(a));
    while (this.unowned.size > CEILINGS.generationsUnowned) {
      const oldest = this.unowned.values().next().value;
      if (oldest === undefined)
        break;
      this.unowned.delete(oldest.id);
      if (this.unownedLatest.get(oldest.chatId) === oldest.id)
        this.unownedLatest.delete(oldest.chatId);
    }
  }
  early(account) {
    const oldest = account.pending.values().next().value;
    if (oldest === undefined)
      return;
    account.pending.delete(oldest.turn);
    this.let(account, oldest.turn);
    this.write(oldest, null);
  }
  started(event) {
    const held = this.generation(event.generationId);
    if (held !== undefined) {
      held.targetMessageId = event.targetMessageId ?? held.targetMessageId;
      held.targetSwipeId = event.targetSwipeId ?? held.targetSwipeId;
      if (held.userId === null && event.userId !== null)
        this.adopt(this.of(event.userId), held);
      return;
    }
    const generation = { id: event.generationId, chatId: event.chatId, userId: event.userId, type: event.type, targetMessageId: event.targetMessageId, targetSwipeId: event.targetSwipeId, at: this.deps.now(), ended: null, stopped: false };
    if (event.userId === null) {
      this.unowned.set(generation.id, generation);
      this.unownedLatest.set(generation.chatId, generation.id);
    } else {
      const account = this.of(event.userId);
      this.keep(account, generation);
      account.latest.set(generation.chatId, generation.id);
      this.trim(account);
    }
    this.bound();
  }
  ended(event) {
    const generation = this.generation(event.generationId);
    const ended = { messageId: event.messageId, at: this.deps.now() };
    if (generation !== undefined)
      generation.ended = ended;
    else {
      const made = { id: event.generationId, chatId: event.chatId, userId: event.userId, type: "other", targetMessageId: null, targetSwipeId: null, at: ended.at, ended, stopped: false };
      if (event.userId === null)
        this.unowned.set(made.id, made);
      else
        this.keep(this.of(event.userId), made);
      this.bound();
    }
    this.handed(event.generationId, event.messageId);
    this.clear(event.generationId, event.messageId);
    for (const listener of this.over)
      listener(event.generationId, event.chatId);
  }
  stoppedBy(event) {
    const generation = this.generation(event.generationId);
    if (generation !== undefined)
      generation.stopped = true;
    const turn = this.turn(event.generationId);
    if (turn !== undefined)
      for (const listener of this.stopped)
        listener(turn, "You stopped the reply in Lumiverse.");
    this.handed(event.generationId, null);
    this.clear(event.generationId, null);
    for (const listener of this.over)
      listener(event.generationId, event.chatId);
  }
  handed(generationId, saved) {
    const account = this.home.get(generationId);
    const pending = account?.pending.get(generationId);
    if (account === undefined || pending === undefined)
      return;
    account.pending.delete(generationId);
    this.let(account, generationId);
    this.write(pending, saved);
  }
  stoppedFromLive(userId, turnId) {
    const turn = this.accounts.get(userId)?.byTurn.get(turnId);
    if (turn !== undefined)
      turn.stoppedHere = true;
  }
  swipeDeleted(chatId, messageId, deleted) {
    this.swipesDeleted++;
    const moved = (generation) => {
      if (generation.chatId !== chatId || generation.targetMessageId !== messageId || generation.targetSwipeId === null || generation.targetGone)
        return;
      if (generation.targetSwipeId > deleted)
        generation.targetSwipeId--;
      else if (generation.targetSwipeId === deleted)
        generation.targetGone = true;
    };
    for (const generation of this.unowned.values())
      moved(generation);
    for (const account of this.accounts.values()) {
      for (const generation of account.generations.values())
        moved(generation);
      const targets = new Set;
      for (const turn of account.byTurn.values())
        if (turn.chatId === chatId && turn.target !== null)
          targets.add(turn.target);
      for (const pending of account.pending.values())
        if (pending.chatId === chatId)
          targets.add(pending.target);
      for (const target of targets) {
        if (target.message !== messageId || target.gone)
          continue;
        if (target.swipe > deleted)
          target.swipe--;
        else if (target.swipe === deleted)
          target.gone = true;
      }
      for (const pending of [...account.pending.values()]) {
        if (pending.chatId !== chatId || !pending.target.gone)
          continue;
        account.pending.delete(pending.turn);
        this.let(account, pending.turn);
        this.host.log("warn", `[LumiAH] turn ${pending.turn.slice(0, 8)}: the swipe its reply was written on was deleted, so its record wasn't written`);
      }
    }
  }
  async clear(generationId, saved) {
    const turn = this.turn(generationId);
    if (turn === undefined || !turn.stoppedHere || turn.kind !== "new" || !this.host.granted("chat_mutation"))
      return;
    try {
      const messageId = saved ?? (await turn.facts)?.target.message ?? null;
      if (messageId !== null)
        await this.deps.chats.deleteEmpty(turn.userId, turn.chatId, messageId);
    } catch (error) {
      this.host.log("warn", `[LumiAH] turn ${turn.turn.slice(0, 8)}: the empty reply its stop left couldn't be deleted (${wordsOf(error)})`);
    }
  }
  unsure(userId) {
    this.accounts.get(userId)?.mine.clear();
  }
  async placeNow(input) {
    const { connections, chats } = this.deps;
    if (input.connectionId !== null)
      return connections.isLoopback(input.userId, input.connectionId);
    return (await connections.ofChat(input.userId, await chats.own(input.userId, input.chatId)))?.loopback === true;
  }
  async tune(account) {
    const read2 = this.deps.settings.transport(account.userId).then((transport) => {
      account.checkMs = transport.tags.checkMs;
      account.known = Math.min(transport.tags.known, CEILINGS.tagsKnown);
      account.held = Math.min(transport.tags.held, CEILINGS.tagsHeld);
      return transport;
    });
    const late = Promise.withResolvers();
    const unwait = this.deps.later(TRANSPORT_DEFAULTS.tags.checkMs, () => late.resolve(null));
    try {
      return await Promise.race([read2, late.promise]);
    } catch {
      return null;
    } finally {
      unwait();
      read2.catch(() => {
        return;
      });
    }
  }
  async where(input) {
    const account = this.of(input.userId);
    const key4 = `${input.connectionId ?? ""}\x00${input.chatId}`;
    const held = account.mine.get(key4);
    const began = this.deps.now();
    const check2 = this.placeNow(input).then((verdict) => {
      account.mine.delete(key4);
      account.mine.set(key4, verdict);
      for (const oldest of account.mine.keys()) {
        if (account.mine.size <= account.known)
          break;
        account.mine.delete(oldest);
      }
      this.bound();
      return verdict;
    });
    check2.catch(() => {
      return;
    });
    if (held === false)
      return false;
    await this.tune(account);
    const { checkMs } = account;
    const late = Promise.withResolvers();
    const unwait = this.deps.later(Math.max(0, checkMs - (this.deps.now() - began)), () => late.reject(new Error(`Lumiverse didn't say within ${waitWords(checkMs)}`)));
    try {
      return await Promise.race([check2, late.promise]);
    } catch (error) {
      if (held === undefined) {
        this.host.log("warn", `[LumiAH] a reply's connection couldn't be checked (${wordsOf(error)}), so it was left as it is`);
        return false;
      }
      throw new Error(`${this.deps.name} answers this chat in its runtime, and couldn't check its connection now (${wordsOf(error)}), so its agents had no part in this reply. Try again in a moment; if it keeps happening, see ${this.deps.name}'s Runtime page.`);
    } finally {
      unwait();
    }
  }
  generationOf(input) {
    const account = this.of(input.userId);
    if (input.generationId !== null) {
      const holder = this.home.get(input.generationId);
      if (holder !== undefined && holder !== account)
        return null;
      const named3 = account.generations.get(input.generationId);
      if (named3 !== undefined)
        return named3;
      const nobodys2 = this.unowned.get(input.generationId);
      if (nobodys2 !== undefined) {
        this.adopt(account, nobodys2);
        return nobodys2;
      }
      const made = { id: input.generationId, chatId: input.chatId, userId: input.userId, type: input.type, targetMessageId: null, targetSwipeId: null, at: this.deps.now(), ended: null, stopped: false };
      this.keep(account, made);
      return made;
    }
    const named2 = account.generations.get(account.latest.get(input.chatId) ?? "");
    const nobodys = this.unowned.get(this.unownedLatest.get(input.chatId) ?? "");
    const generation = named2 !== undefined && nobodys !== undefined ? nobodys.at > named2.at ? nobodys : named2 : named2 ?? nobodys;
    if (generation === undefined || generation.ended !== null || generation.stopped || generation.type !== input.type)
      return null;
    if (generation.userId === null)
      this.adopt(account, generation);
    return account.byTurn.get(generation.id)?.request != null ? null : generation;
  }
  take(input, kind, generation, omit) {
    const account = this.of(input.userId);
    const left = new Set(omit);
    const sources = input.messages.flatMap((m, i) => {
      if (left.has(i))
        return [];
      if (m.history && m.sourceId !== undefined && m.sourceIndex !== undefined)
        return [{ mark: contentMark(m.role, m.text), source: { kind: "history", messageId: m.sourceId, index: m.sourceIndex } }];
      return m.lore ? [{ mark: contentMark(m.role, m.text), source: { kind: "lore" } }] : [];
    });
    const earlier = account.byTurn.get(generation.id);
    if (earlier !== undefined)
      account.byTag.delete(earlier.tag);
    const turn = { turn: generation.id, tag: randomHex(128), userId: input.userId, chatId: input.chatId, kind, presetId: input.presetId, personaId: input.personaId, sources, activated: input.activated, at: this.deps.now(), request: null, relay: null, facts: null, target: null, stoppedHere: false };
    account.byTag.set(turn.tag, turn);
    account.byTurn.set(turn.turn, turn);
    account.byChat.set(turn.chatId, turn);
    this.home.set(turn.turn, account);
    this.trim(account);
    this.bound();
    return turn;
  }
  async intercept(input) {
    const kind = KINDS3[input.type];
    if (kind === undefined)
      return {};
    if (!await this.where(input))
      return {};
    if (!input.dryRun)
      this.deps.toRuntime?.(input.userId, input.chatId);
    if (!this.host.granted("generation_parameters"))
      return {};
    const transport = await this.deps.settings.transport(input.userId);
    const omit = cutoff(input.messages, transport.history);
    if (input.dryRun)
      return { omit };
    const generation = this.generationOf(input);
    if (generation === null)
      throw new Error(`${this.deps.name} couldn't tell which generation this prompt belongs to, so its agents had no part in this reply. Send the message again.`);
    const turn = this.take(input, kind, generation, omit);
    return { omit, parameters: { [TAG_PARAM]: turn.tag } };
  }
  async targetOf(turn) {
    for (;; ) {
      const heard = this.swipesDeleted;
      const generation = this.generation(turn.turn);
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
      if (this.swipesDeleted === heard)
        return { message, swipe: swipe ?? 0, gone: generation?.targetGone === true };
    }
  }
  async begin(userId, relay, key4, tag, request) {
    const { name } = this.deps;
    if (typeof key4 !== "string" || typeof tag !== "string" || typeof request !== "string" || request === "")
      throw new LinkRefused("bad_request", `The turn's request is malformed: update the runtime and ${name} to the same build.`);
    if (!await this.deps.registry.keyIs(userId, key4))
      throw wrongKey(name);
    const lifeMs = (await this.deps.settings.transport(userId)).tags.lifeMs;
    const settings = await this.deps.settings.revision(userId);
    const turn = this.accounts.get(userId)?.byTag.get(tag);
    if (turn === undefined || this.deps.now() - turn.at > lifeMs)
      throw new LinkRefused("not_found", `${name} doesn't know this reply's tag: the extension started again since the reply was asked for, or the tag is too old. Send the message again.`);
    if (turn.request !== null && turn.request !== request)
      throw new LinkRefused("conflict", "This reply's tag was already used. A tag admits one request, so this one wasn't answered: send the message again.");
    if (turn.facts === null) {
      turn.request = request;
      turn.relay = relay;
      turn.facts = this.targetOf(turn).then((target) => {
        turn.target = target;
        this.deps.open.put(userId, { turn: turn.turn, chatId: turn.chatId, kind: turn.kind, target: { message: target.message, swipe: target.swipe }, at: this.deps.now() }).catch((error) => this.host.log("warn", `[LumiAH] turn ${turn.turn.slice(0, 8)} couldn't be kept across a restart (${wordsOf(error)})`));
        const facts = { turn: turn.turn, user: turn.userId, chat: turn.chatId, generation: turn.turn, kind: turn.kind, target: { message: target.message, swipe: target.swipe }, preset: turn.presetId, sources: turn.sources };
        for (const listener of this.begun)
          listener(turn, facts);
        return facts;
      });
    }
    return { ...await turn.facts, settings };
  }
  async commit(userId, turnId, chatId, target, rawRecord) {
    const { name, open } = this.deps;
    const record2 = recordOf(rawRecord);
    const where = target;
    if (typeof turnId !== "string" || typeof chatId !== "string" || record2 === null || where === null || typeof where !== "object" || !(where.message === null || typeof where.message === "string") || typeof where.swipe !== "number" || !Number.isSafeInteger(where.swipe) || where.swipe < 0) {
      throw new LinkRefused("bad_request", `The turn's record is malformed: update the runtime and ${name} to the same build.`);
    }
    await this.deps.chats.own(userId, chatId);
    const account = this.of(userId);
    const known = account.byTurn.get(turnId);
    const kept = known === undefined ? await open.get(userId, turnId) : null;
    if ((known?.chatId ?? kept?.chatId) !== chatId)
      throw new LinkRefused("not_found", `${name} knows no such turn in that chat, so its record wasn't taken: a record is kept only for a reply that began here.`);
    open.drop(userId, turnId).catch(() => {
      return;
    });
    const pending = { turn: turnId, userId, chatId, target: known?.target ?? { message: where.message, swipe: where.swipe, gone: false }, record: record2, at: this.deps.now() };
    if (pending.target.gone) {
      this.host.log("warn", `[LumiAH] turn ${turnId.slice(0, 8)}: the swipe its reply was written on was deleted, so its record wasn't written`);
      return "never";
    }
    if (this.generation(turnId) === undefined && await this.saved(pending))
      return await this.write(pending, null) ? "now" : "never";
    const generation = this.generation(turnId);
    if (generation?.ended != null)
      return await this.write(pending, generation.ended.messageId) ? "now" : "never";
    if (generation?.stopped === true)
      return await this.write(pending, null) ? "now" : "never";
    account.pending.set(turnId, pending);
    this.home.set(turnId, account);
    const held = Math.min((await this.deps.settings.transport(userId)).anchors.held, CEILINGS.recordsWaiting);
    while (account.pending.size > held)
      this.early(account);
    this.bound();
    return "on_save";
  }
  async saved(pending) {
    const { message, swipe } = pending.target;
    if (message === null || pending.record.kind === "continue")
      return false;
    const shown = await this.deps.chats.find(pending.chatId, message).catch(() => null);
    return shown !== null && shown.swipeId === swipe && shown.content !== "";
  }
  async write(pending, saved) {
    const { target } = pending;
    const messageId = saved ?? target.message;
    const turn = pending.turn.slice(0, 8);
    if (!this.host.granted("chat_mutation"))
      return false;
    try {
      if (messageId === null) {
        this.host.log("warn", `[LumiAH] turn ${turn}: its reply wasn't saved, so its record wasn't written`);
        return false;
      }
      const own = messageId === target.message;
      for (;; ) {
        if (own && target.gone) {
          this.host.log("warn", `[LumiAH] turn ${turn}: the swipe its reply was written on was deleted, so its record wasn't written`);
          return false;
        }
        const aimed = target.swipe;
        const written = await this.deps.chats.anchor(pending.userId, pending.chatId, messageId, own ? () => target.swipe : null, pending.record);
        if (written) {
          for (const listener of this.answered)
            listener(pending.userId);
          return true;
        }
        if (own && (target.gone || target.swipe !== aimed))
          continue;
        this.host.log("warn", `[LumiAH] turn ${turn}: its reply's message is gone, so its record wasn't written`);
        return false;
      }
    } catch (error) {
      this.host.log("error", `[LumiAH] turn ${turn}: its record couldn't be written (${wordsOf(error)})`);
      return false;
    }
  }
  async activated(userId, chatId, generationId) {
    const out = [];
    for (const a of this.activatedInfo(userId, chatId, generationId)) {
      const entry = await this.host.lore.entry(a.entryId, userId).catch(() => null);
      if (entry !== null)
        out.push({ entryId: a.entryId, bookId: a.bookId ?? entry.bookId, title: a.title !== "" ? a.title : entry.title, content: entry.content });
    }
    return out;
  }
  activatedInfo(userId, chatId, generationId) {
    const turn = this.accounts.get(userId)?.byTurn.get(generationId);
    return turn === undefined || turn.chatId !== chatId ? [] : turn.activated;
  }
  async tick() {
    const now = this.deps.now();
    for (const account of [...this.accounts.values()]) {
      const transport = await this.deps.settings.transport(account.userId).catch(() => TRANSPORT_DEFAULTS);
      for (const pending of [...account.pending.values()]) {
        if (now - pending.at <= transport.anchors.waitMs)
          continue;
        account.pending.delete(pending.turn);
        this.let(account, pending.turn);
        this.write(pending, null);
      }
      for (const turn of [...account.byTag.values()])
        if (now - turn.at > transport.tags.lifeMs && !account.pending.has(turn.turn))
          this.forget(account, turn);
      for (const [id2, generation] of [...account.generations])
        if (now - generation.at > transport.tags.lifeMs && !account.byTurn.has(id2) && !account.pending.has(id2))
          this.dropGeneration(account, id2);
      for (const kept of await this.deps.open.list(account.userId).catch(() => []))
        if (now - kept.at > transport.tags.lifeMs)
          await this.deps.open.drop(account.userId, kept.turn).catch(() => {
            return;
          });
    }
    for (const [id2, generation] of [...this.unowned]) {
      if (now - generation.at <= TRANSPORT_DEFAULTS.tags.lifeMs)
        continue;
      this.unowned.delete(id2);
      if (this.unownedLatest.get(generation.chatId) === id2)
        this.unownedLatest.delete(generation.chatId);
    }
  }
}

// src/extension/backend/story.ts
function storedOf7(raw) {
  if (!isRecord2(raw) || raw.v !== 1 || !isRecord2(raw.jobs))
    return null;
  const jobs = {};
  for (const [chatId, job] of Object.entries(raw.jobs))
    if (typeof job === "string" && job !== "")
      jobs[chatId] = job;
  return { v: 1, jobs };
}

class StoryJobs {
  docs;
  constructor(host) {
    this.docs = new UserDocs(host, "story.json", storedOf7, () => ({ v: 1, jobs: {} }));
  }
  async of(userId, chatId) {
    const { jobs } = await this.docs.get(userId);
    return Object.hasOwn(jobs, chatId) ? jobs[chatId] ?? null : null;
  }
  async started(userId, chatId, job) {
    await this.docs.change(userId, (doc) => {
      doc.jobs[chatId] = job;
    });
  }
  async again(userId, chatId, from, job) {
    if (await this.of(userId, chatId) === from)
      await this.started(userId, chatId, job);
  }
  async gone(userId, chatId, job) {
    if (await this.of(userId, chatId) !== job)
      return;
    await this.docs.change(userId, (doc) => {
      if (doc.jobs[chatId] === job)
        delete doc.jobs[chatId];
    });
  }
  settle() {
    return this.docs.settle();
  }
}

// src/extension/backend/ui.ts
function runtimeOf(r) {
  return r.relay !== undefined ? { relay: r.relay } : {};
}
var LINK_CODES = { bad_request: "bad_request", forbidden: "forbidden", not_found: "not_found", conflict: "unavailable", unavailable: "unavailable", too_large: "bad_request" };

class Ui {
  host;
  deps;
  users = new Map;
  queue = new KeyedQueue;
  said = new Map;
  story;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
    this.story = new StoryJobs(host);
  }
  async key(userId) {
    const key4 = (await this.deps.registry.read(userId)).key;
    return { set: key4 !== null, print: key4?.print ?? null, at: key4?.at ?? null };
  }
  async setup(userId) {
    const d = this.deps;
    const registry = await d.registry.read(userId);
    const chats = await d.switch.list(userId, d.live.chatsOf(userId));
    return {
      steps: [
        { id: "permissions", done: !d.permissions().some((need) => need.needed) },
        { id: "chat", done: chats.some((chat) => chat.on || chatAnswered(chat)) },
        { id: "reply", done: registry.replied }
      ]
    };
  }
  async runtime(userId) {
    const view = await this.deps.relays.view(userId, this.deps.issues());
    return { ...view, road: await this.deps.road.view(userId, view.relays.map((r) => ({ id: r.id, linked: r.link === "linked" }))) };
  }
  async timings(userId) {
    const linked = await this.deps.relays.linked(userId);
    const runtimes = await Promise.all(linked.map(async (r) => {
      try {
        const timings = timingsViewOf(await this.deps.asks.ask(userId, "timings.read", {}, { relay: r.id }));
        return { id: r.id, name: r.name, timings, problem: timings === null ? "Its timings couldn't be read: update the runtime and the extension to the same build." : null };
      } catch (error) {
        return { id: r.id, name: r.name, timings: null, problem: wordsOf(error) };
      }
    }));
    return { extension: this.deps.timings.view(), runtimes };
  }
  async part(userId, part) {
    const d = this.deps;
    switch (part) {
      case "runtime":
        return this.runtime(userId);
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
      case "approvals":
        return d.approvals.views(userId);
      case "notices":
        return d.notices.list(userId);
      case "jobs":
        return this.jobsState(userId);
      case "defs":
        return d.defs.rev(userId);
      case "permissions":
        return d.permissions();
    }
  }
  async jobsState(userId) {
    const d = this.deps;
    const core = (await d.settings.values(userId))[d.coreKey];
    const off = isRecord2(core) && isRecord2(core.jobs) && core.jobs.enabled === false;
    return d.jobs.state(userId, off, (await d.settings.transport(userId)).jobs.paused);
  }
  async chat(userId, chatId) {
    if (chatId !== null)
      await this.deps.chats.own(userId, chatId);
    return chatId;
  }
  ask(userId, group, method, input, where = {}) {
    return this.deps.asks.ask(userId, `${group}.${method}`, toJsonObject(input), where);
  }
  async recall(userId, method, input) {
    await this.deps.chats.own(userId, input.chatId);
    return this.ask(userId, "recall", method, input, { chat: input.chatId });
  }
  async storyJob(userId, chatId) {
    const id2 = await this.story.of(userId, chatId);
    if (id2 === null)
      return null;
    try {
      return jobOf(await this.deps.asks.ask(userId, "jobs.read", { id: id2 }, { job: id2 }));
    } catch (error) {
      if (!(error instanceof UiRefused && error.code === "not_found"))
        throw error;
    }
    await this.remembered(this.story.gone(userId, chatId, id2));
    return null;
  }
  async remembered(kept) {
    await kept.catch((error) => this.host.log("warn", `[LumiAH] which job learns a chat's story couldn't be kept (${wordsOf(error)})`));
  }
  async coreSettings(userId) {
    return settingsOf((await this.deps.settings.values(userId))[this.deps.coreKey]);
  }
  async settingsNow(userId) {
    const d = this.deps;
    return { coreKey: d.coreKey, schema: d.settings.schema(), values: await d.settings.values(userId) };
  }
  async character(userId, chatId) {
    const info = chatId === null ? null : await this.deps.chats.info(userId, chatId);
    return info === null || info.characterId === null ? null : { id: info.characterId, name: info.characterName };
  }
  async agentNames(userId) {
    return agentNames(await this.ask(userId, "definitions", "get", {}));
  }
  async chatNames(userId, chatIds) {
    const named2 = await Promise.all(chatIds.map(async (chatId) => {
      try {
        return [chatId, (await this.deps.chats.own(userId, chatId)).name];
      } catch (error) {
        if (error instanceof LinkRefused && error.code === "not_found")
          return [chatId, null];
        throw error;
      }
    }));
    return new Map(named2);
  }
  async kept(userId, raw) {
    const rows = keptOf(raw);
    const names = await this.chatNames(userId, [...new Set(rows.map((row) => row.chatId))]);
    return rows.flatMap((row) => {
      const name = names.get(row.chatId);
      return name === undefined || name === null ? [] : [{ chatId: row.chatId, chat: name === "" ? null : name, tool: row.tool, at: row.at ?? 0 }];
    });
  }
  unkept(userId, side) {
    const mine = this.said.get(userId);
    const held = mine?.get(side.id);
    if (mine === undefined || held === undefined)
      return null;
    if (side.turns <= held.before)
      return held;
    mine.delete(side.id);
    return null;
  }
  async standing(userId, session, held) {
    const d = this.deps;
    if (d.live.running(userId, session, held.turn) !== null)
      return "running";
    if (d.live.streamOf(userId, held.turn) === null)
      return d.now() - held.at <= (await d.settings.transport(userId)).live.lostMs ? "running" : "lost";
    const view = (await d.live.open(userId, session, undefined)).live;
    return view !== null && view.turn === held.turn && view.ended?.state === "lost" ? "lost" : "running";
  }
  async state(userId, rev) {
    const [runtime, setup, key4, chats, connections, settings, texts, notices, jobs, defs] = await Promise.all([this.part(userId, "runtime"), this.part(userId, "setup"), this.part(userId, "key"), this.part(userId, "chats"), this.part(userId, "connections"), this.part(userId, "settings"), this.part(userId, "texts"), this.part(userId, "notices"), this.part(userId, "jobs"), this.part(userId, "defs")]);
    return { rev, runtime, setup, key: key4, chats, running: this.deps.live.runningOf(userId), connections, settings, texts, approvals: this.deps.approvals.views(userId), jobs, notices, defs, permissions: this.deps.permissions() };
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
    await this.story.settle();
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
        if (request.active !== undefined && this.deps.connections.pageSaid(userId, request.active)) {
          this.deps.turns.unsure(userId);
          this.touch(userId, "chats", "setup");
        }
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
        d.turns.unsure(userId);
        this.touch(userId, "chats", "setup");
        return { chat };
      }
      case "lah.chat.takeover": {
        const chat = await d.switch.set(userId, r.chatId, true, true);
        d.turns.unsure(userId);
        this.touch(userId, "chats", "setup");
        return { chat };
      }
      case "lah.chat.story.get":
        return { story: await d.switch.story(userId, r.chatId) };
      case "lah.chat.story.set":
        return { story: await d.switch.setStory(userId, r.chatId, r.story) };
      case "lah.chat.lead.get":
        return { lead: await d.switch.lead(userId, r.chatId) };
      case "lah.live.open":
        return d.live.open(userId, r.stream, session);
      case "lah.live.events": {
        const page = await d.live.events(userId, r.stream, r.turn, r.from);
        if (page === null)
          throw new UiRefused("not_found", "That turn is no longer the live one here: open the live view again.");
        return page;
      }
      case "lah.live.close":
        d.live.close(userId, r.stream, session);
        return { closed: true };
      case "lah.turn.stop": {
        const running = d.live.running(userId, r.stream, r.turn);
        if (running === null)
          return { stopped: false };
        const relay = running.relay;
        const why = "You stopped the reply from LumiAH's live view.";
        d.turns.stoppedFromLive(userId, r.turn);
        const told = d.relays.push(userId, relay, { link: LINK, type: "stop", turn: r.turn, why, by: "live" });
        return { stopped: d.streams.stopTurn(userId, r.turn, why) > 0 || told };
      }
      case "lah.turns.list":
        return d.sessions.list(userId, r.chatId, r.cursor, r.limit);
      case "lah.transcript.get":
        return d.sessions.transcript(userId, r.transcript, r.from);
      case "lah.prompt.get":
        return { prompt: await d.sessions.prompt(userId, r.prompt) };
      case "lah.blob.get":
        return { text: await d.sessions.blob(userId, r.hash) };
      case "lah.session.rollback":
        return d.sessions.rollback(userId, r.chatId, r.messageId, r.swipe);
      case "lah.session.summarize":
        await d.chats.own(userId, r.chatId);
        await this.ask(userId, "session", "summarize", { chatId: r.chatId }, { chat: r.chatId });
        return { session: await d.sessions.view(userId, r.chatId) };
      case "lah.settings.set":
        return { settings: await d.settings.change(userId, r.set, r.reset) };
      case "lah.connections.list":
        return await d.asks.ask(userId, "connections.list", {}, runtimeOf(r));
      case "lah.connections.save":
        return await d.asks.ask(userId, "connections.save", { connection: toJsonObject(r.connection), ...r.key !== undefined ? { key: r.key } : {}, ...r.create === true ? { create: true } : {} }, runtimeOf(r));
      case "lah.connections.remove":
        return await d.asks.ask(userId, "connections.remove", { id: r.id }, runtimeOf(r));
      case "lah.connections.default":
        return await d.asks.ask(userId, "connections.default", { id: r.id }, runtimeOf(r));
      case "lah.connections.test":
        return await d.asks.ask(userId, "connections.test", { id: r.id }, runtimeOf(r));
      case "lah.connections.models":
        return await d.asks.ask(userId, "connections.models", "provider" in r ? { provider: r.provider } : { connectionId: r.connectionId }, runtimeOf(r));
      case "lah.connections.lumiverse":
        return { connections: await d.connections.lumiverse(userId) };
      case "lah.signin.start":
        return await d.asks.ask(userId, "signin.start", { provider: r.provider }, runtimeOf(r));
      case "lah.signin.finish":
        return await d.asks.ask(userId, "signin.finish", { flow: r.flow, code: r.code }, runtimeOf(r));
      case "lah.signin.cancel":
        return await d.asks.ask(userId, "signin.cancel", { flow: r.flow }, runtimeOf(r));
      case "lah.signin.out":
        return await d.asks.ask(userId, "signin.out", { provider: r.provider }, runtimeOf(r));
      case "lah.signin.state":
        return await d.asks.ask(userId, "signin.state", { provider: r.provider }, runtimeOf(r));
      case "lah.text.set":
        return { texts: await d.settings.text(userId, r.id, r.text) };
      case "lah.text.reset":
        return { texts: await d.settings.text(userId, r.id, null) };
      case "lah.key": {
        const out = r.op === "mint" ? await d.keys.mint(userId) : await d.keys.forget(userId);
        this.touch(userId, "key", "runtime", "setup", "connections", "chats");
        return { ...out, view: await this.key(userId) };
      }
      case "lah.relay": {
        if (r.op === "rotate")
          await d.relays.rotate(userId, r.relay);
        else {
          await d.relays.forget(userId, r.relay);
          d.streams.forget(userId, r.relay);
        }
        return { runtime: await this.runtime(userId) };
      }
      case "lah.drawer.close":
        return { closed: await this.host.closeDrawer(userId) };
      case "lah.runtime.service.get":
        return await d.asks.ask(userId, "runtime.service.get", {}, { relay: r.relay });
      case "lah.runtime.service.set":
        return await d.asks.ask(userId, "runtime.service.set", { ...r.memory !== undefined ? { memory: r.memory } : {}, ...r.autoUpdate !== undefined ? { autoUpdate: r.autoUpdate } : {}, ...r.restart !== undefined ? { restart: r.restart } : {} }, { relay: r.relay });
      case "lah.runtime.update.apply":
        return await d.asks.ask(userId, "runtime.update.apply", {}, { relay: r.relay });
      case "lah.turn.say": {
        if (d.live.running(userId, r.stream, r.turn) === null)
          return { said: false };
        const out = await d.asks.ask(userId, "run.say", { run: r.turn, text: r.text }, { run: { stream: r.stream, turn: r.turn } });
        return { said: isRecord2(out) && out.said === true };
      }
      case "lah.turn.pause": {
        if (d.live.running(userId, r.stream, r.turn) === null)
          return { paused: false };
        const out = await d.asks.ask(userId, "run.pause", { run: r.turn, on: r.on }, { run: { stream: r.stream, turn: r.turn } });
        return { paused: isRecord2(out) && out.paused === true };
      }
      case "lah.approval.answer":
        return { answered: d.approvals.answer(userId, r.id, r.answer) };
      case "lah.approvals.kept": {
        const chatId = await this.chat(userId, r.chatId);
        return { kept: await this.kept(userId, await this.ask(userId, "approvals", "kept", { chatId }, { chat: chatId })) };
      }
      case "lah.approval.forget":
        await d.chats.own(userId, r.chatId);
        return { kept: await this.kept(userId, await this.ask(userId, "approvals", "forget", { chatId: r.chatId, tool: r.tool }, { chat: r.chatId })) };
      case "lah.ws.list": {
        const chatId = await this.chat(userId, r.chatId);
        return areaView(await this.ask(userId, "workspace", "list", { chatId, area: r.area }, { chat: chatId }));
      }
      case "lah.ws.read": {
        const chatId = await this.chat(userId, r.chatId);
        return fileRead(await this.ask(userId, "workspace", "read", { chatId, area: r.area, path: r.path, version: r.version }, { chat: chatId }));
      }
      case "lah.ws.write": {
        const chatId = await this.chat(userId, r.chatId);
        return fileChanged(await this.ask(userId, "workspace", "write", { chatId, area: r.area, path: r.path, text: r.text, base: r.base }, { chat: chatId }));
      }
      case "lah.ws.move": {
        const chatId = await this.chat(userId, r.chatId);
        return fileChanged(await this.ask(userId, "workspace", "move", { chatId, area: r.area, from: r.from, to: r.to, base: r.base }, { chat: chatId }));
      }
      case "lah.ws.delete": {
        const chatId = await this.chat(userId, r.chatId);
        await this.ask(userId, "workspace", "delete", { chatId, area: r.area, path: r.path, base: r.base }, { chat: chatId });
        return { deleted: true };
      }
      case "lah.ws.pin": {
        const chatId = await this.chat(userId, r.chatId);
        return fileChanged(await this.ask(userId, "workspace", "pin", { chatId, area: r.area, path: r.path, on: r.on, role: r.agent }, { chat: chatId }));
      }
      case "lah.ws.history": {
        const chatId = await this.chat(userId, r.chatId);
        const versions = versionsOf(await this.ask(userId, "workspace", "history", { chatId, area: r.area, path: r.path }, { chat: chatId }));
        return versionsView(versions, chatId === null ? [] : await pathTurns(await d.chats.path(userId, chatId)));
      }
      case "lah.ws.changes":
        await d.chats.own(userId, r.chatId);
        return changesView(await this.ask(userId, "workspace", "changes", { chatId: r.chatId, messageId: r.messageId, swipe: r.swipe }, { chat: r.chatId }));
      case "lah.guidance.get": {
        const chatId = await this.chat(userId, r.chatId);
        return guidanceView(guidanceOf(await this.ask(userId, "guidance", "get", { chatId }, { chat: chatId })), await this.character(userId, chatId));
      }
      case "lah.guidance.set": {
        const chatId = await this.chat(userId, r.chatId);
        return guidanceView(guidanceOf(await this.ask(userId, "guidance", "set", { chatId, level: r.level, text: r.text, base: r.base }, { chat: chatId })), await this.character(userId, chatId));
      }
      case "lah.defs.get":
        return d.defs.view(userId);
      case "lah.agent.save":
        return d.defs.saveAgent(userId, r.agent);
      case "lah.skill.save":
        return d.defs.saveSkill(userId, r.skill);
      case "lah.def.remove":
        return d.defs.remove(userId, r.kind, r.id);
      case "lah.def.switch":
        return d.defs.switch(userId, r.kind, r.id, r.off);
      case "lah.tool.approval":
        return d.defs.toolApproval(userId, r.name, r.approval);
      case "lah.tier.approval":
        return d.defs.tierApproval(userId, r.tier, r.approval);
      case "lah.jobs.list": {
        const chatId = await this.chat(userId, r.chatId);
        const page = jobsOf(await this.ask(userId, "jobs", "list", { chatId, cursor: r.cursor, limit: r.limit }, { chat: chatId }));
        if (r.chatId === null && r.cursor === null && !d.jobs.known(userId)) {
          d.jobs.seed(userId, page.jobs.filter((job) => !jobOver(job)));
          this.touch(userId, "jobs");
        }
        return jobsPage(page, (await this.coreSettings(userId)).jobs, r.cursor);
      }
      case "lah.jobs.set": {
        const set = [];
        if (r.off !== undefined)
          set.push({ path: [d.coreKey, "jobs", "enabled"], value: !r.off });
        if (r.paused !== undefined)
          set.push({ path: [TRANSPORT_KEY, "jobs", "paused"], value: r.paused });
        await d.settings.change(userId, set, []);
        const now = await this.jobsState(userId);
        return { off: now.off, paused: now.paused };
      }
      case "lah.job.start": {
        await d.chats.own(userId, r.chatId);
        const job = jobOf(await this.ask(userId, "jobs", "start", { chatId: r.chatId, agent: r.agent, task: r.task, when: r.when, allowance: r.allowance }, { chat: r.chatId }));
        if (r.story === true)
          await this.remembered(this.story.started(userId, r.chatId, job.id));
        return { job };
      }
      case "lah.job.cancel":
        return { job: jobOf(await this.ask(userId, "jobs", "cancel", { id: r.id }, { job: r.id })) };
      case "lah.job.again": {
        const job = jobOf(await this.ask(userId, "jobs", "again", { id: r.id }, { job: r.id }));
        await this.remembered(this.story.again(userId, job.chatId, r.id, job.id));
        return { job };
      }
      case "lah.job.grant":
        return { job: jobOf(await this.ask(userId, "jobs", "grant", { id: r.id, allowance: r.allowance }, { job: r.id })) };
      case "lah.job.resume":
        return { job: jobOf(await d.asks.ask(userId, "job.resume", { id: r.id }, { job: r.id })) };
      case "lah.notice.dismiss":
        return { notices: await d.notices.dismiss(userId, r.id) };
      case "lah.side.list": {
        const rows = sidesOf(await this.ask(userId, "sides", "list", {})).sides;
        const mine = this.said.get(userId);
        for (const id2 of [...mine?.keys() ?? []])
          if (!rows.some((row) => row.id === id2))
            mine?.delete(id2);
        const names = rows.length === 0 ? new Map : await this.agentNames(userId);
        const { progressChars } = (await this.coreSettings(userId)).reply;
        return { sessions: rows.map((row) => sideSession(row, names, this.unkept(userId, row), progressChars)) };
      }
      case "lah.side.start": {
        const chatId = await this.chat(userId, r.chatId);
        const { side } = sideStartedOf(await this.ask(userId, "sides", "start", { chatId, agent: r.agent }, { chat: chatId }));
        return { session: sideSession(side, await this.agentNames(userId), null, 0) };
      }
      case "lah.side.turns": {
        const core = sideTurnsOf(await this.ask(userId, "sides", "turns", { id: r.session }, { side: r.session }));
        const held = this.unkept(userId, core.side);
        const page = pageOf(sideTurns(core.turns, held === null ? null : { turn: held.turn, said: held.said, at: held.at, state: await this.standing(userId, r.session, held) }), r.cursor, r.limit);
        if (page === null)
          throw new UiRefused("bad_request", "That page of the conversation's turns isn't one LumiAH gave.");
        return { turns: page.rows, next: page.next };
      }
      case "lah.side.send": {
        const side = sidesOf(await this.ask(userId, "sides", "list", {})).sides.find((row) => row.id === r.session);
        if (side === undefined)
          throw new UiRefused("not_found", "That side session is no longer there.");
        const turn = turnStarted(await d.asks.ask(userId, "side.send", { session: r.session, text: r.text }, { side: r.session }));
        const held = { turn, said: r.text, at: d.now(), before: side.turns };
        this.said.set(userId, (this.said.get(userId) ?? new Map).set(r.session, held));
        return { session: sideSession(side, await this.agentNames(userId), held, (await this.coreSettings(userId)).reply.progressChars), turn };
      }
      case "lah.side.remove":
        await this.ask(userId, "sides", "remove", { id: r.session }, { side: r.session });
        this.said.get(userId)?.delete(r.session);
        return { removed: true };
      case "lah.spend.get": {
        const spend = spendOf(await this.ask(userId, "spend", "get", { days: r.days }));
        const chats = spend.chats.flatMap((row) => row.key === "" ? [] : [row.key]);
        const [chatNames, agents, held] = await Promise.all([this.chatNames(userId, chats), spend.agents.length === 0 ? new Map : this.agentNames(userId), d.asks.ask(userId, "connections.list", {}).catch(() => null)]);
        const listed = isRecord2(held) && Array.isArray(held.connections) ? held.connections : [];
        const connections = new Map(listed.flatMap((c) => isRecord2(c) && typeof c.id === "string" && typeof c.name === "string" ? [[c.id, c.name]] : []));
        return spendView(spend, { chats: chatNames, agents, connections }, await this.settingsNow(userId));
      }
      case "lah.upkeep.get":
        return upkeepView(upkeepOf(await d.asks.ask(userId, "upkeep.get", {})), await this.settingsNow(userId));
      case "lah.upkeep.sweep":
        return upkeepView(upkeepOf(await d.asks.ask(userId, "upkeep.sweep", {}, { patient: true })), await this.settingsNow(userId));
      case "lah.timings.get":
        return this.timings(userId);
      case "lah.runtime.store": {
        const state2 = await d.asks.ask(userId, "store.state", {}, { relay: r.relay });
        if (!isRecord2(state2) || typeof state2.waiting !== "number")
          throw new UiRefused("internal", "The runtime answered with something that isn't its store's state: update the runtime and the extension to the same build.");
        return { state: state2 };
      }
      case "lah.runtime.chatdata": {
        const [state2, database] = await Promise.all([d.asks.ask(userId, "copy.state", {}, { relay: r.relay }), d.copy.databaseView(userId)]);
        if (!isRecord2(state2) || state2.road !== "copy" && state2.road !== "link")
          throw new UiRefused("internal", "The runtime answered with something that isn't its copy's state: update the runtime and the extension to the same build.");
        return { state: state2, database };
      }
      case "lah.runtime.database":
        return { database: await d.copy.setDatabase(userId, r.on) };
      case "lah.home.get": {
        if (r.chatId === null)
          return { chat: null, last: null };
        let chat;
        try {
          chat = await d.switch.view(userId, r.chatId);
        } catch (error) {
          if (error instanceof LinkRefused && error.code === "not_found")
            return { chat: null, last: null };
          throw error;
        }
        return { chat, last: await d.sessions.last(userId, r.chatId, d.live.whole(userId, r.chatId)) };
      }
      case "lah.lore.get":
        return loreView(await this.recall(userId, "lore", { chatId: r.chatId }));
      case "lah.lore.entry":
        return loreEntry(await this.recall(userId, "entry", { chatId: r.chatId, entryId: r.entryId }));
      case "lah.lore.search":
        return loreSearch(await this.recall(userId, "search", { chatId: r.chatId, queries: r.queries, ...r.limit !== undefined ? { limit: r.limit } : {} }));
      case "lah.lore.embed":
        return embeddingView(await this.recall(userId, "embed", { chatId: r.chatId, start: r.start }));
      case "lah.chronicle.get":
        return chronicleView(await this.recall(userId, "chronicle", { chatId: r.chatId }));
      case "lah.chronicle.cited":
        return citedView(await this.recall(userId, "cited", { chatId: r.chatId, citations: r.citations }));
      case "lah.story.get": {
        const status = storyOf(await this.recall(userId, "story", { chatId: r.chatId }));
        return storyView(status, await this.storyJob(userId, r.chatId));
      }
    }
  }
}

// src/extension/backend/backend.ts
var CORE_KEY = "core";
function settingsSections(scope) {
  return [
    {
      key: CORE_KEY,
      defaults: () => defaultSettings(),
      schema: SETTINGS_SCHEMA,
      retired: RETIRED_SETTINGS,
      async check(values, userId) {
        const known = await scope?.(userId);
        const plain = checkSettings(values);
        if (known === undefined)
          return plain;
        const refused2 = new Set(plain.map((problem) => JSON.stringify(problem.path)));
        return checkSettings(values, known).filter((problem) => refused2.has(JSON.stringify(problem.path)));
      },
      async fixed(userId) {
        const known = await scope?.(userId);
        return (known?.agents ?? []).filter((agent) => agent.owns?.includes("tools") === true).map((agent) => ["agents", agent.id, "tools"]);
      }
    },
    { key: TRANSPORT_KEY, defaults: transportDefaults, schema: TRANSPORT_SCHEMA, check: checkTransport, retired: TRANSPORT_RETIRED }
  ];
}
var NEEDS = [
  { id: "interceptor", needed: true, what: "see a reply's prompt before it is sent", without: "no reply is worked on" },
  { id: "chats", needed: true, what: "read a chat and switch itself on for it", without: "no chat can be switched on" },
  { id: "generation", needed: true, what: "hear when a reply starts, ends or is stopped", without: "no reply is worked on" },
  { id: "chat_mutation", needed: true, what: "read the chat's messages and write each reply's record on it", without: "no reply is worked on" },
  { id: "generation_parameters", needed: true, what: "tag the replies your runtime answers", without: "no reply is worked on" },
  { id: "world_books", needed: false, what: "read your world books", without: "agents can't look up lore" },
  { id: "presets", needed: false, what: "read the preset's instructions", without: "the agents know the preset only by the prompt it made" },
  { id: "characters", needed: false, what: "find the world books attached to the chat's character, and tell which character a piece of guidance is for", without: "those books aren't found, and guidance written for one character isn't matched" },
  { id: "personas", needed: false, what: "find the world book attached to your persona", without: "that book isn't found" },
  { id: "mcp_servers", needed: false, what: "offer its agents the tools of the MCP servers you set up in Lumiverse", without: "agents have no MCP tools" },
  { id: "embeddings", needed: false, what: "search lore and the chat by meaning on your embedding connection", without: "search is by word" },
  { id: "memories", needed: false, what: "read Lumiverse's Memory Cortex", without: "the memory tools aren't offered" },
  { id: "databanks", needed: false, what: "read your databanks", without: "the databank tools aren't offered" },
  { id: "web_search", needed: false, what: "search the web with your own provider", without: "web_search isn't offered" },
  { id: CORS_PROXY, needed: false, what: "reach your runtime on this machine through Lumiverse's own proxy, so a page's request doesn't wait behind a reply's traffic on the link", without: "pages reach the runtime over the link alone" }
];
function createBackend(host, env, options = {}) {
  const identity = identityOf({ identifier: host.identifier, ...options.identity });
  const { now, later, build } = env;
  const { name } = identity;
  const warn = (what) => (error) => host.log("warn", `[LumiAH] ${what}: ${wordsOf(error)}`);
  const declined = new Set(options.declined ?? []);
  const grant = `Grant it in Lumiverse (Extensions \u2192 ${name} \u2192 Permissions).`;
  const permissions = () => NEEDS.filter((need) => !declined.has(need.id) && !host.granted(need.id)).map((need) => ({ id: need.id, what: need.what, without: need.without, todo: grant, needed: need.needed }));
  const blocked = () => {
    const missing = NEEDS.filter((need) => need.needed && !host.granted(need.id)).map((need) => `"${need.id}"`);
    if (missing.length === 0)
      return null;
    return `${name} can't answer a chat without the permission${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. ${missing.length === 1 ? "Grant it" : "Grant them"} in Lumiverse (Extensions \u2192 ${name} \u2192 Permissions).`;
  };
  const registry = new RegistryStore(host);
  const made = { server: null, asks: null, connections: null, chatSwitch: null };
  const scope = async (userId) => {
    try {
      const read2 = await made.asks?.ask(userId, "definitions.get", {});
      const said2 = isRecord2(read2) && isRecord2(read2.scope) ? read2.scope : null;
      return said2 !== null && Array.isArray(said2.tools) && said2.tools.length > 0 && Array.isArray(said2.agents) ? said2 : undefined;
    } catch {
      return;
    }
  };
  const settings = new SettingsStore(host, settingsSections(scope), { defs: TEXT_DEFS, check: checkText });
  const relays = new Relays(host, registry, settings, {
    now,
    build,
    identity,
    ...options.ownSwitch === true ? { switchedBy: name } : {},
    ...env.runtime !== undefined ? { runtime: env.runtime } : {},
    send: (frame, userId, session) => made.server?.send(frame, userId, session),
    hasLoopback: async (userId) => (await made.connections?.loopbacks(userId) ?? []).length > 0
  });
  const streams = new StreamRegistry({ now, push: (userId, relay, push) => relays.push(userId, relay, push) });
  const connections = new Connections(host, { model: loopbackModel(identity.identifier), bases: (userId) => relays.bases(userId) });
  made.connections = connections;
  const codec = options.anchor ?? (identity.anchorKey === identity.identifier ? OWN_ANCHORS : anchorsUnder(identity.anchorKey));
  const chats = new Chats(host, async (userId) => {
    const { pathsKept, pathMs } = (await settings.transport(userId)).sessions;
    return { chats: pathsKept, ms: pathMs };
  }, now, codec);
  const open = new OpenTurns(host, async (userId) => Math.min((await settings.transport(userId)).tags.held, CEILINGS.tagsHeld));
  const relayOf = async (userId, chatId) => {
    const on = await connections.ofChat(userId, await chats.own(userId, chatId));
    const url = on === null ? undefined : (await connections.loopbacks(userId)).find((c) => c.id === on.id)?.url;
    if (url === undefined)
      return null;
    const linked = await relays.linked(userId);
    const found = linked.find((r) => sameBase(runtimeBase(r.listen, r.port), url)) ?? (linked.length === 1 ? linked[0] : undefined);
    return found === undefined ? null : { id: found.id, name: found.name };
  };
  const runtimeOf2 = async (userId, chatId) => (await relayOf(userId, chatId))?.id ?? null;
  const telling = new Set;
  const warnAway = (userId, chatId) => {
    const told = (async () => {
      if (await runtimeOf2(userId, chatId) !== null)
        return;
      host.toast(userId, "warning", `${name}'s runtime isn't answering, so this reply will fail. Start the runtime (its line is on ${name}'s Runtime page), then send your message again.`);
    })().catch(warn("whether a reply's runtime is linked couldn't be told")).finally(() => telling.delete(told));
    telling.add(told);
  };
  const runtimeHeard = new Set;
  const tellRuntime = (userId) => {
    for (const listener of runtimeHeard) {
      try {
        listener(userId);
      } catch (error) {
        warn("a listener to the runtime's state failed")(error);
      }
    }
  };
  const turns = new Turns(host, {
    chats,
    connections,
    registry,
    settings,
    open,
    toRuntime: warnAway,
    name,
    now,
    later
  });
  const storage = new Storage(host);
  const mirror = new Mirrors(host, { now, quietMs: async (userId) => (await settings.transport(userId)).link.quietMs, send: (push, userId, session) => made.server?.send(push, userId, session), name });
  const lore = new Lore(host, {
    persona: (userId, chatId) => turns.ofChat(userId, chatId)?.personaId,
    activatedBooks: (userId, chatId) => (turns.ofChat(userId, chatId)?.activated ?? []).flatMap((a) => a.bookId !== null ? [a.bookId] : [])
  });
  const presets = new Presets(host);
  const recall = new Recall(host, { chats, lore, activated: (userId, chatId, generationId) => turns.activatedInfo(userId, chatId, generationId), now });
  const copy = new CopyFeed(host, { relays, registry, chats, turns, ...options.ownElsewhere !== undefined ? { ownElsewhere: options.ownElsewhere } : {}, declinesLore: options.declinesLore === true, records: codec.reads ?? null, name });
  const live = new LiveBuffer(host, { now, transport: (userId) => settings.transport(userId), linkGoneFor: (userId, relay) => relays.goneFor(userId, relay), missing: () => permissions().some((need) => need.needed) });
  const keys = new Keys(host, { registry, relays, settings, connectionName: identity.connectionName, now, later });
  const claimer = options.extension;
  const chatSwitch = new ChatSwitch(host, {
    chats,
    connections,
    runtimeOf: relayOf,
    blocked,
    identity,
    now,
    storySetting: async (userId) => settingsOf((await settings.values(userId))[CORE_KEY]).story,
    ...claimer?.claim !== undefined ? {
      claim: async (ask, userId) => {
        try {
          const claim = await claimer.claim?.(ask, userId);
          return claim === null || claim === undefined ? null : { by: claimer.name, claim };
        } catch (error) {
          warn(`${claimer.name} gave no answer for chat ${ask.chatId}, so its claim on it isn't known`)(error);
          return { by: claimer.name, failed: wordsOf(error) };
        }
      }
    } : {}
  });
  made.chatSwitch = chatSwitch;
  const sessions = new SessionsPage({
    chats,
    storage,
    settings,
    now,
    name,
    later,
    settle: async (userId, chatId) => {
      if ((await relays.linked(userId)).length === 0)
        return false;
      await asks.ask(userId, "store.settle", {}, chatId === null ? {} : { chat: chatId });
      return true;
    }
  });
  const approvals = new Approvals({ id: () => randomHex(64) });
  const notices = new Notices(host, { now, id: () => randomHex(64), kept: async (userId) => (await settings.transport(userId)).pages.noticesKept });
  const jobs = new JobsBoard(notices, now, async (userId) => (await settings.transport(userId)).pages.noticeChars);
  const mcp = new Mcp(host, { on: (userId) => defs.mcpOn(userId), callMs: async (userId) => (await settings.transport(userId)).mcp.callMs, later, name, ...identity.settingsAt !== undefined ? { settingsAt: identity.settingsAt } : {} });
  const tools = new RemoteTools(options.tools, mcp, (level, message) => host.log(level, message));
  const timings = new Timings;
  const road = new ProxyRoad({
    host,
    declined,
    address: async (userId, relay) => {
      const held = (await registry.read(userId)).relays[relay];
      return held === undefined ? null : { listen: held.report?.listen ?? held.listen, port: held.report?.port ?? held.port };
    },
    transport: (userId) => settings.transport(userId),
    now,
    nonce: () => randomHex(128),
    isLinked: (userId, relay) => relays.isLinked(userId, relay),
    changed: (userId) => ui.touch(userId, "runtime"),
    name,
    ...identity.settingsAt !== undefined ? { settingsAt: identity.settingsAt } : {}
  });
  const asks = new Asks({
    relays,
    settings,
    onLoopback: async (userId, chatId) => (await connections.ofChat(userId, await chats.own(userId, chatId)))?.loopback === true,
    runOf: (userId, stream, turn) => live.running(userId, stream, turn)?.relay ?? null,
    jobOf: (userId, job) => jobs.runsIn(userId, job),
    runtimeOf: runtimeOf2,
    userRuntime: async (userId) => (await relays.linked(userId))[0]?.id ?? null,
    name,
    ...identity.settingsAt !== undefined ? { settingsAt: identity.settingsAt } : {},
    now,
    later,
    id: () => randomHex(64),
    road,
    timings
  });
  made.asks = asks;
  const forgotten = new Forgotten(host, { asks, isLinked: async (userId) => (await relays.linked(userId)).length > 0, now });
  const defs = new Definitions({ settings, asks, mcp, coreKey: CORE_KEY }, now);
  const issues = () => [
    ...host.capability("chat-lean-messages-v1") ? [] : ["This Lumiverse can't write an extension's own entry on a message, so no turn's record can be kept and the session won't carry from one reply to the next. Update Lumiverse."],
    ...host.capability("frontend-session-routing-v1") ? [] : ["This Lumiverse doesn't say which connection a message comes from, so no runtime can link. Update Lumiverse."]
  ];
  const ui = new Ui(host, {
    relays,
    registry,
    settings,
    streams,
    connections,
    chats,
    live,
    approvals,
    notices,
    asks,
    road,
    timings,
    jobs,
    defs,
    coreKey: CORE_KEY,
    switch: chatSwitch,
    turns,
    sessions,
    copy,
    keys,
    issues,
    permissions,
    now
  });
  const server = new LinkServer(host, {
    without: options.withoutAgents ?? [],
    relays,
    registry,
    settings,
    streams,
    turns,
    chats,
    chatSwitch,
    storage,
    mirror,
    lore,
    presets,
    recall,
    copy,
    connections,
    live,
    tools,
    approvals,
    asks,
    road,
    jobs,
    extension: options.extension,
    connectionMade: (userId, ref, connection, problem) => {
      keys.made(userId, ref, connection, problem);
      turns.unsure(userId);
      ui.touch(userId, "connections", "setup", "chats", "runtime");
      tellRuntime(userId);
    },
    now,
    later,
    build,
    identity
  });
  made.server = server;
  copy.start();
  relays.start();
  relays.onChange((userId) => {
    ui.touch(userId, "runtime", "setup", "connections", "chats");
    turns.unsure(userId);
    asks.recheck(userId);
    road.sweep(userId);
    forgotten.handOver(userId);
    tellRuntime(userId);
  });
  relays.onPing((userId, relay, named2) => {
    live.named(userId, relay, named2);
    forgotten.pinged(userId);
    mirror.pinged(userId, relay).catch(warn("a ping couldn't be noted for the runtime that keeps the storage"));
  });
  live.onChange((userId) => ui.touch(userId, "running", "chats", "setup"));
  approvals.onChange((userId) => ui.touch(userId, "approvals"));
  notices.onChange((userId) => ui.touch(userId, "notices"));
  jobs.onChange((userId) => ui.touch(userId, "jobs"));
  defs.onChange((userId) => ui.touch(userId, "defs"));
  live.onEnded((run) => approvals.dropRun(run.userId, run.turn, "The run this call belonged to is over."));
  settings.onChange((userId, revision) => {
    server.settingsChanged(userId);
    ui.touch(userId, "settings", "texts", "jobs", "defs");
    registry.read(userId).then((r) => {
      for (const relay of Object.keys(r.relays))
        relays.push(userId, relay, { link: LINK, type: "settings", revision });
    }).catch(warn("the runtimes weren't told of the new settings"));
  });
  host.onPermission(() => ui.touchAll("runtime", "permissions", "setup"));
  host.onPermission((permission, granted) => {
    if (permission === CORS_PROXY)
      road.permission(granted);
  });
  turns.onBegun((turn, facts) => {
    if (turn.relay !== null)
      live.begin(turn.userId, turn.relay, { stream: facts.chat, chatId: facts.chat, turn: facts.turn, kind: facts.kind, messageId: facts.target.message }).catch(warn("a turn's live view couldn't be started"));
  });
  turns.onStopped((turn, why) => {
    if (turn.relay !== null)
      relays.push(turn.userId, turn.relay, { link: LINK, type: "stop", turn: turn.turn, why, by: "lumiverse" });
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
    if (event.action !== "deleted")
      return;
    turns.swipeDeleted(event.chatId, event.messageId, event.swipeId);
    chats.swipeDeleted(event.chatId, event.messageId, event.swipeId).catch(warn("a deleted swipe's record couldn't be let go"));
  });
  host.events.onChatTouched((chatId, gone, userId) => {
    if (!gone) {
      chats.touched(chatId);
      return;
    }
    chats.dropped(chatId);
    if (userId !== null)
      forgotten.deleted(userId, chatId);
  });
  host.events.onChatChanged((_chatId, userId) => {
    if (userId === null)
      return;
    ui.touch(userId, "chats", "setup");
    turns.unsure(userId);
  });
  host.events.onSelectedConnection((userId) => {
    if (userId === null)
      return;
    ui.touch(userId, "chats", "setup");
    turns.unsure(userId);
  });
  host.registerInterceptor((input) => turns.intercept(input), { priority: INTERCEPTOR_PRIORITY, types: TAGGED_TYPES, required: false });
  host.frontend.onMessage((payload, userId, session) => {
    (async () => {
      if (await server.frame(payload, userId, session))
        return;
      await ui.message(payload, userId, session);
    })().catch(warn("a message couldn't be handled"));
  });
  host.frontend.onClosed((session) => {
    relays.sessionClosed(session);
    mirror.sessionClosed(session);
    live.sessionClosed(session);
    server.sessionClosed(session);
  });
  const downWords = (view, chatId) => {
    const refused2 = view.relays.find((r) => r.link === "refused" && r.problem !== null);
    if (refused2?.problem)
      return refused2.problem;
    if (view.relays.length === 0)
      return `No runtime is set up for ${name} yet. Start one with the line on ${name}'s Runtime page.`;
    const linked = view.relays.some((r) => r.link === "linked");
    if (chatId !== null && linked)
      return `The runtime this chat's replies reach isn't linked now. Start it again with its line on ${name}'s Runtime page.`;
    const unit = view.relays.find((r) => r.unit !== null)?.unit ?? null;
    const quiet = view.relays.some((r) => r.link === "quiet");
    return `${name}'s runtime ${quiet ? "has gone quiet" : "isn't linked now"}. Start it again${unit !== null ? ` (systemctl --user restart ${unit})` : ""} with its line on ${name}'s Runtime page.`;
  };
  const runtimeState = async (userId, chatId = null) => {
    const [view, loops] = await Promise.all([relays.view(userId, issues()), connections.loopbacks(userId)]);
    const linked = chatId !== null ? await runtimeOf2(userId, chatId) !== null : view.relays.some((r) => r.link === "linked");
    return { linked, ready: view.ready, connection: loops.length > 0, words: linked ? null : downWords(view, chatId), start: view.start };
  };
  return {
    async tick() {
      await relays.tick();
      streams.sweep();
      server.sweep();
      await turns.tick();
      await live.tick();
    },
    async settle() {
      await registry.settle();
      await settings.settle();
      await chatSwitch.settle();
      await open.settle();
      await forgotten.settle();
      await mirror.settle();
      await copy.settle();
      await ui.settle();
      await Promise.all(telling);
    },
    registry,
    settings,
    relays,
    streams,
    turns,
    live,
    chats,
    ui,
    server,
    approvals,
    notices,
    asks,
    jobs,
    defs,
    road,
    timings,
    agents: {
      held: async (userId, chatId) => heldView(await asks.ask(userId, "definitions.held", { chatId }, { chat: chatId }))
    },
    runtimeState,
    onRuntime(listener) {
      runtimeHeard.add(listener);
      return () => void runtimeHeard.delete(listener);
    }
  };
}

// src/extension/backend/spindle.ts
function str(o, key4) {
  if (!isRecord2(o))
    return;
  const v2 = o[key4];
  return typeof v2 === "string" ? v2 : undefined;
}
function num(o, key4) {
  if (!isRecord2(o))
    return;
  const v2 = o[key4];
  return typeof v2 === "number" && Number.isFinite(v2) ? v2 : undefined;
}
var strings4 = (v2) => Array.isArray(v2) ? v2.filter((s) => typeof s === "string") : [];
var MILLISECONDS_FROM = 100000000000;
function stampOf(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
    return null;
  return Math.floor(raw >= MILLISECONDS_FROM ? raw : raw * 1000);
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
function promptMessageOf(raw) {
  const flagged = raw;
  const index = flagged.sourceIndexInChat;
  const id2 = flagged.sourceMessageId;
  return { role: raw.role, text: partsText(raw.content), history: flagged.__isChatHistory === true, ...flagged.__isWorldInfoEntry === true ? { lore: true } : {}, ...typeof id2 === "string" ? { sourceId: id2 } : {}, ...typeof index === "number" ? { sourceIndex: index } : {} };
}
function messageOf(raw, identifier) {
  const id2 = str(raw, "id");
  if (!isRecord2(raw) || id2 === undefined)
    return null;
  const swipes = Array.isArray(raw.swipes) ? raw.swipes : [];
  const swipeId = num(raw, "swipe_id") ?? 0;
  const shown = swipes[swipeId];
  const metadata = isRecord2(raw.metadata) ? raw.metadata : isRecord2(raw.extra) && isRecord2(raw.extra.spindle_metadata) ? raw.extra.spindle_metadata : {};
  const own = metadata[identifier];
  return {
    id: id2,
    index: num(raw, "index_in_chat") ?? 0,
    role: raw.role === "system" || raw.role === "assistant" || raw.role === "user" ? raw.role : raw.is_user === true ? "user" : "assistant",
    name: str(raw, "name") ?? "",
    swipeId,
    swipes: Math.max(1, swipes.length),
    content: str(raw, "content") ?? (typeof shown === "string" ? shown : ""),
    hidden: raw.hidden === true,
    own: own === undefined ? null : toJson(own),
    at: stampOf(raw.send_date) ?? stampOf(raw.created_at)
  };
}
function entryOf(e) {
  return { id: e.id, bookId: e.world_book_id, title: e.comment, keys: [...e.key], secondaryKeys: [...e.keysecondary ?? []], content: e.content, enabled: !e.disabled, constant: e.constant };
}
function entryRecordOf(e) {
  const role = e.role;
  return {
    ...entryOf(e),
    vectorized: e.vectorized === true,
    regex: e.use_regex === true,
    role: role === "system" || role === "user" || role === "assistant" ? role : null,
    order: num(e, "order_value") ?? 0,
    updatedAt: stampOf(e.updated_at) ?? 0,
    extensions: toJsonObject(e.extensions)
  };
}
function spanOf(first, last) {
  return typeof first === "number" && typeof last === "number" && Number.isSafeInteger(first) && Number.isSafeInteger(last) && first >= 0 && last >= first ? [first, last] : null;
}
function memoryHitOf(raw) {
  if (!isRecord2(raw) || typeof raw.content !== "string")
    return null;
  const range = Array.isArray(raw.messageRange) ? raw.messageRange : [];
  const span = range[0] === 0 && range[1] === 0 ? null : spanOf(range[0], range[1]);
  return { source: raw.source === "consolidation" ? "arc" : "chunk", text: raw.content, score: num(raw, "finalScore") ?? 0, span, entities: strings4(raw.entityNames) };
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
var MCP_PAGE = 100;
var METADATA_TRIES = 4;
function databaseOf(entry, identifier) {
  if (typeof entry !== "string" || identifier === "")
    return null;
  for (const sep of ["/", "\\"]) {
    const at3 = entry.lastIndexOf(`${sep}extensions${sep}${identifier}${sep}repo${sep}`);
    if (at3 <= 0)
      continue;
    const data = entry.slice(0, at3);
    const absolute = sep === "/" ? data.startsWith("/") : /^(?:[A-Za-z]:|\\\\)/.test(data);
    return absolute ? `${data}${sep}lumiverse.db` : null;
  }
  return null;
}
function createSpindleHost(identifier = EXTENSION_IDENTIFIER) {
  const capabilities = spindle.host?.capabilities ?? {};
  const capability = (name) => (capabilities[name] ?? 0) >= 1;
  const lean = capability("chat-lean-messages-v1");
  const url = import.meta.url;
  const dir = url.startsWith("file://") ? decodeURIComponent(url.slice("file://".length).replace(/\/[^/]*$/, "")) : null;
  const embeddingsApi = () => capability("embeddings-v1") && isRecord2(spindle.embeddings) && spindle.permissions.has("embeddings") ? spindle.embeddings : null;
  const memoriesApi = () => isRecord2(spindle.memories) && spindle.permissions.has("memories") ? spindle.memories : null;
  const databanksApi = () => isRecord2(spindle.databanks) && spindle.permissions.has("databanks") ? spindle.databanks : null;
  const webApi = () => isRecord2(spindle.webSearch) && spindle.permissions.has("web_search") ? spindle.webSearch : null;
  async function bookEntries(bookId, userId) {
    if (!spindle.permissions.has("world_books"))
      return [];
    const out = [];
    for (let offset = 0;; offset += HOST_PAGE) {
      const page = await spindle.world_books.entries.list(bookId, { limit: HOST_PAGE, offset, userId });
      out.push(...page.data);
      if (page.data.length < HOST_PAGE || out.length >= page.total)
        return out;
    }
  }
  return {
    log(level, message) {
      if (level === "error")
        spindle.log.error(message);
      else if (level === "warn")
        spindle.log.warn(message);
      else
        spindle.log.info(message);
    },
    toast(userId, level, text7) {
      if (isRecord2(spindle.toast))
        spindle.toast[level](text7, { userId });
    },
    async closeDrawer(userId) {
      const ui = spindle.ui;
      if (!isRecord2(ui) || typeof ui.closeDrawer !== "function")
        return false;
      await spindle.ui.closeDrawer({ userId });
      return true;
    },
    granted: (permission) => spindle.permissions.has(permission),
    onPermission(handler) {
      spindle.permissions.onChanged((detail) => handler(detail.permission, detail.granted));
    },
    async cors(url2, init) {
      const raw = await spindle.cors(url2, { method: init.method, headers: init.headers, body: init.body });
      if (!isRecord2(raw) || typeof raw.status !== "number" || typeof raw.body !== "string")
        throw new Error("Lumiverse's proxy gave an answer that can't be read.");
      const headers = {};
      if (isRecord2(raw.headers)) {
        for (const [name, value] of Object.entries(raw.headers))
          if (typeof value === "string")
            headers[name.toLowerCase()] = value;
      }
      return { status: raw.status, headers, body: raw.body };
    },
    capability,
    install: { bun: typeof process.execPath === "string" && process.execPath.startsWith("/") ? process.execPath : null, dir },
    identifier,
    async role(userId) {
      const users = spindle.users;
      if (!isRecord2(users) || typeof users.getRole !== "function")
        return "user";
      const role = await spindle.users.getRole(userId);
      return role === "operator" || role === "admin" ? role : "user";
    },
    database: () => databaseOf(isRecord2(spindle.manifest) ? spindle.manifest.entry_backend : undefined, identifier),
    frontend: {
      send(message, userId, sessionId) {
        spindle.sendToFrontend(message, userId, sessionId !== undefined ? { frontendSessionId: sessionId } : undefined);
      },
      everyone(message) {
        spindle.sendToFrontend(message);
      },
      onMessage(handler) {
        spindle.onFrontendMessage(handler);
      },
      onClosed(handler) {
        spindle.on("FRONTEND_SESSION_CLOSED", (payload) => {
          const id2 = str(payload, "frontendSessionId");
          if (id2 !== undefined)
            handler(id2);
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
          handler({ generationId, chatId, userId: userId ?? null, messageId: str(p, "messageId") ?? null, content: str(p, "content") ?? null, error: str(p, "error") ?? null });
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
          const chatId = str(isRecord2(p) ? p.chat : undefined, "id") ?? str(p, "chatId");
          if (chatId !== undefined)
            handler(chatId, userId ?? null);
        });
      },
      onChatForked(handler) {
        spindle.on("CHAT_FORKED", (p, userId) => {
          const sourceChatId = str(p, "sourceChatId");
          const chatId = str(p, "forkedChatId");
          if (sourceChatId !== undefined && chatId !== undefined)
            handler({ sourceChatId, chatId, userId: userId ?? null });
        });
      },
      onChatTouched(handler) {
        for (const event of ["MESSAGE_SENT", "MESSAGE_EDITED", "MESSAGE_DELETED", "MESSAGE_SWIPED", "SWIPE_EDITED", "CHAT_CHANGED"]) {
          spindle.on(event, (p) => {
            const chatId = str(p, "chatId") ?? str(isRecord2(p) ? p.chat : undefined, "id");
            if (chatId !== undefined)
              handler(chatId, false, null);
          });
        }
        spindle.on("CHAT_DELETED", (p, userId) => {
          const chatId = str(p, "id") ?? str(p, "chatId");
          if (chatId !== undefined)
            handler(chatId, true, userId ?? null);
        });
      },
      onSelectedConnection(handler) {
        spindle.on("SETTINGS_UPDATED", (p, userId) => {
          const keys = isRecord2(p) ? Array.isArray(p.keys) ? p.keys : [p.key] : [];
          if (keys.includes("activeProfileId"))
            handler(userId ?? null);
        });
      },
      onLumiverse(names, handler) {
        for (const name of names)
          spindle.on(name, (payload, userId) => handler(name, payload, userId ?? null));
      }
    },
    registerInterceptor(handler, options) {
      let dispose = null;
      const register = () => {
        dispose?.();
        dispose = spindle.registerInterceptor(async (messages, context) => {
          const ctx = context;
          const chatId = str(ctx, "chatId");
          const userId = str(ctx, "userId");
          if (chatId === undefined || userId === undefined)
            return messages;
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
              if (entryId === undefined)
                return [];
              const source = str(e, "source");
              const score = num(e, "score");
              return [{ entryId, bookId: str(e, "bookId") ?? null, title: str(e, "comment") ?? "", ...source === "keyword" ? { how: "key" } : source === "vector" ? { how: "vector" } : {}, ...score !== undefined ? { score } : {} }];
            }),
            messages: messages.map(promptMessageOf),
            ...isRecord2(ctx) && ctx.signal instanceof AbortSignal ? { signal: ctx.signal } : {}
          });
          const parameters = verdict.parameters !== undefined && spindle.permissions.has("generation_parameters") ? verdict.parameters : undefined;
          if (verdict.messages !== undefined) {
            const sent2 = [];
            const breakdown = [];
            for (const slot of verdict.messages) {
              if ("keep" in slot) {
                const kept = messages[slot.keep];
                if (kept !== undefined)
                  sent2.push(kept);
                continue;
              }
              if (slot.label !== undefined)
                breakdown.push({ messageIndex: sent2.length, name: slot.label });
              sent2.push({ role: slot.role, content: slot.text });
            }
            return { messages: sent2, ...parameters ? { parameters } : {}, ...breakdown.length > 0 ? { breakdown } : {} };
          }
          const omit = new Set(verdict.omit ?? []);
          const sent = omit.size > 0 ? messages.filter((_, i) => !omit.has(i)) : messages;
          return parameters ? { messages: sent, parameters } : sent;
        }, { priority: options.priority, match: { generationTypes: options.types.filter((t) => t !== "other") }, required: options.required });
      };
      register();
      spindle.permissions.onChanged((detail) => {
        if (detail.permission === "interceptor" && detail.granted)
          register();
      });
    },
    connections: {
      async list(userId) {
        return (await spindle.connections.list(userId)).map((c) => ({ id: c.id, name: c.name, provider: c.provider, url: c.api_url, model: c.model, isDefault: c.is_default, metadata: toJsonObject(c.metadata) }));
      },
      async get(connectionId, userId) {
        const c = await spindle.connections.get(connectionId, userId);
        return c ? { id: c.id, name: c.name, provider: c.provider, url: c.api_url, model: c.model, isDefault: c.is_default, metadata: toJsonObject(c.metadata) } : null;
      },
      async active(userId) {
        const organization = spindle.connections.organization;
        if (organization === undefined)
          return;
        return (await organization.get({ kind: "llm", userId })).connections.find((c) => c.active)?.id ?? null;
      }
    },
    storage: {
      read: readOrNull,
      write: (path, text7, userId) => spindle.userStorage.write(path, text7, userId),
      remove: (path, userId) => spindle.userStorage.delete(path, userId),
      async stat(path, userId) {
        const stat = await spindle.userStorage.stat(path, userId);
        if (!stat.exists || !stat.isFile)
          return null;
        const at3 = Date.parse(stat.modifiedAt);
        return { bytes: stat.sizeBytes, writtenAt: Number.isFinite(at3) ? at3 : 0 };
      },
      async list(dir2, userId) {
        if (!await spindle.userStorage.exists(dir2, userId))
          return [];
        return (await spindle.userStorage.list(dir2, userId)).map((path) => path.replaceAll("\\", "/"));
      }
    },
    chats: {
      async get(chatId, userId) {
        const chat = await spindle.chats.get(chatId, userId);
        return chat ? { id: chat.id, name: chat.name, characterId: typeof chat.character_id === "string" && chat.character_id !== "" ? chat.character_id : null, metadata: toJsonObject(chat.metadata) } : null;
      },
      async patchMetadata(chatId, patch, userId) {
        const change = async () => {
          const chat = await spindle.chats.get(chatId, userId);
          if (!chat)
            throw new Error(`chat ${chatId} not found`);
          const metadata = { ...chat.metadata };
          for (const [key4, value] of Object.entries(patch)) {
            if (value === null)
              delete metadata[key4];
            else
              metadata[key4] = value;
          }
          return { read: chat.metadata, metadata };
        };
        if (!capability("chat-conditional-metadata-v1") || !spindle.permissions.has("chat_mutation")) {
          await spindle.chats.update(chatId, { metadata: (await change()).metadata }, userId);
          return;
        }
        for (let tries = 0;tries < METADATA_TRIES; tries++) {
          const { read: read2, metadata } = await change();
          if (await spindle.chats.compareAndSetMetadata(chatId, { expected_metadata: read2, metadata }, userId) !== null)
            return;
        }
        throw new Error(`Chat ${chatId}'s metadata kept changing while LumiAH wrote to it, so nothing was written: try again.`);
      },
      async messages(chatId, range) {
        const out = [];
        const take = (rows) => {
          for (const row of rows) {
            const m = messageOf(row, identifier);
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
      async swipe(chatId, messageId, swipe) {
        const textIn = (rows) => {
          const row = rows.find((r) => str(r, "id") === messageId);
          if (!isRecord2(row))
            return;
          const swipes = Array.isArray(row.swipes) ? row.swipes : [];
          const text7 = swipes[swipe];
          if (typeof text7 === "string")
            return text7;
          return swipes.length === 0 && swipe === (num(row, "swipe_id") ?? 0) ? str(row, "content") ?? null : null;
        };
        try {
          if (!lean)
            return textIn(await spindle.chat.getMessages(chatId)) ?? null;
          const whole7 = { includeExtra: false, ownMetadataOnly: true };
          const last = textIn(await spindle.chat.getMessages(chatId, { ...whole7, tail: 1 }));
          if (last !== undefined)
            return last;
          for (let offset = 0;; offset += MESSAGE_PAGE) {
            const rows = await spindle.chat.getMessages(chatId, { ...whole7, light: true, limit: MESSAGE_PAGE, offset });
            const at3 = rows.findIndex((row) => str(row, "id") === messageId);
            if (at3 >= 0)
              return textIn(await spindle.chat.getMessages(chatId, { ...whole7, limit: 1, offset: offset + at3 })) ?? null;
            if (rows.length < MESSAGE_PAGE)
              return null;
          }
        } catch {
          return null;
        }
      },
      async setOwn(chatId, messageId, value) {
        if (!lean)
          throw new Error("This Lumiverse can't write an extension's own entry on a message (it lacks chat-lean-messages-v1): update Lumiverse.");
        await spindle.chat.updateMessage(chatId, messageId, { ownMetadata: value });
      },
      async deleteMessage(chatId, messageId) {
        await spindle.chat.deleteMessage(chatId, messageId);
      },
      async list(userId, offset, limit2) {
        const page = await spindle.chats.list({ limit: limit2, offset, userId });
        const chats = page.data.map((chat) => ({ id: chat.id, name: chat.name, characterId: typeof chat.character_id === "string" && chat.character_id !== "" ? chat.character_id : null, metadata: toJsonObject(chat.metadata) }));
        return { chats, total: typeof page.total === "number" ? page.total : offset + chats.length };
      },
      async characterName(characterId, userId) {
        if (!spindle.permissions.has("characters"))
          return null;
        return (await spindle.characters.get(characterId, userId))?.name ?? null;
      },
      async sovereignHand() {
        return null;
      }
    },
    lore: {
      async book(bookId, userId) {
        if (!spindle.permissions.has("world_books"))
          return null;
        const b = await spindle.world_books.get(bookId, userId);
        return b ? { id: b.id, name: b.name, description: b.description ?? "" } : null;
      },
      entries: async (bookId, userId) => (await bookEntries(bookId, userId)).map(entryOf),
      async entry(entryId, userId) {
        if (!spindle.permissions.has("world_books"))
          return null;
        const e = await spindle.world_books.entries.get(entryId, userId);
        return e ? entryOf(e) : null;
      },
      async record(bookId, userId) {
        if (!spindle.permissions.has("world_books"))
          return null;
        const b = await spindle.world_books.get(bookId, userId);
        return b ? { id: b.id, name: b.name, description: b.description ?? "", metadata: toJsonObject(b.metadata), updatedAt: stampOf(b.updated_at) ?? 0 } : null;
      },
      records: async (bookId, userId) => (await bookEntries(bookId, userId)).map(entryRecordOf),
      async global(userId) {
        return spindle.permissions.has("world_books") ? spindle.world_books.getGlobal(userId) : [];
      },
      async ofCharacter(characterId, userId) {
        if (!spindle.permissions.has("characters"))
          return [];
        const c = await spindle.characters.get(characterId, userId);
        return c && Array.isArray(c.world_book_ids) ? c.world_book_ids.filter((id2) => typeof id2 === "string") : [];
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
        if (!spindle.permissions.has("presets"))
          return null;
        if (await spindle.presets.get(presetId, userId) === null)
          return null;
        return (await spindle.presets.blocks.list(presetId, userId)).map((b) => ({ id: b.id, name: b.name, role: roleOf(b.role), content: b.content, enabled: b.enabled, marker: typeof b.marker === "string" && b.marker !== "" ? b.marker : null }));
      },
      async active(chatId, userId) {
        if (!spindle.permissions.has("presets"))
          return null;
        const presets = spindle.presets;
        const getActive = isRecord2(presets) ? presets.getActive : undefined;
        if (typeof getActive !== "function")
          return null;
        const raw = await getActive.call(presets, chatId, userId);
        if (!isRecord2(raw))
          return null;
        const states = {};
        if (isRecord2(raw.block_states)) {
          for (const [id2, on] of Object.entries(raw.block_states))
            if (typeof on === "boolean")
              states[id2] = on;
        }
        return { presetId: typeof raw.preset_id === "string" ? raw.preset_id : null, states };
      }
    },
    mcp: {
      async servers(userId) {
        if (!isRecord2(spindle.mcp) || !spindle.permissions.has("mcp_servers"))
          return [];
        const out = [];
        for (let offset = 0;; offset += MCP_PAGE) {
          const page = await spindle.mcp.servers.list({ limit: MCP_PAGE, offset, userId });
          for (const s of page.data)
            out.push({ id: s.id, name: s.name, enabled: s.is_enabled, createdAt: s.created_at });
          if (page.data.length < MCP_PAGE || out.length >= page.total)
            return out;
        }
      },
      async tools(serverId, userId) {
        if (!isRecord2(spindle.mcp))
          throw new Error("This Lumiverse has no MCP servers.");
        let status = await spindle.mcp.servers.status(serverId, userId);
        if (!status.connected)
          status = await spindle.mcp.servers.connect(serverId, userId);
        if (!status.connected)
          throw new Error(status.error ?? "MCP connection failed");
        return status.tools.map((t) => ({ name: t.name, description: t.description, parameters: toJsonObject(t.input_schema) }));
      },
      call(serverId, tool, args, timeoutMs, userId) {
        if (!isRecord2(spindle.mcp))
          throw new Error("This Lumiverse has no MCP servers.");
        return spindle.mcp.tools.call(serverId, tool, args, { userId, timeoutMs });
      }
    },
    embeddings: {
      async connection(userId) {
        const api = embeddingsApi();
        if (api === null)
          return null;
        const main = (await api.listConnections({ userId })).find((c) => c.is_primary);
        return main !== undefined && main.enabled ? { id: main.id, name: main.name, model: main.model, dimensions: typeof main.dimensions === "number" ? main.dimensions : null } : null;
      },
      async embed(texts, kind, userId, signal) {
        const api = embeddingsApi();
        if (api === null)
          throw new Error(`There is no embedding connection to use: this Lumiverse embeds nothing for an extension, or the "embeddings" permission isn't granted.`);
        const out = await api.embed({ texts: [...texts], input_type: kind === "query" ? "query" : "passage", userId }, signal !== undefined ? { signal } : undefined);
        return { vectors: out.embeddings, model: out.model, dimensions: out.dimensions };
      }
    },
    memory: {
      async enabled(userId) {
        const api = memoriesApi();
        return api !== null && (await api.cortex.getConfig(userId)).enabled === true;
      },
      async search(chatId, query, options, userId) {
        const api = memoriesApi();
        if (api === null || options.limit < 1)
          return [];
        const found = await api.cortex.query({ chatId, queryText: query, topK: options.limit, ...options.entities !== undefined && options.entities.length > 0 ? { entityFilter: [...options.entities] } : {}, includeConsolidations: true, includeRelationships: false, userId });
        const memories = isRecord2(found) && Array.isArray(found.memories) ? found.memories : [];
        return memories.flatMap((m) => {
          const hit = memoryHitOf(m);
          return hit === null ? [] : [hit];
        }).slice(0, options.limit);
      },
      async entity(chatId, name, userId) {
        const api = memoriesApi();
        if (api === null)
          return null;
        const found = await api.entities.findByName(chatId, name, userId);
        if (!found)
          return null;
        const [facts, edges] = await Promise.all([api.entities.getFacts(found.id, userId), api.relations.forEntity(chatId, found.id, userId)]);
        const ends = edges.map((edge) => ({ edge, other: edge.sourceEntityId === found.id ? edge.targetEntityId : edge.sourceEntityId }));
        const names = new Map;
        await Promise.all([...new Set(ends.map((end) => end.other))].map(async (id2) => void names.set(id2, (await api.entities.get(id2, userId))?.name ?? null)));
        const relations = ends.flatMap(({ edge, other }) => {
          const target = names.get(other);
          return target ? [{ target, type: edge.relationType, label: edge.relationLabel ?? null, strength: edge.strength, sentiment: edge.sentiment }] : [];
        });
        relations.sort((a, b) => b.strength - a.strength);
        return { id: found.id, name: found.name, type: found.entityType, aliases: strings4(found.aliases), description: found.description ?? "", status: found.status, facts: strings4(facts), mentions: found.mentionCount, lastSeenAt: stampOf(found.lastSeenAt), relations };
      },
      async entities(chatId, limit2, userId) {
        const api = memoriesApi();
        if (api === null || limit2 < 1)
          return [];
        return (await api.entities.list(chatId, { limit: limit2, userId })).slice(0, limit2).map((e) => ({ name: e.name, type: e.entityType, mentions: e.mentionCount }));
      },
      async arcs(chatId, userId) {
        const api = memoriesApi();
        if (api === null)
          return [];
        return (await api.consolidations.list(chatId, { userId })).map((c) => ({ id: c.id, tier: c.tier, title: c.title ?? null, summary: c.summary, span: spanOf(c.messageRangeStart, c.messageRangeEnd), at: stampOf(c.createdAt) ?? 0 }));
      }
    },
    databanks: {
      async list(userId) {
        const api = databanksApi();
        if (api === null)
          return [];
        const out = [];
        for (let offset = 0;; offset += HOST_PAGE) {
          const page = await api.list({ limit: HOST_PAGE, offset, userId });
          for (const d of page.data)
            out.push({ id: d.id, name: d.name, description: d.description ?? "", scope: d.scope, scopeId: d.scope_id ?? null, enabled: d.enabled === true, documents: d.document_count ?? 0 });
          if (page.data.length < HOST_PAGE || out.length >= page.total)
            return out;
        }
      },
      async ofCharacter(characterId, userId) {
        if (!spindle.permissions.has("characters"))
          return [];
        const extensions = (await spindle.characters.get(characterId, userId))?.extensions;
        return isRecord2(extensions) ? strings4(extensions.databank_ids).filter((id2) => id2 !== "") : [];
      },
      async documents(databankId, userId) {
        const api = databanksApi();
        if (api === null)
          return [];
        const out = [];
        for (let offset = 0;; offset += HOST_PAGE) {
          const page = await api.documents.list(databankId, { limit: HOST_PAGE, offset, userId });
          for (const d of page.data)
            out.push({ id: d.id, databankId: d.databank_id, name: d.name, version: `${d.content_hash}:${d.updated_at}`, bytes: typeof d.file_size === "number" && d.file_size >= 0 ? d.file_size : null, status: d.status });
          if (page.data.length < HOST_PAGE || out.length >= page.total)
            return out;
        }
      },
      async content(documentId, userId) {
        const api = databanksApi();
        if (api === null)
          return null;
        return (await api.documents.getContent(documentId, userId))?.content ?? null;
      }
    },
    web: {
      async enabled(userId) {
        const api = webApi();
        return api !== null && (await api.getSettings(userId)).enabled === true;
      },
      async search(query, options, userId) {
        const api = webApi();
        if (api === null)
          return [];
        const out = await api.query({ query, count: options.count, scrape: options.pages, userId });
        const pages = new Map;
        for (const page of out.documents ?? [])
          if (typeof page.content === "string" && page.content !== "")
            pages.set(page.url, page.content);
        return out.results.slice(0, Math.max(0, options.count)).map((r) => {
          const content = pages.get(r.url);
          return { title: r.title, url: r.url, snippet: r.snippet, ...content !== undefined ? { content } : {} };
        });
      }
    }
  };
}

// src/extension/backend/main.ts
var BUILD = "37c8906d";
var RUNTIME_SHA256 = "f0851f0ba88537da2d6edeb05ebeda94d56449ac009fcf77b1f96558686ceb58";
var RUNTIME_SIZE = "4648892";
var TICK_MS = 1000;
var host = createSpindleHost();
var backend = createBackend(host, {
  now: () => Date.now(),
  later: (ms2, fn) => {
    const timer = setTimeout(fn, ms2);
    return () => clearTimeout(timer);
  },
  build: BUILD,
  runtime: { sha256: RUNTIME_SHA256, size: Number(RUNTIME_SIZE) }
});
setInterval(() => {
  backend.tick().catch((error) => host.log("warn", `[LumiAH] the backend's tick failed: ${error instanceof Error ? error.message : String(error)}`));
}, TICK_MS);
host.log("info", `[LumiAH] backend ${BUILD} started`);
