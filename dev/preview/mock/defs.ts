// The stand-in backend's definitions (DESIGN §13, §16, §17): the agents, the skills, the tools and
// the MCP servers the Library pages show, and what each tier's calls do. The core's three agents
// are the core's real ones; an extension adds an agent, a skill and a tool; the user has agents and
// a skill of their own, and a writer of theirs that stands over the built-in one. Every change the
// pages make is kept for as long as the page lives, and moves the state's counter as the real
// backend's does.

import { type AgentDefinition, baseAgents } from "../../../src/core/agents";
import { checkAgent } from "../../../src/core/definitions";
import { ADDED_TOOLS } from "../../../src/core/settings";
import { TEXT_DEFS } from "../../../src/core/texts";
import { BASE_TOOLS } from "../../../src/core/tools/base";
import { approvalSettingPath } from "../../../src/extension/frontend/defs-model";
import { valueAt } from "../../../src/extension/frontend/settings-model";
import { type AgentView, type ApprovalChoice, type DefinitionSource, type DefsView, isRecord, type JsonObject, type JsonValue, type McpServerView, type Skill, type SkillView, type ToolRow, type ToolTier, type UiProblem } from "../../../src/shared/ui";
import { type Handlers, type MockCtx, Refusal } from "./ctx";

type Requests = "lah.defs.get" | "lah.agent.save" | "lah.skill.save" | "lah.def.remove" | "lah.def.switch" | "lah.tool.approval" | "lah.tier.approval";

// The schema of what an agent is given and runs with, written as the core writes an agent's
// settings (src/core/settings.ts): the dialect the Settings form reads.
const limit = (title: string, description: string, unit: string, minimum = 1): JsonObject => ({ title, description, type: ["integer", "null"], minimum, "x-unit": unit, "x-none": "No limit" });
const whole = (title: string, description: string, minimum: number, unit: string): JsonObject => ({ title, description, type: "integer", minimum, "x-unit": unit });
const choice = (title: string, description: string, options: readonly (readonly [value: string, title: string, description?: string])[]): JsonObject => ({ title, description, type: "string", oneOf: options.map(([value, name, about]) => ({ const: value, title: name, ...(about !== undefined ? { description: about } : {}) })) });

function agentSchema(tools: readonly string[]): JsonObject {
  return {
    title: "Runs with",
    description: "What this agent is given, and what it runs with unless Settings say otherwise.",
    type: "object",
    properties: {
      given: choice("Given", "What it is handed when another agent starts it.", [
        ["request", "The whole request", "The request the turn answers (the chat as Lumiverse assembled it), along with its task."],
        ["task", "Only its task", "Its task alone. What it needs of the chat it reads with its tools."],
      ]),
      connectionId: { title: "Connection", description: "The connection its calls go on. Never the loopback connection: its calls would come back to LumiAH.", type: ["string", "null"], format: "connection", "x-none": "Your default connection" },
      model: { title: "Model", description: "A model of that connection to use instead of the connection's own.", type: ["string", "null"], format: "model", "x-none": "The connection's own" },
      effort: choice("Effort", "How hard its model reasons on each call.", [
        ["inherit", "As the connection has it", "The connection's own reasoning setting, else yours in Lumiverse."],
        ["off", "Off"],
        ["auto", "Set by the model", "For a model that chooses its own effort."],
        ["minimal", "Minimal"],
        ["low", "Low"],
        ["medium", "Medium"],
        ["high", "High"],
        ["xhigh", "Extra high"],
        ["max", "Maximum"],
      ]),
      toolCalls: choice("Tool calls", "How its tools are offered to its model.", [
        ["auto", "Native, else as text", "Native tool calls where the connection takes them; once it refuses them, the tools are described in the prompt and the model writes its calls."],
        ["native", "Native only", "Always native tool calls. A connection that refuses them fails the call."],
        ["text", "As text", "The tools are described in the prompt and the model writes its calls."],
      ]),
      tools: { title: "Tools", description: "The tools it is given: each by its name, or @family for every tool of a family, those added to it later too. scratch_read comes with any of them, for results that come back clipped.", type: "array", items: { type: "string", enum: [...tools] }, uniqueItems: true },
      budget: {
        title: "Budget",
        description: "What this agent may spend on one message it is sent. A limit that stops it says so in the live view.",
        type: "object",
        properties: {
          callTokensIn: limit("Prompt per call", "The most one call may send, in tokens, as estimated before it is sent. A call past it isn't made.", "tokens"),
          callTokensOut: whole("Answer per call", "The most one call may write, its reasoning included (max_tokens).", 1, "tokens"),
          callMs: limit("Time per call", "How long one call may take before it is given up.", "ms"),
          callTools: limit("Tool calls per answer", "The most tools one answer may call. Calls past it aren't run, and the model is told.", "calls"),
          tokensIn: limit("Prompt tokens per agent", "The most all of its calls may send.", "tokens"),
          tokensOut: limit("Answer tokens per agent", "The most all of its calls may write.", "tokens"),
          toolTurns: limit("Tool rounds per agent", "The most answers that call tools. Past it the agent is stopped.", "rounds", 0),
          wallMs: limit("Time per agent", "How long it may work from the moment it is sent its first message.", "ms"),
          revisions: whole("Revisions", "Messages it may be sent after its first answer.", 0, "messages"),
          concurrency: whole("Tool calls at once", "How many of one answer's tool calls run at the same time.", 1, "calls"),
        },
      },
    },
  };
}

/** What the schema refuses of a value, as the settings' own check says it: where, and why. */
function refusedBy(schema: JsonObject, value: unknown, path: (string | number)[]): UiProblem[] {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === undefined) return [{ path, message: "It is missing." }];
  if (value === null) return types.includes("null") ? [] : [{ path, message: "It can't be none." }];
  if (Array.isArray(schema.oneOf)) return schema.oneOf.some((o) => isRecord(o) && o.const === value) ? [] : [{ path, message: `It must be one of: ${schema.oneOf.map((o) => (isRecord(o) ? String(o.const) : "")).join(", ")}.` }];
  if (isRecord(schema.properties)) {
    if (!isRecord(value)) return [{ path, message: "It must be a group of values." }];
    return Object.entries(schema.properties).flatMap(([key, node]) => refusedBy(node as JsonObject, value[key], [...path, key]));
  }
  if (types.includes("array")) {
    if (!Array.isArray(value)) return [{ path, message: "It must be a list." }];
    const allowed = isRecord(schema.items) && Array.isArray(schema.items.enum) ? schema.items.enum : null;
    return value.flatMap((item, i): UiProblem[] => {
      if (allowed !== null && !allowed.includes(item as JsonValue)) return [{ path: [...path, i], message: `There is no tool or family named "${String(item)}".` }];
      return value.indexOf(item) !== i ? [{ path: [...path, i], message: "It is listed twice." }] : [];
    });
  }
  if (types.includes("integer")) {
    if (typeof value !== "number" || !Number.isInteger(value)) return [{ path, message: "It must be a whole number." }];
    return typeof schema.minimum === "number" && value < schema.minimum ? [{ path, message: `It can't be under ${schema.minimum}.` }] : [];
  }
  return typeof value === "string" ? [] : [{ path, message: "It must be text." }];
}

type ToolSeed = readonly [name: string, family: string, tier: ToolTier, runs: ToolRow["runs"], description: string, parameters: JsonObject];

const text = (description: string): JsonObject => ({ type: "string", description });
const int = (description: string, minimum = 1): JsonObject => ({ type: "integer", minimum, description });
const args = (properties: Record<string, JsonObject>, required: string[] = []): JsonObject => ({ type: "object", properties, required, additionalProperties: false });

// What a model is told of each of the core's tools, and the arguments it takes, by the tool's real
// name. Which tools there are, and each one's family and tier, is the core's own registry's to say
// (`BASE_TOOLS`), so the preview lists a tool the day the core gains it; the registry writes a
// tool's words only for a run, so the preview keeps words of its own here, and a tool that has
// none yet shows with the core's own text for it (`tool.<name>`: what the model is offered).
const TOLD: Readonly<Record<string, readonly [description: string, parameters: JsonObject]>> = {
  chat_search: ["Finds the chat's messages that best match one or several queries, by word and, where the user has it, by meaning.", args({ queries: { type: "array", items: { type: "string" }, description: "What to look for, in plain words: one or several at once." }, limit: int("How many messages to return at most.") }, ["queries"])],
  chat_grep: ["Finds the chat's messages that hold a word or match a pattern.", args({ pattern: text("The words, or a regular expression."), speaker: text("Only messages of this speaker.") }, ["pattern"])],
  chat_read: ["Reads a span of the chat's messages by their numbers.", args({ from: int("The first message's number.", 0), to: int("The last message's number.", 0) }, ["from", "to"])],
  chat_around: ["Reads the messages around one message of the chat.", args({ message: text("The message: its number, or its citation."), before: int("How many messages before it.", 0), after: int("How many after it.", 0) }, ["message"])],
  chat_outline: ["Gives the story as a table of contents, with the messages each part spans.", args({})],
  chat_about: ["Follows a name or a phrase through the chat: where it first and last appears, how often, and its most telling lines in order.", args({ name: text("The name or the phrase.") }, ["name"])],
  book_outline: ["Gives the chat's book as a tree (volumes, arcs and chapters, each with the messages it spans) and says which messages no chapter covers.", args({})],
  book_read: ["Reads an entry of the chat's book: a chapter's or an arc's summary.", args({ id: text("The entry's id, as the outline gives it.") }, ["id"])],
  lore_index: ["Lists every entry of the chat's world books: its title, keys, size, book and state (in the prompt, always on, switched off).", args({ state: text("Only entries in this state."), book: text("Only this book."), text: text("Only entries whose title or keys hold this.") })],
  lore_search: ["Finds the lore entries that best match one or several queries, over titles, keys and text, each hit with its best lines and why it matched.", args({ queries: { type: "array", items: { type: "string" }, description: "What to look for, in plain words: one or several at once." }, limit: int("How many entries to return for each query at most.") }, ["queries"])],
  lore_grep: ["Finds the lore entries that hold a word or match a pattern.", args({ pattern: text("The words, or a regular expression.") }, ["pattern"])],
  lore_read: ["Reads lore entries whole, several in one call.", args({ ids: { type: "array", items: { type: "string" }, description: "The ids of the entries to read." } }, ["ids"])],
  lore_related: ["Follows one hop of the lore's own links: the entries that mention this entry's title or keys, and the entries it mentions.", args({ id: text("The entry's id.") }, ["id"])],
  lore_about: ["Gives everything the books hold on a name: the entries titled or keyed with it, then the entries that mention it.", args({ name: text("The name.") }, ["name"])],
  active_lore: ["Lists the lore entries Lumiverse put in this turn's prompt.", args({})],
  preset_instructions: ["Reads what the active preset tells the writer.", args({})],
  past_turn: ["Reads what the agent did in an earlier turn of this chat: its calls and its conclusions.", args({ turn: int("The turn's number, counted from the chat's first.") }, ["turn"])],
  workspace_list: ["Lists the files of a workspace area, with their sizes and when each last changed.", args({ path: text("A folder to list. Left out: the chat's area."), area: { type: "string", enum: ["chat", "learned", "home"], description: "The area to list." } })],
  workspace_read: ["Reads a workspace file, whole or a span of its lines.", args({ path: text("The file's path."), from: int("The first line to read."), lines: int("How many lines to read.") }, ["path"])],
  workspace_grep: ["Finds the lines of workspace files that hold a word or match a pattern.", args({ query: text("The words, or a regular expression."), path: text("Only files under this folder.") }, ["query"])],
  workspace_write: ["Writes a workspace file whole, making it or replacing what it held.", args({ path: text("The file's path."), text: text("What the file holds from now on.") }, ["path", "text"])],
  workspace_edit: ["Replaces a span of text in a workspace file.", args({ path: text("The file's path."), find: text("The text as it stands, exactly."), replace: text("The text to put in its place."), all: { type: "boolean", description: "Replace every place it stands, not only the first." } }, ["path", "find", "replace"])],
  workspace_move: ["Moves or renames a workspace file.", args({ from: text("The file's path now."), to: text("Its path from now on.") }, ["from", "to"])],
  workspace_delete: ["Deletes a workspace file. Its versions are kept for as long as upkeep keeps them.", args({ path: text("The file's path.") }, ["path"])],
  workspace_pin: ["Pins a workspace file, so every agent of the chat is given it each turn, or lets it go.", args({ path: text("The file's path."), pinned: { type: "boolean", description: "Pinned, or let go." } }, ["path", "pinned"])],
  skill_load: ["Returns the body of a skill: a procedure to follow.", args({ skill: text("The skill's id, as the prompt lists it.") }, ["skill"])],
  delegate: ["Starts a registered agent as a sub-agent on a task. Its answer is this call's result.", args({ agent: text("The agent's id."), task: text("What it is to do, in full: it knows nothing else."), files: { type: "array", items: { type: "string" }, description: "Workspace files it is handed with its task." } }, ["agent", "task"])],
  agent_message: ["Says something more to a sub-agent started this turn, and returns what it answers.", args({ handle: text("The handle delegate gave."), text: text("What to tell it.") }, ["handle", "text"])],
  job_start: ["Starts an agent on a task that outlives the reply. Its report is given at the next turn.", args({ agent: text("The agent's id."), task: text("What it is to do, in full."), when: { type: "string", enum: ["now", "after_reply"], description: "Start at once, or once the reply is written." } }, ["agent", "task"])],
  job_list: ["Lists this chat's jobs and how each stands.", args({ state: { type: "string", enum: ["queued", "running", "done", "failed", "cancelled"], description: "Only jobs that stand so." } })],
  job_read: ["Reads a job's report.", args({ job: text("The job's id.") }, ["job"])],
  job_cancel: ["Cancels a job that hasn't ended.", args({ job: text("The job's id."), reason: text("Why, for its record.") }, ["job"])],
  write_reply: ["Hands the writer a brief and has it write the reply, and says which lore entries to add to what the writer sees and which to drop. Only the main agent is offered it.", args({ brief: text("What the reply must do, and what the writer must know to do it."), add: { type: "array", items: { type: "string" }, description: "Lore entries to add to what the writer sees, by id." }, drop: { type: "array", items: { type: "string" }, description: "Lore entries to take out of what the writer sees, by id." } }, ["brief"])],
  chronicle_check: ["Lists the chronicle's lines whose cited messages are gone or have changed.", args({})],
};

/** The families whose tools read Lumiverse itself (the chat, its book, its lore, its preset, its memory, its databanks, the search it is set up with): they run in the extension, where Lumiverse is; the rest run beside the agent. */
const IN_EXTENSION: Readonly<Record<string, true>> = { chat: true, book: true, lore: true, preset: true, memory: true, databanks: true, web: true };

/** The core's tools as its registry has them, in its order, each with what the preview says of it. */
const CORE_TOOLS: readonly ToolSeed[] = BASE_TOOLS.map((tool) => {
  const told = Object.hasOwn(TOLD, tool.name) ? TOLD[tool.name] : undefined;
  const offered = TEXT_DEFS.find((d) => d.id === `tool.${tool.name}`)?.text;
  return [tool.name, tool.family, tool.tier, IN_EXTENSION[tool.family] === true ? "extension" : "runtime", told?.[0] ?? offered ?? `One of the core's ${tool.family} tools.`, told?.[1] ?? args({})];
});

const EXTENSION_TOOLS: readonly ToolSeed[] = [["chart_route", "charts", "external", "extension", "Draws a route between two places on the harbour chart and says what lies along it.", args({ from: text("Where the route starts."), to: text("Where it ends."), avoid: { type: "array", items: { type: "string" }, description: "Places to keep clear of." } }, ["from", "to"])]];

interface Server {
  id: string;
  name: string;
  status: McpServerView["status"];
  problem?: string;
  tools: readonly (readonly [name: string, description: string, parameters: JsonObject])[];
}

const SERVERS: readonly Server[] = [
  {
    id: "tides",
    name: "Tide tables",
    status: "ready",
    tools: [
      ["tide_times", "The high and low waters of a day at the harbour.", args({ date: text("The day, as YYYY-MM-DD."), port: text("Another port than the harbour.") }, ["date"])],
      ["harbour_depth", "The depth at a berth at a given state of the tide.", args({ berth: text("The berth's name."), at: text("A time of day, as HH:MM.") }, ["berth"])],
      ["storm_warnings", "The storm warnings in force along the coast.", args({})],
    ],
  },
  { id: "ship-register", name: "Ship register", status: "failed", problem: "Lumiverse couldn't start it: its command wasn't found. Until it starts there, it has no tools to offer.", tools: [] },
];

const SKILLS: readonly (Skill & { source: DefinitionSource })[] = [
  { id: "recap-a-scene", name: "Recap a scene", description: "Write what happened in a scene so a later turn can pick it up: who was there, what changed, what is still open.", body: "# Recap a scene\n\n1. Read the scene's messages with `chat_read`; don't work from memory.\n2. Write, in this order: who was present; what each wanted; what changed by the end; what was left open.\n3. Give each line the number of the message it rests on, as `(#47)`.\n4. Keep it under 200 words. Leave out anything you can't point to.\n", source: "builtin" },
  { id: "check-continuity", name: "Check continuity", description: "Before a reply that leans on an earlier fact, find where that fact was said and check it still holds.", body: "# Check continuity\n\n- Name the fact the reply would lean on.\n- Find it: `workspace_grep` first, then `chat_grep`.\n- If two places disagree, the later message wins; note the conflict in `notes/open.md`.\n- Tell the writer the fact and where it was said, or that it couldn't be found.\n", source: "builtin" },
  { id: "chart-a-route", name: "Chart a route", description: "Work out how someone gets from one place in the harbour town to another, and what they pass.", body: "# Chart a route\n\n1. Read `learned/places.md` for both places.\n2. Call `chart_route` with them; keep clear of anywhere the notes say is watched.\n3. Answer with the route as a list of places in order, and one line on what stands out at each.\n", source: "extension" },
  { id: "audit-the-ledger", name: "Audit the ledger", description: "Go through the harbour ledger as Okoro would: what was signed, by whom, and what is missing.", body: "# Audit the ledger\n\nOkoro signs the last page he read on the first of each month.\n\n1. Read `notes/ledger.md`.\n2. List each page the notes name, who signed it, and the message that says so.\n3. Say which pages are unaccounted for, and since when.\n4. Don't guess at who took a page: say what is known and stop.\n", source: "user" },
];

export function defsMock(ctx: MockCtx): Handlers<Requests> {
  const [main, writer, summarizer] = baseAgents();
  if (!main || !writer || !summarizer) throw new Error("The core ships three agent definitions.");
  // What an agent that reads and answers runs with: what a new one starts from, as the core has it.
  const { id: _id, name: _name, description: _description, instructions: _instructions, text: _text, follows: _follows, ...starts } = summarizer;
  const builtin: readonly AgentDefinition[] = [main, writer, summarizer];
  // The chart's tools are the cartographer's own trade, which the agent that hands it tasks doesn't hold: its definition says it keeps them whoever starts it.
  const extension: readonly AgentDefinition[] = [{ ...starts, id: "cartographer", name: "Cartographer", description: "Knows the harbour town's streets, quays and tides. Ask it how someone gets from one place to another, or what can be seen from where.", instructions: "You keep the chart of the harbour town. Answer from learned/places.md and the chart tools; say what you read and where. If a place isn't on the chart, say so.", tools: ["@workspace", "chart_route", "skill_load"], grant: "definition" }];
  const users = { agent: new Map<string, AgentDefinition>(), skill: new Map<string, Skill>() };
  const off = { agent: new Set<string>(), skill: new Set<string>(), tool: new Set<string>() };
  const serversOn = new Set<string>();
  // What the part keeps itself where the settings shown have no approval section (`?settings=sample`): the core's own defaults, every tier allowed.
  const ownTiers: Record<ToolTier, ApprovalChoice> = { read: "allow", write: "allow", external: "allow" };
  const ownTools = new Map<string, ApprovalChoice>();
  const servers = ctx.ready ? SERVERS : [];
  if (ctx.ready) {
    users.agent.set("archivist", { ...starts, id: "archivist", name: "Archivist", description: "Keeps this chat's notes: reads what its workspace holds, writes what is known and where it was said.", instructions: "You keep this chat's notes. Read what its workspace holds before you write, write what is known and the message that says it, and say what you changed.", tools: ["@chat", "@workspace"] });
    users.agent.set("reader", { ...starts, id: "reader", name: "Reader", description: "Reads a long span of the chat and answers one question about it.", instructions: "You are given one question. Read the span of the chat it names, answer it in a few lines, and give the number of each message you rest on.", tools: ["chat_grep", "chat_read"] });
    users.agent.set("writer", { ...writer, instructions: "Write the reply in the voice the preset asks for. In this chat Mara speaks plainly and never explains herself twice; Joss talks around what he wants." });
    const audit = SKILLS.find((s) => s.source === "user");
    if (audit) users.skill.set(audit.id, { id: audit.id, name: audit.name, description: audit.description, body: audit.body });
    off.agent.add("reader");
    off.tool.add("job_cancel");
    serversOn.add("tides");
  }

  const tools = (): Omit<ToolRow, "approval" | "asks">[] => [
    ...CORE_TOOLS.map(([name, family, tier, runs, description, parameters]) => ({ name, family, tier, description, parameters, runs, source: "builtin" as const, off: off.tool.has(name) })),
    ...EXTENSION_TOOLS.map(([name, family, tier, runs, description, parameters]) => ({ name, family, tier, description, parameters, runs, source: "extension" as const, off: off.tool.has(name) })),
    // A server's tools are in the registry only while the user has it on for agents and it runs.
    ...servers.filter((s) => serversOn.has(s.id) && s.status === "ready").flatMap((s) => s.tools.map(([tool, description, parameters]) => ({ name: `mcp:${s.id}:${tool}`, family: `mcp:${s.id}`, tier: "external" as const, description, parameters, runs: "extension" as const, source: "extension" as const, off: off.tool.has(`mcp:${s.id}:${tool}`) }))),
  ];
  /** Every name an agent's tools may hold, as the core's registry lists them: each tool's, the reserved entry for every tool that isn't built in (an extension's, an MCP server's), and `@family` for each family. */
  const toolNames = (): string[] => {
    const all = tools();
    return [...all.map((t) => t.name), ...new Set([ADDED_TOOLS, ...all.map((t) => `@${t.family}`)])];
  };
  /** Where the settings keep approval, where they do. */
  const settingsApproval = (): { path: string[]; held: JsonObject } | null => {
    const settings = ctx.state().settings;
    const path = approvalSettingPath(settings.schema);
    const held = path !== null ? valueAt(settings.values, path) : undefined;
    return path !== null && isRecord(held) ? { path, held: held as JsonObject } : null;
  };
  const approval = (): { tiers: Record<ToolTier, ApprovalChoice>; tools: ReadonlyMap<string, ApprovalChoice> } => {
    const kept = settingsApproval();
    if (kept === null) return { tiers: { ...ownTiers }, tools: ownTools };
    const tiers = isRecord(kept.held.tiers) ? kept.held.tiers : {};
    const own = new Map<string, ApprovalChoice>();
    if (isRecord(kept.held.tools)) for (const [name, rule] of Object.entries(kept.held.tools)) if (rule === "ask" || rule === "allow") own.set(name, rule);
    return { tiers: { read: tiers.read === "ask" ? "ask" : "allow", write: tiers.write === "ask" ? "ask" : "allow", external: tiers.external === "ask" ? "ask" : "allow" }, tools: own };
  };
  /** The definitions of a kind as the registry merges them: the built-in, then the extension's, each with the user's of its id standing over it; then the user's alone. */
  const merged = <T extends { id: string }>(kind: "agent" | "skill", shipped: readonly (T & { source: DefinitionSource })[], mine: ReadonlyMap<string, T>): (T & { source: DefinitionSource; over?: "builtin" | "extension"; off: boolean })[] => {
    const ids = new Set(shipped.map((s) => s.id));
    return [
      ...shipped.map(({ source, ...original }) => {
        const own = mine.get(original.id);
        return own ? { ...own, source: "user" as const, over: source === "extension" ? ("extension" as const) : ("builtin" as const), off: off[kind].has(original.id) } : { ...(original as unknown as T), source, off: off[kind].has(original.id) };
      }),
      ...[...mine.values()].filter((m) => !ids.has(m.id)).map((m) => ({ ...m, source: "user" as const, off: off[kind].has(m.id) })),
    ];
  };
  const agents = (): AgentView[] => merged<AgentDefinition>("agent", [...builtin.map((a) => ({ ...a, source: "builtin" as const })), ...extension.map((a) => ({ ...a, source: "extension" as const }))], users.agent);
  const skills = (): SkillView[] => merged<Skill>("skill", SKILLS.filter((s) => s.source !== "user"), users.skill);
  const view = (): DefsView => {
    const now = approval();
    return {
      agents: agents(),
      skills: skills(),
      tools: tools().map((t) => {
        const own = now.tools.get(t.name) ?? null;
        return { ...t, approval: own, asks: (own ?? now.tiers[t.tier]) === "ask" };
      }),
      mcp: servers.map((s) => ({ id: s.id, name: s.name, off: !serversOn.has(s.id), status: s.status, ...(s.problem !== undefined ? { problem: s.problem } : {}), tools: s.tools.length })),
      agentSchema: agentSchema(toolNames()),
      agentDefaults: JSON.parse(JSON.stringify(starts)) as JsonObject,
      tiers: now.tiers,
    };
  };
  /** A definition changed: the state's counter moves, and the answer is the definitions as they then stand. */
  const moved = (): DefsView => {
    ctx.push({ defs: ctx.state().defs + 1 });
    return view();
  };
  const idOf = (id: string, what: string): string => {
    // The backend's own format for a definition's id (backend/defs.ts).
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Refusal("invalid", `${what} is named by lower-case letters, digits, "_" and "-", starting with a letter (64 at most).`, [{ path: ["id"], message: "Not a name a definition can have." }]);
    return id;
  };

  return {
    "lah.defs.get": () => view(),
    "lah.agent.save": (r) => {
      const agent = r.agent;
      const id = idOf(agent.id, "An agent");
      const problems = refusedBy(agentSchema(toolNames()), agent, []);
      if (agent.name.trim() === "") problems.push({ path: ["name"], message: "Give it a name: it is how the pages and a delegating agent call it." });
      if (agent.text !== undefined && !TEXT_DEFS.some((d) => d.id === agent.text)) problems.push({ path: ["text"], message: `There is no text with the id "${agent.text}".` });
      if (agent.follows !== undefined && !agents().some((a) => a.id === agent.follows)) problems.push({ path: ["follows"], message: `There is no agent named "${agent.follows}" to follow.` });
      // What it is given of its tools when another agent starts it is the core's own to check, in the core's own words.
      problems.push(...checkAgent(agent, toolNames()).problems.filter((p) => p.path[0] === "grant"));
      if (problems.length > 0) throw new Refusal("invalid", "The agent wasn't saved: it has something the core refuses.", problems);
      users.agent.set(id, JSON.parse(JSON.stringify(agent)) as AgentDefinition);
      return moved();
    },
    "lah.skill.save": (r) => {
      const skill = r.skill;
      const id = idOf(skill.id, "A skill");
      const problems: UiProblem[] = [];
      if (skill.name.trim() === "") problems.push({ path: ["name"], message: "Give it a name: an agent's prompt lists it by its name." });
      if (skill.description.trim() === "") problems.push({ path: ["description"], message: "Say what it is for: it is all an agent reads when it chooses a skill." });
      if (skill.body.trim() === "") problems.push({ path: ["body"], message: "Write its body: it is what skill_load returns." });
      if (problems.length > 0) throw new Refusal("invalid", "The skill wasn't saved: it has something the core refuses.", problems);
      users.skill.set(id, { id, name: skill.name, description: skill.description, body: skill.body });
      return moved();
    },
    "lah.def.remove": (r) => {
      if (!users[r.kind].delete(r.id)) throw new Refusal("not_found", `You have no ${r.kind} of your own named "${r.id}". A built-in or an extension's can be switched off, not removed.`);
      // One that was the user's alone is gone, and its switch with it; an original that comes back keeps its own.
      if (!(r.kind === "agent" ? agents() : skills()).some((d) => d.id === r.id)) off[r.kind].delete(r.id);
      return moved();
    },
    "lah.def.switch": (r) => {
      if (r.kind === "mcp") {
        if (!servers.some((s) => s.id === r.id)) throw new Refusal("not_found", `No MCP server named "${r.id}" is set up in Lumiverse.`);
        if (r.off) serversOn.delete(r.id);
        else serversOn.add(r.id);
        return moved();
      }
      const known = r.kind === "agent" ? agents().some((a) => a.id === r.id) : r.kind === "skill" ? skills().some((s) => s.id === r.id) : tools().some((t) => t.name === r.id);
      if (!known) throw new Refusal("not_found", `There is no ${r.kind} named "${r.id}".`);
      // The three a turn can't do without (the core's `CORE_AGENTS`).
      if (r.kind === "agent" && r.off && builtin.some((a) => a.id === r.id)) throw new Refusal("conflict", `A turn can't do without the agent "${r.id}", so it can't be switched off. Change what it runs with instead.`);
      if (r.off) off[r.kind].add(r.id);
      else off[r.kind].delete(r.id);
      return moved();
    },
    "lah.tool.approval": (r) => {
      if (!tools().some((t) => t.name === r.name)) throw new Refusal("not_found", `There is no tool named "${r.name}".`);
      const kept = settingsApproval();
      if (kept === null) {
        if (r.approval === null) ownTools.delete(r.name);
        else ownTools.set(r.name, r.approval);
        return moved();
      }
      const { [r.name]: _was, ...others } = isRecord(kept.held.tools) ? (kept.held.tools as JsonObject) : {};
      ctx.settings([{ path: [...kept.path, "tools"], value: r.approval === null ? others : { ...others, [r.name]: r.approval } }], []);
      return moved();
    },
    "lah.tier.approval": (r) => {
      const kept = settingsApproval();
      if (kept === null) ownTiers[r.tier] = r.approval;
      else ctx.settings([{ path: [...kept.path, "tiers", r.tier], value: r.approval }], []);
      return moved();
    },
  };
}
