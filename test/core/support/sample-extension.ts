// A sample extension that builds LumiAH into itself (DESIGN §21): the tide keeper of a harbour. It
// supplies one of each thing an extension may, so the core's tests exercise that whole surface
// without any real extension. It is also the example an extension's author reads, so it takes only
// what the core's public surface gives (`src/core/index.ts`).
//
// What it supplies, and where each goes:
// - `tools`: its own tools, which run in its backend. The host's `tools` port lists them and runs
//   their calls (`host.tools = sample.tools`). `harbour_tides` is its own. `lore_search` bears the
//   name of one of LumiAH's and stands in for it in the chats this extension claims, and nowhere
//   else: the core decides that, so the port lists both tools for every chat.
// - `extension`: what `createHarness` is handed. Its agent definitions and its skill; what it
//   supplies for a chat it claims (the agent that answers, a level of guidance, the tool of
//   LumiAH's it withdraws); its rewrite of the writer's request; and its hooks on a run.
// - `anchor`: for a host whose messages carry this extension's own record (`host.anchorCodec`).
//   LumiAH's record is folded into the harbour's log entry, so a reply has one record and not two.
// - `seen`: everything it was asked and told, in order, for a test to read.

import { type AgentDefinition, type ChatInfo, type HarnessExtension, isRecord, type JsonObject, type JsonValue, newAgentSettings, type RemoteTool, type RemoteToolCall, type ReplyWritten, type RunBegan, type RunEnded, type Skill, type StorySetting, type ToolsPort, type WriterRequest } from "../../../src/core/index";

/** What the sample is made of, by name. */
export const HARBOUR = {
  name: "Tide keeper",
  /** It claims the chats whose id starts so. */
  chats: "harbour-",
  /** Its main agent, which answers the chats it claims, and its worker, which any agent may delegate to. */
  keeper: "harbour_keeper",
  reader: "tide_reader",
  skill: "harbour_log",
  /** Its own tool and that tool's family, the built-in whose name its second tool bears, and the built-in it withdraws from its chats. */
  tides: "harbour_tides",
  family: "harbour",
  search: "lore_search",
  withdrawn: "lore_grep",
  /** Its level of guidance, as agents are told whose words they are: kept as a file of the user's area, or as a text of its own. */
  guidance: { name: "for every chat at this harbour", path: "~/harbour/GUIDANCE.md", text: "Tell the hour by the customs house clock, never by the light." },
  /** What it puts first among the messages the writer is sent. */
  almanac: "[Harbour almanac] High water at 06:10 and 18:40. Okoro lights the lamp at dusk.",
} as const;

export const KEEPER: AgentDefinition = {
  ...newAgentSettings(),
  id: HARBOUR.keeper,
  name: "Harbour keeper",
  description: "Answers a chat set at the harbour: gets the tides, the berths and the lamp right, then briefs the writer.",
  instructions: "You keep the harbour's log behind a roleplay chat set at the harbour. Before each reply, find what it needs in the tide table (harbour_tides) and the harbour's ledger (lore_search), then call write_reply with a brief.",
  given: "request",
  tools: [`@${HARBOUR.family}`, "@lore", "chat_read", "skill_load", "delegate", "agent_message", "write_reply"],
};

export const READER: AgentDefinition = {
  ...newAgentSettings(),
  id: HARBOUR.reader,
  name: "Tide reader",
  description: "Reads the tide table for a day and says when the water turns.",
  instructions: "You read tide tables for another agent. Call harbour_tides for the day your task names, and answer with the times alone.",
  given: "task",
  tools: [`@${HARBOUR.family}`, HARBOUR.search, HARBOUR.withdrawn],
};

export const LOG_SKILL: Skill = {
  id: HARBOUR.skill,
  name: "Harbour log",
  description: "How a ship's arrival is entered in the harbour's log.",
  body: ["1. Note the hour by the customs house clock.", "2. Name the ship, her master and her berth.", "3. Say what she carries, and what she owes the harbour."].join("\n"),
};

/** Its own tool: it acts outside LumiAH, so it is `external`. As LumiAH ships its calls run without a word, since the user installed the extension; they wait for the user's word once Settings say external tools ask first. */
export const TIDES: RemoteTool = {
  name: HARBOUR.tides,
  family: HARBOUR.family,
  tier: "external",
  description: "The harbour's tide table for a day: when the water is high and when it is low.",
  parameters: { type: "object", properties: { day: { type: "string", description: "The day, as the chat names it. Leave it out for today." } } },
  source: "extension",
};

/** Its search, under the built-in's name and in the built-in's family, with rules of its own: it reads the harbour's ledger and nothing else. */
export const SEARCH: RemoteTool = {
  name: HARBOUR.search,
  family: "lore",
  tier: "read",
  description: "Search the harbour's ledger by words: its ships, its berths and what is owed. Nothing outside the harbour is in it.",
  parameters: { type: "object", properties: { query: { type: "string", description: "The words to look for." } }, required: ["query"] },
  source: "extension",
};

const LEDGER: readonly string[] = ["Berth 1: the Gannet, Brann's boat, home from the banks with herring.", "Berth 2: empty since Ilse sold the Petrel.", "The lamp: Okoro lights it at dusk and owes the chandler for oil."];

/** One tool call, run in the extension's backend. */
function serve(call: RemoteToolCall): { text: string; error?: boolean } {
  if (call.name === HARBOUR.tides) return { text: `Tide table for ${typeof call.args.day === "string" ? call.args.day : "today"}: high water at 06:10 and 18:40, low water at 12:25.` };
  if (call.name === HARBOUR.search) {
    const query = typeof call.args.query === "string" ? call.args.query : "";
    const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
    const lines = LEDGER.filter((line) => words.some((word) => line.toLowerCase().includes(word)));
    return { text: [`The harbour's ledger has ${lines.length} of its ${LEDGER.length} lines for “${query}”.`, ...lines.map((line) => `- ${line}`)].join("\n") };
  }
  return { text: `The harbour has no tool ${call.name}.`, error: true };
}

/** The harbour's own record on a message: its log entry, numbered as they were written, with LumiAH's record inside it. */
const LOG_ENTRY = "harbour_log";

/** What the extension was asked and told. */
export interface Seen {
  /** Each hook, in the order it was called, with what it was called with. */
  hooks: ({ hook: "runBegan"; told: RunBegan } | { hook: "replyWritten"; told: ReplyWritten } | { hook: "runEnded"; told: RunEnded })[];
  /** Each tool call its backend served. */
  calls: RemoteToolCall[];
  /** Each chat it was asked about. */
  claims: ChatInfo[];
  /** Whom each call of a member was said to be for, in the order the calls came: the user, and the chat where the call was about one. */
  asks: { member: string; userId: string; chatId: string | null }[];
  /** Each writer's request it was handed to rewrite. */
  writer: WriterRequest[];
}

/** How the sample keeps its level of guidance: as a file of the user's area (`path`, which the user edits on the page like any other), or as a text of its own. */
export interface SampleOptions {
  guidance?: "path" | "text";
  /** Its word on what counts as the story in the chats it claims; none where absent. */
  story?: Partial<StorySetting>;
}

export interface SampleExtension {
  extension: HarnessExtension;
  tools: ToolsPort;
  anchor: { read(stored: JsonValue): JsonValue | null; write(record: JsonValue, stored: JsonValue | null): JsonValue };
  seen: Seen;
}

export function sampleExtension(options: SampleOptions = {}): SampleExtension {
  const seen: Seen = { hooks: [], calls: [], claims: [], asks: [], writer: [] };
  const { name, path, text } = HARBOUR.guidance;
  let entries = 0;
  return {
    seen,
    extension: {
      name: HARBOUR.name,
      async definitions(ask) {
        seen.asks.push({ member: "definitions", userId: ask.userId, chatId: ask.chatId });
        return { agents: [KEEPER, READER], skills: [LOG_SKILL] };
      },
      async claim(ask) {
        seen.asks.push({ member: "claim", userId: ask.userId, chatId: ask.chatId });
        seen.claims.push(ask.chat);
        if (!ask.chat.id.startsWith(HARBOUR.chats)) return null;
        return { mainAgent: HARBOUR.keeper, guidance: options.guidance === "text" ? { name, text } : { name, path }, withdraw: [HARBOUR.withdrawn], ...(options.story ? { story: options.story } : {}) };
      },
      async writerRequest(request) {
        seen.asks.push({ member: "writerRequest", userId: request.userId, chatId: request.chatId });
        seen.writer.push(request);
        // The almanac goes first, where a harbour's preset keeps its world; what the core built follows as it came, the brief where Settings put it.
        return [{ role: "system", content: HARBOUR.almanac }, ...request.messages];
      },
      runBegan: async (run) => void seen.hooks.push({ hook: "runBegan", told: run }),
      replyWritten: async (reply) => void seen.hooks.push({ hook: "replyWritten", told: reply }),
      runEnded: async (run) => void seen.hooks.push({ hook: "runEnded", told: run }),
    },
    tools: {
      list: async () => [TIDES, SEARCH],
      async call(call) {
        seen.calls.push(call);
        return serve(call);
      },
    },
    anchor: {
      read: (stored) => (isRecord(stored) && stored.kind === LOG_ENTRY ? ((stored.lumiah ?? null) as JsonValue | null) : null),
      // A message that already bears a log entry keeps it: only LumiAH's record inside it is replaced (a job that ends later is written into its turn's record).
      write: (record, stored) => ({ ...(isRecord(stored) && stored.kind === LOG_ENTRY ? (stored as JsonObject) : { kind: LOG_ENTRY, entry: ++entries }), lumiah: record }),
    },
  };
}
