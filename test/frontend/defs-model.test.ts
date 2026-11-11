// What the Library pages show of definitions: where each comes from, what a filter keeps, the id a
// new one may have, what a save sends (an agent whose instructions are one of the core's texts
// above all), what removing one says, a tool's arguments in words, what its calls do, and how an
// MCP server stands.

import { describe, expect, test } from "bun:test";
import { MockBackend } from "../../dev/preview/mock-backend";
import { realSettings } from "../../dev/preview/sections";
import { baseAgents } from "../../src/core/agents";
import {
  AGENT_WORDS,
  agentDraft,
  agentForm,
  agentToSave,
  applyAgentForm,
  applyForm,
  approvalSettingPath,
  copyAgent,
  copyId,
  copySkill,
  countWords,
  familiesOf,
  filterDefs,
  filtersOn,
  followsWords,
  grantSettingWords,
  holdsWords,
  idProblem,
  instructionsNote,
  instructionsShown,
  mcpAbout,
  mcpCountWords,
  mcpServerOf,
  mcpWords,
  NO_TOOL_FILTER,
  newAgent,
  newSkill,
  ownProblems,
  paramsOf,
  removeAsk,
  SKILL_WORDS,
  sameAgent,
  sameSkill,
  savedWords,
  saveLabel,
  saveStatus,
  skillDraft,
  skillToSave,
  soundFilter,
  sourceWords,
  standingWords,
  textName,
  tierChoiceWords,
  tierReach,
  toolCountWords,
  toolFacts,
  toolGroups,
  typedInstructions,
  typeWords,
} from "../../src/extension/frontend/defs-model";
import { childrenOf, formOf, valueWords } from "../../src/extension/frontend/settings-model";
import type { AgentView, JsonObject, McpServerView, SkillView, ToolRow } from "../../src/shared/ui";

const [MAIN, WRITER] = baseAgents();
if (!MAIN || !WRITER) throw new Error("The core ships its agents.");
const main: AgentView = { ...MAIN, source: "builtin", off: false };
const writer: AgentView = { ...WRITER, source: "user", over: "builtin", off: false };
const archivist: AgentView = { ...WRITER, id: "archivist", name: "Archivist", description: "Keeps this chat's notes.", instructions: "You keep the notes.", given: "task", source: "user", off: true };
const cartographer: AgentView = { ...WRITER, id: "cartographer", name: "Cartographer", description: "Knows the harbour town's streets.", instructions: "You keep the chart.", source: "extension", off: false };
const AGENTS = [main, writer, cartographer, archivist];
const TEXTS = [{ id: "main.system", group: "Main agent", label: "Instructions" }];

const skill = (over: Partial<SkillView>): SkillView => ({ id: "audit-the-ledger", name: "Audit the ledger", description: "Go through the ledger as Okoro would.", body: "# Audit\n\n1. Read notes/ledger.md.\n", source: "user", off: false, ...over });
const tool = (over: Partial<ToolRow>): ToolRow => ({ name: "workspace_write", family: "workspace", tier: "write", description: "Writes a workspace file whole.", parameters: { type: "object", properties: { path: { type: "string", description: "The file's path." }, text: { type: "string" } }, required: ["path"] }, runs: "runtime", source: "builtin", off: false, approval: null, asks: false, ...over });
const TOOLS = [tool({}), tool({ name: "workspace_read", tier: "read" }), tool({ name: "chat_search", family: "chat", tier: "read", runs: "extension", description: "Finds messages nearest in meaning." }), tool({ name: "mcp:tides:tide_times", family: "mcp:tides", tier: "external", runs: "extension", source: "extension", asks: true, description: "High and low waters." })];
const server = (over: Partial<McpServerView>): McpServerView => ({ id: "tides", name: "Tide tables", off: false, status: "ready", tools: 3, ...over });

describe("where a definition comes from", () => {
  test("in words, with what a user's stands over", () => {
    expect(AGENTS.map(sourceWords)).toEqual(["built in", "yours, over the built-in", "an extension's", "yours"]);
    expect(sourceWords({ source: "user", over: "extension" })).toBe("yours, over the extension's");
  });

  test("the count says whose they are", () => {
    expect(countWords(AGENTS, AGENT_WORDS)).toBe("4 agents: 1 built in, 1 from an extension, 2 yours");
    expect(countWords([skill({})], SKILL_WORDS)).toBe("1 skill: 1 yours");
    expect(countWords([], SKILL_WORDS)).toBe("No skills");
  });

  test("the line under the name says what a save and a reset do", () => {
    expect(standingWords(null, AGENT_WORDS)).toContain("exists once you save it");
    expect(standingWords(main, AGENT_WORDS)).toContain("makes an agent of yours with the same id that stands over this one");
    expect(standingWords(writer, AGENT_WORDS)).toContain("brings the built-in one back");
    expect(standingWords(archivist, AGENT_WORDS)).toBe("Yours.");
  });
});

describe("the filter", () => {
  test("keeps what holds every word, in the registry's order", () => {
    expect(filterDefs(AGENTS, "").map((a) => a.id)).toEqual(["main", "writer", "cartographer", "archivist"]);
    expect(filterDefs(AGENTS, "NOTES keeps").map((a) => a.id)).toEqual(["archivist"]);
    expect(filterDefs(AGENTS, "extension").map((a) => a.id)).toEqual(["cartographer"]);
    expect(filterDefs(AGENTS, "tide")).toEqual([]);
  });

  test('"off" finds the ones switched off', () => {
    expect(filterDefs(AGENTS, "off").map((a) => a.id)).toEqual(["archivist"]);
  });
});

describe("the id of a new definition", () => {
  const taken = ["main", "writer"];

  test("is lower-case letters, digits, - and _, starting with a letter, and not taken", () => {
    expect(idProblem("harbour-clerk_2", taken)).toBeNull();
    expect(idProblem("", taken)).toContain("Give it an id");
    expect(idProblem("Harbour Clerk", taken)).toContain("lower-case letters");
    expect(idProblem("2nd", taken)).toBe("An id starts with a letter.");
    expect(idProblem("writer", taken)).toContain("is taken");
    expect(idProblem("a".repeat(65), taken)).toContain("64 characters");
  });

  test("a copy is offered an id nothing has", () => {
    expect(copyId("writer", taken)).toBe("writer-copy");
    expect(copyId("writer", [...taken, "writer-copy"])).toBe("writer-copy-2");
    expect(idProblem(copyId("w".repeat(64), taken), taken)).toBeNull();
  });
});

describe("saving", () => {
  test("the button says what a save makes", () => {
    expect(saveLabel(null, AGENT_WORDS)).toBe("Make this agent");
    expect(saveLabel(main, AGENT_WORDS)).toBe("Save as yours");
    expect(saveLabel(archivist, AGENT_WORDS)).toBe("Save");
    expect(savedWords(main, "Main agent")).toBe("Saved as yours: your Main agent now stands over the built-in one.");
    expect(savedWords(null, "Harbour clerk")).toBe("Made Harbour clerk.");
  });

  test("the bar says how the edits stand, and a refusal in the backend's words", () => {
    expect(saveStatus({ made: true, dirty: false, refused: null, idWrong: null }, AGENT_WORDS)).toBe("No edits to save.");
    expect(saveStatus({ made: true, dirty: true, refused: null, idWrong: null }, AGENT_WORDS)).toContain("not saved yet");
    expect(saveStatus({ made: false, dirty: true, refused: null, idWrong: "An id starts with a letter." }, AGENT_WORDS)).toBe("Not made yet. An id starts with a letter.");
    expect(saveStatus({ made: true, dirty: true, refused: "The agent wasn't saved: it has something the core refuses.", idWrong: null }, AGENT_WORDS)).toBe("Not saved: The agent wasn't saved: it has something the core refuses.");
  });

  test("a refusal's problems go to the fields the page draws, the rest to the form", () => {
    const { own, rest } = ownProblems(
      [
        { path: ["name"], message: "Give it a name." },
        { path: ["tools", 2], message: 'There is no tool named "harbour_bell".' },
        { path: ["budget", "revisions"], message: "It can't be under 0." },
      ],
      ["id", "name", "description"],
    );
    expect([...own]).toEqual([["name", "Give it a name."]]);
    expect(rest.map((p) => p.path.join("."))).toEqual(["tools.2", "budget.revisions"]);
  });
});

describe("removing a definition of the user's", () => {
  test("one that is theirs alone is deleted", () => {
    const ask = removeAsk(archivist, AGENT_WORDS, false);
    expect(ask.label).toBe("Delete");
    expect(ask.title).toBe("Delete Archivist?");
    expect(ask.message).toContain("can't be undone");
    expect(ask.done).toBe("Deleted Archivist.");
  });

  test("one that stands over an original is reset, and the question says what comes back", () => {
    const ask = removeAsk(writer, AGENT_WORDS, true);
    expect(ask.label).toBe("Reset to the original");
    expect(ask.message).toContain('the built-in agent of that id comes back as it was made');
    expect(ask.message).toContain("The edits you haven't saved go with it.");
    expect(ask.done).toBe('The built-in agent "writer" is back.');
  });
});

describe("an agent whose instructions are one of the core's texts", () => {
  const draft = agentDraft(main);

  test("shows the text as the user has it, else as shipped", () => {
    expect(instructionsShown(draft.instructions, {})).toBe(MAIN.instructions);
    expect(instructionsShown(draft.instructions, { "main.system": "Mara's own wording." })).toBe("Mara's own wording.");
    expect(instructionsNote(draft.instructions, draft.instructions, TEXTS)?.words).toContain("Main agent → Instructions (main.system), which Settings → Texts also edits");
    expect(textName("agents.summarizer", TEXTS)).toBe("agents.summarizer");
  });

  test("goes on naming the text when the instructions weren't edited here", () => {
    const sent = agentToSave({ ...draft, description: "Works out what each reply needs.  " });
    expect(sent.text).toBe("main.system");
    expect(sent.instructions).toBe(MAIN.instructions);
    expect(sent.description).toBe("Works out what each reply needs.");
    expect(sent.tools).toEqual(MAIN.tools);
    expect(sent.budget).toEqual(MAIN.budget);
  });

  test("carries its own instructions and names no text once they were edited, and says so before the save", () => {
    const typed = typedInstructions("Answer in one line.", draft.instructions, {});
    const edited = { ...draft, instructions: typed };
    const sent = agentToSave(edited);
    expect(sent.instructions).toBe("Answer in one line.");
    expect(Object.hasOwn(sent, "text")).toBe(false);
    const note = instructionsNote(typed, draft.instructions, TEXTS);
    expect(note?.tone).toBe("warn");
    expect(note?.words).toContain("stops applying to it");
    expect(note?.words).toContain("until you reset the agent to the original");
  });

  test("an edit undone by hand is undone: the text stands again", () => {
    const own = { "main.system": "Mara's own wording." };
    const back = typedInstructions("Mara's own wording.", draft.instructions, own);
    expect(back).toEqual(draft.instructions);
    expect(sameAgent({ ...draft, instructions: back }, draft)).toBe(true);
  });
});

describe("an agent's edits", () => {
  test("an agent of the user's goes back as it came", () => {
    const { source: _source, off: _off, ...definition } = archivist;
    expect(agentToSave(agentDraft(archivist))).toEqual(definition);
  });

  test("a new one starts from what the backend says, and a copy keeps what it copies", () => {
    const fresh = newAgent({ given: "task", tools: ["chat_read"], budget: { revisions: 1 } });
    expect(fresh.id).toBe("");
    expect(fresh.rest).toEqual({ given: "task", tools: ["chat_read"], budget: { revisions: 1 } });
    const copy = copyAgent(agentDraft(archivist), "archivist-copy");
    expect(copy.id).toBe("archivist-copy");
    expect(copy.name).toBe("Archivist (copy)");
    expect(copy.rest).toEqual(agentDraft(archivist).rest);
    expect(sameAgent(copy, agentDraft(archivist))).toBe(false);
  });

  test("the form's changes are kept in the edits: a value set, a value back to what a new agent starts with", () => {
    const defaults = { given: "task", model: null, budget: { revisions: 1, toolTurns: 8 } };
    const rest = { given: "request", model: "deepseek-v4-pro", budget: { revisions: 3, toolTurns: 8 }, follows: "main" };
    const set = applyForm(rest, defaults, [{ path: ["budget", "toolTurns"], value: null }]);
    expect(set).toEqual({ given: "request", model: "deepseek-v4-pro", budget: { revisions: 3, toolTurns: null }, follows: "main" });
    expect(rest.budget.toolTurns).toBe(8);
    expect(applyForm(rest, defaults, [], [["budget", "revisions"], ["model"]])).toEqual({ given: "request", model: null, budget: { revisions: 1, toolTurns: 8 }, follows: "main" });
    expect(applyForm(rest, defaults, [], [[]])).toEqual({ ...defaults, follows: "main" });
  });

  test("says whom it follows", () => {
    expect(followsWords({ follows: "main" }, AGENTS)).toBe("While it names no connection of its own, it runs where Main agent does.");
    expect(followsWords({}, AGENTS)).toBeNull();
  });

  test("what it has of its tools when another agent starts it is a choice in its form, after its tools", () => {
    const view = { agentSchema: { type: "object", properties: { given: { type: "string", enum: ["request", "task"] }, tools: { type: "array", items: { type: "string", enum: ["chat_read"] } }, budget: { type: "object", properties: {} } } }, agentDefaults: { given: "task", tools: [] } };
    const says = "Settings → Delegation → What a sub-agent may be given decides. It says now: No more than its starter holds.";
    const form = agentForm(view, { given: "task", tools: ["chat_read"] }, says);
    expect(Object.keys(form.schema.properties as JsonObject)).toEqual(["given", "tools", "grant", "budget"]);
    // Left out of the definition, it is none in the form, which is also what a new agent starts with: nothing shows as changed.
    const node = childrenOf(formOf(form)).find((n) => n.key === "grant");
    expect(node).toMatchObject({ label: "The tools it has when another agent starts it", value: null, changed: false });
    expect(node?.control).toMatchObject({ kind: "choice", options: [{ value: null, label: "As Settings say", help: says }, { value: "own", label: "No more than its starter holds" }, { value: "definition", label: "Its own tools, whoever starts it" }] });
    const set = childrenOf(formOf(agentForm(view, { given: "task", tools: [], grant: "definition" }, null))).find((n) => n.key === "grant");
    expect(set).toMatchObject({ value: "definition", changed: true });
    // The way back from a choice made names what it goes back to in the list's own words.
    expect(set ? valueWords({ ...set, value: set.fallback }) : "").toBe("As Settings say");
    // The backend's schema is handed on as it came: the choice is the page's own, added to what it shows.
    expect(Object.keys(view.agentSchema.properties)).toEqual(["given", "tools", "budget"]);
  });

  test("choosing one keeps it in the definition; leaving it to Settings, or putting it back, leaves it out", () => {
    const defaults = { given: "task", tools: [] };
    const rest = { given: "task", tools: ["chat_read"] };
    const kept = applyAgentForm(rest, defaults, [{ path: ["grant"], value: "definition" }]);
    expect(kept).toEqual({ given: "task", tools: ["chat_read"], grant: "definition" });
    expect(applyAgentForm(kept, defaults, [{ path: ["grant"], value: null }])).toEqual(rest);
    expect(applyAgentForm(kept, defaults, [], [["grant"]])).toEqual(rest);
    expect(applyAgentForm(kept, defaults, [], [[]])).toEqual(defaults);
    // Another change leaves what the definition says of it alone.
    expect(applyAgentForm(kept, defaults, [{ path: ["given"], value: "request" }])).toEqual({ given: "request", tools: ["chat_read"], grant: "definition" });
  });

  test("a save sends it where the definition says it, and nothing for 'as Settings say'", () => {
    const keeps: AgentView = { ...cartographer, grant: "definition" };
    const draft = agentDraft(keeps);
    expect(agentToSave(draft).grant).toBe("definition");
    const left = { ...draft, rest: applyAgentForm(draft.rest, {}, [{ path: ["grant"], value: null }]) };
    expect(agentToSave(left)).not.toHaveProperty("grant");
    expect(sameAgent(left, agentDraft(cartographer))).toBe(true);
  });

  test("the choice that leaves it to Settings names the setting and what it says now", () => {
    const settled = realSettings();
    const real = new MockBackend(() => {}, { scenario: "ready", turn: "none", sections: settled.sections, texts: settled.texts, delay: 0, page: 50, fail: new Set(), now: () => 0, later: () => () => {} }).state.settings;
    expect(grantSettingWords(real)).toBe("Settings → Delegation → What a sub-agent may be given decides. It says now: No more than its starter holds.");
    const delegation = { type: "object", title: "Delegation", properties: { grant: { title: "What a sub-agent may be given", oneOf: [{ const: "own", title: "No more than its starter holds" }, { const: "definition", title: "Whatever its definition names" }] } } };
    // At the settings' root, as an extension that builds the core in may keep them, and with the user's own choice over the default.
    expect(grantSettingWords({ schema: { type: "object", properties: { delegation } }, values: { delegation: { grant: "definition" } }, defaults: { delegation: { grant: "own" } } })).toBe("Settings → Delegation → What a sub-agent may be given decides. It says now: Whatever its definition names.");
    expect(grantSettingWords({ schema: { type: "object", properties: { sample: { type: "object", properties: {} } } }, values: {}, defaults: {} })).toBeNull();
  });
});

describe("a skill's edits", () => {
  test("go back trimmed of the blank space around its name and description, its body as written", () => {
    const draft = skillDraft(skill({ name: "  Audit the ledger ", body: "# Audit\n\n  indented\n" }));
    expect(skillToSave(draft)).toEqual({ id: "audit-the-ledger", name: "Audit the ledger", description: "Go through the ledger as Okoro would.", body: "# Audit\n\n  indented\n" });
  });

  test("a new one is empty, and a copy differs from what it copies", () => {
    expect(newSkill()).toEqual({ id: "", name: "", description: "", body: "" });
    const draft = skillDraft(skill({}));
    const copy = copySkill(draft, "audit-the-ledger-copy");
    expect(copy.name).toBe("Audit the ledger (copy)");
    expect(copy.body).toBe(draft.body);
    expect(sameSkill(copy, draft)).toBe(false);
    expect(sameSkill(skillDraft(skill({})), draft)).toBe(true);
  });
});

describe("a tool", () => {
  test("its arguments are said in words, in the schema's order", () => {
    expect(paramsOf(tool({}).parameters)).toEqual([
      { name: "path", type: "text", required: true, description: "The file's path." },
      { name: "text", type: "text", required: false, description: null },
    ]);
    expect(paramsOf(undefined)).toEqual([]);
    expect(typeWords({ type: "array", items: { type: "string" } })).toBe("list of text");
    expect(typeWords({ type: "string", enum: ["now", "after_reply"] })).toBe("one of: now, after_reply");
    expect(typeWords({ type: ["integer", "null"] })).toBe("whole number or nothing");
    expect(typeWords({})).toBe("anything");
  });

  test("says what its calls do now, and whose choice that is", () => {
    expect(holdsWords(tool({}))).toBe("Now its calls run without asking: as write tools do.");
    expect(holdsWords(tool({ approval: "ask", asks: true }))).toBe("Now each call waits for your word: your choice for this tool.");
    expect(holdsWords(tool({ off: true }))).toContain("It is off, so no agent is offered it.");
    expect(tierChoiceWords("external", { read: "allow", write: "allow", external: "ask" })).toBe("External tools ask first now.");
    expect(tierChoiceWords("read", { read: "allow", write: "allow", external: "ask" })).toBe("Read tools run without asking now.");
  });

  test("says where it runs and where it comes from", () => {
    expect(toolFacts(tool({}))).toBe("family workspace · runs in the runtime · built in");
    expect(toolFacts(TOOLS[3] ?? tool({}))).toBe("family mcp:tides · runs in the extension, over the link · the MCP server tides");
    expect(mcpServerOf("mcp:tides:tide_times")).toBe("tides");
    expect(mcpServerOf("workspace_write")).toBeNull();
  });

  test("a tier's reach counts its tools and those with a choice of their own", () => {
    expect(tierReach(TOOLS, "read")).toBe("2 tools.");
    expect(tierReach([...TOOLS, tool({ name: "workspace_delete", approval: "ask" })], "write")).toBe("2 tools, 1 with a choice of its own.");
    expect(tierReach([], "external")).toBe("No tool is of this tier now.");
  });
});

describe("the tools' filter", () => {
  test("groups by family in the registry's order", () => {
    const groups = toolGroups(TOOLS, NO_TOOL_FILTER);
    expect(groups.map((g) => `${g.family}:${g.tools.length}`)).toEqual(["workspace:2", "chat:1", "mcp:tides:1"]);
    expect(familiesOf(TOOLS)).toEqual(["workspace", "chat", "mcp:tides"]);
    expect(filtersOn(NO_TOOL_FILTER)).toBe(false);
  });

  test("by text, by tier, by family, and by what asks first", () => {
    const names = (filter: Partial<typeof NO_TOOL_FILTER>): string[] => toolGroups(TOOLS, { ...NO_TOOL_FILTER, ...filter }).flatMap((g) => g.tools.map((t) => t.name));
    expect(names({ text: "meaning" })).toEqual(["chat_search"]);
    expect(names({ text: "path" })).toEqual(["workspace_write", "workspace_read", "chat_search", "mcp:tides:tide_times"]);
    expect(names({ tier: "read" })).toEqual(["workspace_read", "chat_search"]);
    expect(names({ family: "workspace", tier: "write" })).toEqual(["workspace_write"]);
    expect(names({ asks: true })).toEqual(["mcp:tides:tide_times"]);
    expect(names({ text: "bell" })).toEqual([]);
    expect(toolCountWords(2, 4)).toBe("2 of 4 tools");
    expect(toolCountWords(4, 4)).toBe("4 tools");
  });

  test("a family that is gone filters nothing", () => {
    const filter = { ...NO_TOOL_FILTER, family: "mcp:tides" };
    expect(soundFilter(filter, TOOLS)).toBe(filter);
    expect(soundFilter(filter, TOOLS.slice(0, 3)).family).toBeNull();
  });
});

describe("an MCP server", () => {
  test("says whether agents are offered its tools, and why not", () => {
    expect(mcpWords(server({}))).toEqual({ status: "ready", tone: "pos", line: "On for agents: 3 tools offered." });
    expect(mcpWords(server({ off: true })).line).toBe("Off for agents: none of its tools is offered.");
    expect(mcpWords(server({ status: "failed", problem: "Its command wasn't found." }))).toEqual({ status: "failed", tone: "neg", line: "Its command wasn't found." });
    expect(mcpWords(server({ status: "stopped", off: true })).line).toBe("Off for agents. It is switched off in Lumiverse, so its tools aren't offered.");
    expect(mcpWords(server({ tools: 0 })).line).toBe("On for agents, but it offers no tool.");
    expect(mcpCountWords([server({}), server({ id: "ship-register", off: true })])).toBe("1 of 2 servers on for agents");
  });

  test("what switching one on means is said by what external tools' calls do now", () => {
    expect(mcpAbout("allow")).toContain("agents can call its tools without asking. To approve each call yourself, set external tools to Ask first");
    expect(mcpAbout("ask")).toContain("each call waits for your word on Live");
    expect(mcpAbout("ask")).not.toContain("without asking");
  });
});

describe("where the settings keep approval", () => {
  const approval = { type: "object", properties: { tiers: { type: "object" }, tools: { type: "object" } } };

  test("is read from their schema: at the root, or inside one section", () => {
    expect(approvalSettingPath({ type: "object", properties: { approval } })).toEqual(["approval"]);
    expect(approvalSettingPath({ type: "object", properties: { link: { type: "object", properties: {} }, core: { type: "object", properties: { approval } } } })).toEqual(["core", "approval"]);
  });

  test("is nowhere when the settings shown have no such group", () => {
    expect(approvalSettingPath({ type: "object", properties: { sample: { type: "object", properties: { approval: { type: "string" } } } } })).toBeNull();
    expect(approvalSettingPath({})).toBeNull();
  });
});
