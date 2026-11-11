// What an editable text is, the names of the core's tools, and what a file of texts is written with.
// Apart from texts.ts so that each area's texts sit in a file of their own (src/core/texts/) and
// texts.ts gathers them without a cycle: an area's file imports this one alone.

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

/** The core's tools, by name (DESIGN §4.3, §11, §13 to §15, §23). */
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
  // Lore and history (§24).
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
  webSearch: "web_search",
} as const;

/** The families the core's tools sit in: what `@family` names in an agent definition's tools (§13). */
export const FAMILY = {
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
  web: "web",
} as const;

/** The id of a tool's description. */
export const toolId = (name: string): string => `tool.${name}`;

/** The id of the description of one of a tool's arguments. */
export const toolArgId = (name: string, arg: string): string => `tool.${name}.${arg}`;

export const v = (name: string, text: string, required?: true): TextVar => (required ? { name, text, required } : { name, text });

/** The groups the Settings page shows the texts under. */
export const GROUP = {
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
  words: "Words",
} as const;

/** A tool's description and each of its arguments', as texts. */
export function toolTexts(name: string, description: string, args: Readonly<Record<string, string>>): TextDef[] {
  return [
    { id: toolId(name), group: GROUP.tools, label: `${name}: what it does`, note: `The description of the ${name} tool, as the model is offered it.`, text: description, vars: [] },
    ...Object.entries(args).map(([arg, text]): TextDef => ({ id: toolArgId(name, arg), group: GROUP.tools, label: `${name}: ${arg}`, note: `The description of ${name}'s ${arg} argument.`, text, vars: [] })),
  ];
}

/** What every tool that pages says of its cursor argument. */
export const CURSOR_ARG = "Where to go on from: the cursor the last answer gave you. Leave it out to start at the beginning.";

/** A noun's text: the word for one of it, and for several. */
export const word = (id: string, one: string, many: string): TextDef => ({ id, group: GROUP.words, label: `${one}, ${many}`, note: `The word a count of these takes in answers, notes and stops: for one, then for several, with | between ("1 ${one}", "3 ${many}").`, text: `${one}|${many}`, vars: [] });

/** The reason an agent that stopped gives, as a text. */
export const stopText = (id: string, label: string, note: string, text: string, vars: TextVar[] = []): TextDef => ({ id, group: GROUP.stops, label, note: `${note} The reason an agent that stopped so gives, in the live view and to whoever started it.`, text, vars });
