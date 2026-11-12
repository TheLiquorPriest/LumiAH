// An extension that builds LumiAH into itself (DESIGN §21), on an in-memory host with the sample
// extension (`support/sample-extension.ts`): one of each thing it may supply reaches a turn; its
// tool that bears a built-in's name stands in for the built-in only in the chats it claims; what
// it withdraws there is offered to nobody; and whatever it does or fails to do, the turn still
// writes its reply.

import { describe, expect, test } from "bun:test";
import type { StoredDefinitions } from "../../src/core/definitions";
import { createHarness, type Harness } from "../../src/core/harness";
import type { ApprovalAsk, JsonValue, ModelRequest, ModelToolCall, RemoteTool } from "../../src/core/ports";
import { recordOf } from "../../src/core/sessions";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { renderDefault, TEXT, Texts } from "../../src/core/texts";
import { directedNote } from "../../src/core/turn";
import { call, idle, MemoryHost, runTurn, type Script, until } from "./support/host";
import { HARBOUR, KEEPER, LOG_SKILL, READER, type SampleOptions, SEARCH, sampleExtension, TIDES } from "./support/sample-extension";

/** A chat the sample extension claims, and one it doesn't. */
const CLAIMED = "harbour-1";
const PLAIN = "chat-1";

/** A host with the sample extension mounted, both chats, and a harness whose settings a test changes. An extension's tools run without a word, as LumiAH ships: what holds them once Settings say so has tests of its own below. */
function rig(script: Script, change: (s: Settings) => void = () => undefined, options: SampleOptions & { userId?: string } = {}) {
  const host = new MemoryHost();
  host.script = script;
  const sample = sampleExtension(options);
  host.tools = sample.tools;
  host.anchorCodec = sample.anchor;
  for (const chat of [CLAIMED, PLAIN]) {
    host.say(chat, "assistant", "The harbour is quiet tonight.");
    host.say(chat, "user", "I ask Brann when the tide turns.");
  }
  const stored: { values: Settings; texts: Record<string, string>; definitions?: StoredDefinitions } = { values: defaultSettings(), texts: {} };
  change(stored.values);
  const harness = createHarness(host, { settings: async () => structuredClone(stored), extension: sample.extension, ...(options.userId !== undefined ? { userId: options.userId } : {}) });
  return { host, harness, stored, sample, turn: (chatId = CLAIMED) => runTurn(host, harness, chatId) };
}

const started = (host: MemoryHost) => host.traced.flatMap(({ event }) => (event.kind === "agent_started" ? [event.agent] : []));
const offered = (request: ModelRequest | undefined): string[] => request?.tools?.map((t) => t.name) ?? [];
const system = (request: ModelRequest | undefined): string => request?.messages[0]?.content ?? "";

/** What a tool call was answered with, as its model read it in the request that followed. */
function resultOf(host: MemoryHost, callId: string): { content: string; failed: boolean } | undefined {
  for (const request of host.calls) for (const message of request.messages) for (const part of message.parts ?? []) if (part.type === "tool_result" && part.toolUseId === callId) return { content: part.content, failed: part.isError === true };
  return undefined;
}

/** The log's line that holds every one of `parts`. */
const logged = (host: MemoryHost, ...parts: string[]): string | undefined => host.logs.find((line) => parts.every((part) => line.message.includes(part)))?.message;

/** Which of a run's agents a request is from: the writer takes no tools, and only the agent a run starts with holds write_reply. */
const from = (request: ModelRequest): "writer" | "main" | "sub" => (!request.tools ? "writer" : offered(request).includes("write_reply") ? "main" : "sub");

/** How many rounds of tool calls the agent has had on the message it is working on. */
function rounds(request: ModelRequest): number {
  let n = 0;
  for (const message of request.messages.toReversed()) {
    if (message.role !== "user") continue;
    if (!message.parts?.some((part) => part.type === "tool_result")) break;
    n++;
  }
  return n;
}

const BRIEF = "High water at 18:40; Brann waits for it.";
const REPLY = "Brann squints at the water. 'Twenty to seven,' he says.";

/** A model that briefs the writer at once, and writes. */
const quick: Script = (request) => (from(request) === "writer" ? REPLY : { toolCalls: [call("write_reply", { brief: BRIEF }, "w1")] });

/** A model whose main agent makes `calls` in its first round, then briefs the writer. */
const calling = (...calls: ModelToolCall[]): Script => (request) => (from(request) === "writer" ? REPLY : rounds(request) === 0 ? { toolCalls: calls } : { toolCalls: [call("write_reply", { brief: BRIEF }, "w1")] });

/** A model whose main agent hands one task to `agent`, which answers at once; then the main agent briefs the writer. */
const delegating = (agent: string): Script => (request) => {
  if (from(request) === "writer") return REPLY;
  if (from(request) === "sub") return "High water at 18:40.";
  return rounds(request) === 0 ? { toolCalls: [call("delegate", { agent, task: "When is high water today?" }, "d1")] } : { toolCalls: [call("write_reply", { brief: BRIEF }, "w1")] };
};

const GUIDANCE = { user: "Keep replies short.", harbour: "The harbour faces east.", chat: "Brann is hard of hearing." } as const;

describe("a chat the extension claims: one of each thing it supplies", () => {
  /** One turn in the claimed chat, with guidance written at all three levels: the keeper asks for the tides and loads the skill, then briefs the writer. */
  async function harbourTurn(options: SampleOptions = {}) {
    const r = rig(calling(call(HARBOUR.tides, { day: "today" }, "c1"), call("skill_load", { skill: HARBOUR.skill }, "c2")), undefined, options);
    await r.harness.guidance.set({ chatId: CLAIMED, level: "user", text: GUIDANCE.user, base: null });
    if (options.guidance !== "text") await r.harness.guidance.set({ chatId: CLAIMED, level: "middle", text: GUIDANCE.harbour, base: null });
    await r.harness.guidance.set({ chatId: CLAIMED, level: "chat", text: GUIDANCE.chat, base: null });
    const turn = await r.turn();
    await until(() => r.sample.seen.hooks.length === 3);
    return { ...r, ...turn };
  }

  /** The list of skills that ends an agent's instructions here: the core's own, then the extension's. */
  const skills = (r: { harness: Harness }): string =>
    `Skills you can load with skill_load. Each is a procedure written for you: load one when what you are doing is what it is for, and follow it.\n${[...r.harness.skills.all(), LOG_SKILL].map((skill) => `- ${skill.id}: ${skill.name}. ${skill.description}`).join("\n")}`;

  test("its main agent answers, under the three levels of guidance, the middle one named as the extension names it", async () => {
    const r = await harbourTurn();
    expect(r.result).toMatchObject({ status: "done", reply: REPLY });
    expect(system(r.host.calls[0])).toBe(
      [`[Guidance from the user, for every chat. Follow it.]\n${GUIDANCE.user}`, `[Guidance ${HARBOUR.guidance.name}. Follow it.]\n${GUIDANCE.harbour}`, `[Guidance for this chat. Follow it.]\n${GUIDANCE.chat}`, KEEPER.instructions, skills(r)].join("\n\n"),
    );
    // The trace names the agent that answered by the extension's definition, then the writer it briefed.
    const agents = started(r.host);
    expect(agents.map((a) => a.role)).toEqual([HARBOUR.keeper, "writer"]);
    expect(agents[0]?.prefix).toHaveLength(3);
    expect(agents[1]?.parent).toBe(agents[0]?.id);
    // The extension's level is a file of the user's area, where it said: the page reads it there.
    expect((await r.harness.workspace.read({ chatId: CLAIMED, area: "user", path: "harbour/GUIDANCE.md" })).text).toBe(GUIDANCE.harbour);
    expect(r.host.logs).toEqual([]);
  });

  test("guidance the extension keeps as a text of its own is given under its name, and isn't the page's to edit", async () => {
    const r = await harbourTurn({ guidance: "text" });
    expect(system(r.host.calls[0])).toStartWith([`[Guidance from the user, for every chat. Follow it.]\n${GUIDANCE.user}`, `[Guidance ${HARBOUR.guidance.name}. Follow it.]\n${HARBOUR.guidance.text}`, `[Guidance for this chat. Follow it.]\n${GUIDANCE.chat}`, KEEPER.instructions].join("\n\n"));
    const view = await r.harness.guidance.get({ chatId: CLAIMED });
    expect(view.levels.map((l) => [l.id, l.whose, l.text, l.path, l.editable])).toEqual([
      ["user", "from the user, for every chat", GUIDANCE.user, "~/GUIDANCE.md", true],
      ["middle", HARBOUR.guidance.name, HARBOUR.guidance.text, null, false],
      ["chat", "for this chat", GUIDANCE.chat, "learned/GUIDANCE.md", true],
    ]);
    expect(view.levels[1]?.locked).toBeString();
    await expect(r.harness.guidance.set({ chatId: CLAIMED, level: "middle", text: "The harbour faces west.", base: null })).rejects.toMatchObject({ name: "HarnessRefusal", code: "forbidden" });
  });

  test("its own tool is offered, a call of it is served in its backend, and its answer is the tool's result", async () => {
    const r = await harbourTurn();
    const tides = r.host.calls[0]?.tools?.find((t) => t.name === HARBOUR.tides);
    expect(tides).toEqual({ name: TIDES.name, description: TIDES.description, parameters: TIDES.parameters });
    // The call says which agent of which run made it, and that it is the run's main agent: the extension's own keeper, with nobody over it.
    expect(r.sample.seen.calls).toEqual([{ name: HARBOUR.tides, args: { day: "today" }, turn: r.request.generationId, chatId: CLAIMED, agentId: started(r.host)[0]?.id ?? "", role: HARBOUR.keeper, callId: "c1", kind: "new", main: true, above: [] }]);
    expect(resultOf(r.host, "c1")).toEqual({ content: "Tide table for today: high water at 06:10 and 18:40, low water at 12:25.", failed: false });
  });

  test("its skill is listed in the agent's instructions, and skill_load gives its body", async () => {
    const r = await harbourTurn();
    expect(system(r.host.calls[0])).toEndWith(skills(r));
    expect(system(r.host.calls[0])).toEndWith(`\n- ${LOG_SKILL.id}: ${LOG_SKILL.name}. ${LOG_SKILL.description}`);
    expect(resultOf(r.host, "c2")).toEqual({ content: `[Skill ${LOG_SKILL.id}: ${LOG_SKILL.name}, characters 0 to ${LOG_SKILL.body.length} of ${LOG_SKILL.body.length}.]\n${LOG_SKILL.body}`, failed: false });
  });

  test("the writer is sent the messages as the extension rewrote them", async () => {
    const r = await harbourTurn();
    const plain = r.request.messages.map(({ source: _source, ...m }) => m);
    const built = [plain[0]!, { role: "system" as const, content: renderDefault(TEXT.writer.brief, { brief: BRIEF }) }, plain[1]!];
    // What it was handed is what the core built: Lumiverse's messages as they came, with the brief put in.
    expect(r.sample.seen.writer).toEqual([{ userId: "user-1", chatId: CLAIMED, generationId: r.request.generationId, kind: "new", brief: BRIEF, messages: built }]);
    const writer = r.host.calls.at(-1);
    expect(writer?.tools).toBeUndefined();
    expect(writer?.messages).toEqual([{ role: "system", content: HARBOUR.almanac }, ...built]);
  });

  test("its hooks hear the run begin before anything is sent to a model, then the reply written, then the run end with its record", async () => {
    const r = rig(quick);
    const sent: number[] = [];
    const began = r.sample.extension.runBegan;
    r.sample.extension.runBegan = async (run) => {
      sent.push(r.host.calls.length);
      await began?.(run);
    };
    const { result, request } = await r.turn();
    await until(() => r.sample.seen.hooks.length === 3);
    expect(sent).toEqual([0]);
    expect(result.record).not.toBeNull();
    expect(r.sample.seen.hooks).toEqual([
      { hook: "runBegan", told: { userId: "user-1", chatId: CLAIMED, turn: request.generationId, kind: "new", story: { hidden: "leave_out", from: "everyone", newest: "directive" } } },
      { hook: "replyWritten", told: { userId: "user-1", chatId: CLAIMED, turn: request.generationId, reply: REPLY, finish: "stop" } },
      { hook: "runEnded", told: { userId: "user-1", chatId: CLAIMED, turn: request.generationId, kind: "new", status: "done", reply: REPLY, record: result.record, usage: result.usage } },
    ]);
    // Every other member was told whose call it was too, and which chat's: one backend may serve every user of a Lumiverse.
    expect(r.sample.seen.asks).toEqual([
      { member: "definitions", userId: "user-1", chatId: CLAIMED },
      { member: "claim", userId: "user-1", chatId: CLAIMED },
      { member: "writerRequest", userId: "user-1", chatId: CLAIMED },
    ]);
  });

  test("a turn that fails is heard to begin and to end, with why, and no reply is said to be written", async () => {
    const r = rig((request) => (from(request) === "writer" ? REPLY : { content: "", finishReason: "stop" }), (s) => (s.reply.withoutBrief = "fail"));
    const { result, request } = await r.turn();
    await until(() => r.sample.seen.hooks.length === 2);
    await idle();
    expect(result.status).toBe("failed");
    expect(r.sample.seen.hooks).toEqual([
      { hook: "runBegan", told: { userId: "user-1", chatId: CLAIMED, turn: request.generationId, kind: "new", story: { hidden: "leave_out", from: "everyone", newest: "directive" } } },
      { hook: "runEnded", told: { userId: "user-1", chatId: CLAIMED, turn: request.generationId, kind: "new", status: "failed", reason: result.reason ?? "", reply: "", record: null, usage: result.usage } },
    ]);
  });

  test("what isn't a turn says whose it is too: a page's request, a job and a side session name the user the harness serves", async () => {
    const r = rig(() => "The tide turns at six.", undefined, { userId: "user-7" });
    // A page reads the definitions for a chat, and for no chat.
    await r.harness.definitions.get({ chatId: CLAIMED });
    await r.harness.definitions.get({});
    expect(r.sample.seen.asks).toEqual([
      { member: "definitions", userId: "user-7", chatId: CLAIMED },
      { member: "claim", userId: "user-7", chatId: CLAIMED },
      { member: "definitions", userId: "user-7", chatId: null },
    ]);
    // A job the user starts, and a side session's turn: their hooks name the same user.
    const { job } = await r.harness.jobs.start({ chatId: CLAIMED, agent: HARBOUR.reader, task: "Read the log.", when: "now" });
    await r.harness.jobs.run({ id: job.id }, new AbortController().signal);
    const { side } = await r.harness.sides.start({ chatId: null });
    await r.harness.side({ session: side.id, generationId: "side-turn-1", text: "When does the tide turn?" }, { progress: () => undefined, reasoning: () => undefined, content: () => undefined, done: () => undefined, error: () => undefined }, new AbortController().signal);
    await until(() => r.sample.seen.hooks.length === 4);
    expect(r.sample.seen.hooks.map((h) => [h.hook, h.told.userId, h.told.chatId, h.told.turn])).toEqual([
      ["runBegan", "user-7", CLAIMED, job.id],
      ["runEnded", "user-7", CLAIMED, job.id],
      ["runBegan", "user-7", "", "side-turn-1"],
      ["runEnded", "user-7", "", "side-turn-1"],
    ]);
  });

  test("the record on the reply's message is the extension's own with LumiAH's inside it, and the next turn resumes the session through it", async () => {
    const r = await harbourTurn();
    // The record as the host stores it: plain JSON.
    const stored = (record: unknown): JsonValue => JSON.parse(JSON.stringify(record)) as JsonValue;
    expect(r.host.last(CLAIMED).anchors).toEqual({ 0: { kind: "harbour_log", entry: 1, lumiah: stored(r.result.record) } });
    // The core is handed LumiAH's record alone, as the chat's path gives it.
    expect(recordOf((await r.host.chat.path(CLAIMED)).at(-1)?.anchor)).toEqual(r.result.record);
    r.host.say(CLAIMED, "user", "And tomorrow?");
    const before = r.host.calls.length;
    const second = await r.turn();
    expect(second.sink.progressLines[0]).toBe("LumiAH: the main agent carries its notes from 1 earlier turn.");
    // What it carries is the first turn's receipt, the extension's tool call in it.
    const keeper = r.host.calls[before];
    expect(keeper?.messages[1]).toEqual({ role: "user", content: "Reply #2 (new): a request of 2 messages, ending at chat message #1." });
    expect(keeper?.messages[2]?.content).toContain(`- ${HARBOUR.tides} {"day":"today"}\n  → Tide table for today: high water at 06:10 and 18:40, low water at 12:25.`);
    expect(r.host.last(CLAIMED).anchors).toEqual({ 0: { kind: "harbour_log", entry: 2, lumiah: stored(second.result.record) } });
  });

  test("a level the extension keeps as a text of its own is cut at Settings' length like any other, and its cut names no workspace file", async () => {
    const long = "The harbour bell rings the hours. ".repeat(10);
    const r = rig(quick, (s) => (s.guidance.chars = 100));
    r.sample.extension.claim = async () => ({ guidance: { name: HARBOUR.guidance.name, text: long } });
    await r.turn(CLAIMED);
    expect(system(r.host.calls[0])).toStartWith(`[Guidance ${HARBOUR.guidance.name}. Follow it.]\n${long.slice(0, 100)}\n[Cut here, at 100 of ${long.length} characters. The rest is in no workspace file, so it can't be read from here: work from what is above.]\n\n`);
  });

  test("a chat it doesn't claim is answered by LumiAH's own main agent, with none of the extension's guidance, and the writer's request as the core built it is still the extension's to rewrite", async () => {
    const r = rig(quick);
    await r.harness.guidance.set({ chatId: CLAIMED, level: "middle", text: GUIDANCE.harbour, base: null });
    const { request } = await r.turn(PLAIN);
    expect(system(r.host.calls[0])).toStartWith("You are the main agent behind a roleplay chat in Lumiverse.");
    expect(system(r.host.calls[0])).not.toContain(GUIDANCE.harbour);
    expect(started(r.host).map((a) => a.role)).toEqual(["main", "writer"]);
    expect(r.sample.seen.claims.at(-1)).toEqual({ id: PLAIN, name: PLAIN, characterId: null, characterName: null, branchedFrom: null });
    expect(r.sample.seen.writer.map((w) => w.generationId)).toEqual([request.generationId]);
  });
});

describe("a tool of the extension's that bears a built-in's name", () => {
  /** A world book LumiAH's own lore_search finds an entry in. */
  const LAMP = "The lamp was lit the night Ilse came home.";
  function withLore(host: MemoryHost): void {
    host.books.push({ id: "book-coast", name: "The Coast", description: "" });
    host.entries.push({ id: "11111111-aaaa-4000-8000-000000000001", bookId: "book-coast", title: "The Lamp", keys: ["lamp"], secondaryKeys: [], content: LAMP, enabled: true, constant: false });
  }

  test("stands in for the built-in in a chat the extension claims: one lore_search is offered, the extension's, and its backend serves the call", async () => {
    const r = rig(calling(call(HARBOUR.search, { query: "lamp" }, "c1")));
    withLore(r.host);
    const { request } = await r.turn(CLAIMED);
    const tools = r.host.calls[0]?.tools ?? [];
    expect(tools.filter((t) => t.name === HARBOUR.search)).toEqual([{ name: HARBOUR.search, description: SEARCH.description, parameters: SEARCH.parameters }]);
    expect(r.sample.seen.calls).toEqual([{ name: HARBOUR.search, args: { query: "lamp" }, turn: request.generationId, chatId: CLAIMED, agentId: started(r.host)[0]?.id ?? "", role: HARBOUR.keeper, callId: "c1", kind: "new", main: true, above: [] }]);
    expect(resultOf(r.host, "c1")).toEqual({ content: "The harbour's ledger has 1 of its 3 lines for “lamp”.\n- The lamp: Okoro lights it at dusk and owes the chandler for oil.", failed: false });
  });

  test("isn't offered in a chat the extension doesn't claim: LumiAH's own stands, and a call of it never reaches the extension", async () => {
    const r = rig(calling(call(HARBOUR.search, { query: "lamp" }, "c1")));
    withLore(r.host);
    await r.turn(PLAIN);
    const tools = r.host.calls[0]?.tools ?? [];
    expect(tools.filter((t) => t.name === HARBOUR.search).map((t) => t.description)).toEqual([renderDefault(TEXT.tool(HARBOUR.search))]);
    expect(r.sample.seen.calls).toEqual([]);
    // LumiAH's own search answered, from the world book: how it writes a hit is the lore tools' own test.
    expect(resultOf(r.host, "c1")).toEqual({ content: expect.stringContaining("[11111111] The Lamp"), failed: false });
  });

  test("a tool of the extension's with a name of its own is LumiAH's main agent's as it ships, in a chat the extension doesn't claim too, until the user takes the tools they added from it", async () => {
    const r = rig(calling(call(HARBOUR.tides, {}, "c1")));
    expect(r.stored.values.agents.main?.tools).toContain("@added");
    const { request } = await r.turn(PLAIN);
    expect(offered(r.host.calls[0])).toContain(HARBOUR.tides);
    expect(r.sample.seen.calls).toEqual([{ name: HARBOUR.tides, args: {}, turn: request.generationId, chatId: PLAIN, agentId: started(r.host)[0]?.id ?? "", role: "main", callId: "c1", kind: "new", main: true, above: [] }]);
    // Unticked, the main agent holds what its tools name and no more; named again by itself, the tool is back.
    const without = (s: Settings): void => void (s.agents.main!.tools = s.agents.main!.tools.filter((name) => name !== "@added"));
    const bare = rig(quick, without);
    await bare.turn(PLAIN);
    expect(offered(bare.host.calls[0])).not.toContain(HARBOUR.tides);
    expect(offered(bare.host.calls[0])).toContain("chat_read");
    const named = rig(quick, (s) => {
      without(s);
      s.agents.main!.tools.push(HARBOUR.tides);
    });
    await named.turn(PLAIN);
    expect(offered(named.host.calls[0])).toContain(HARBOUR.tides);
  });

  test("a claim that names nothing is still a claim: LumiAH's main agent answers, nothing is withdrawn, and the extension's tool stands in", async () => {
    const r = rig(quick);
    r.sample.extension.claim = async () => ({});
    await r.turn(CLAIMED);
    expect(started(r.host).map((a) => a.role)).toEqual(["main", "writer"]);
    const tools = r.host.calls[0]?.tools ?? [];
    expect(tools.filter((t) => t.name === HARBOUR.search).map((t) => t.description)).toEqual([SEARCH.description]);
    expect(offered(r.host.calls[0])).toContain(HARBOUR.withdrawn);
  });

  test("the page's list of definitions says which one stands in each chat", async () => {
    const r = rig(quick);
    const searchIn = async (chatId?: string) => (await r.harness.definitions.get(chatId === undefined ? {} : { chatId })).tools.filter((t) => t.name === HARBOUR.search).map(({ description: _description, parameters: _parameters, ...row }) => row);
    expect(await searchIn(CLAIMED)).toEqual([{ name: HARBOUR.search, family: "lore", tier: "read", runs: "extension", source: "extension", off: false }]);
    expect(await searchIn(PLAIN)).toEqual([{ name: HARBOUR.search, family: "lore", tier: "read", runs: "runtime", source: "builtin", off: false }]);
    expect(await searchIn()).toEqual([{ name: HARBOUR.search, family: "lore", tier: "read", runs: "runtime", source: "builtin", off: false }]);
    const names = async (chatId: string) => (await r.harness.definitions.get({ chatId })).tools.map((t) => t.name);
    expect(await names(CLAIMED)).not.toContain(HARBOUR.withdrawn);
    expect(await names(PLAIN)).toContain(HARBOUR.withdrawn);
    expect((await r.harness.definitions.get({ chatId: PLAIN })).tools.find((t) => t.name === HARBOUR.tides)).toEqual({ name: HARBOUR.tides, family: HARBOUR.family, tier: "external", description: TIDES.description, parameters: TIDES.parameters, runs: "extension", source: "extension", off: false });
  });

  /** A tool of an MCP server's, as the host lists it beside the extension's. */
  const mcp = (name: string): RemoteTool => ({ name, family: "mcp:charts", tier: "external", description: `The chart server's ${name}.`, parameters: { type: "object", properties: {} }, source: "user" });

  for (const order of ["after", "before"] as const) {
    test(`an MCP server's tool that bears a built-in's name, or the extension's, never replaces it, claimed chat or not (listed ${order} the extension's)`, async () => {
      const r = rig(calling(call("chat_read", { from: 0 }, "c1"), call("mcp:charts:depth", {}, "c2")), (s) => s.agents.main!.tools.push("mcp:charts:depth", HARBOUR.tides));
      const theirs = [mcp("chat_read"), mcp(HARBOUR.search), mcp(HARBOUR.tides), mcp("mcp:charts:depth")];
      r.host.tools = { list: async (chatId) => (order === "after" ? [...(await r.sample.tools.list(chatId)), ...theirs] : [...theirs, ...(await r.sample.tools.list(chatId))]), call: r.sample.tools.call };
      // A tool goes out under a name every provider takes (`mcp:charts:depth` as `mcp_charts_depth`); everything LumiAH keeps and shows holds its own name.
      const described = (name: string): string[] => (r.host.calls[0]?.tools ?? []).filter((t) => t.name === name.replace(/[^A-Za-z0-9_-]/g, "_")).map((t) => t.description);

      // Where the extension claims nothing, each built-in stands, and the server's own tool is offered beside them.
      await r.turn(PLAIN);
      expect(described("chat_read")).toEqual([renderDefault(TEXT.tool("chat_read"))]);
      expect(described(HARBOUR.search)).toEqual([renderDefault(TEXT.tool(HARBOUR.search))]);
      expect(described(HARBOUR.tides)).toEqual([TIDES.description]);
      expect(described("mcp:charts:depth")).toEqual(["The chart server's mcp:charts:depth."]);
      expect(resultOf(r.host, "c1")?.content).toStartWith("Chat messages #0 to #0 (1 asked for):");
      // The call of the built-in ran in the runtime; the call of the server's own tool went out.
      expect(r.sample.seen.calls.map((c) => c.name)).toEqual(["mcp:charts:depth"]);

      // Where it claims the chat, only the extension's own tool stands in for a built-in.
      r.host.calls.length = 0;
      await r.turn(CLAIMED);
      expect(described("chat_read")).toEqual([renderDefault(TEXT.tool("chat_read"))]);
      expect(described(HARBOUR.search)).toEqual([SEARCH.description]);
      expect(described(HARBOUR.tides)).toEqual([TIDES.description]);
      expect((await r.harness.definitions.get({ chatId: CLAIMED })).tools.filter((t) => t.name === HARBOUR.search || t.name === "chat_read" || t.name === HARBOUR.tides).map((t) => [t.name, t.source, t.runs])).toEqual([
        ["chat_read", "builtin", "runtime"],
        [HARBOUR.search, "extension", "extension"],
        [HARBOUR.tides, "extension", "extension"],
      ]);
    });
  }
});

describe("what a claim withdraws", () => {
  /**
   * What each agent was offered in a turn whose main agent hands a task to the extension's worker.
   * A sub-agent's tools are its own definition's here, whatever the agent that starts it holds: so
   * what it isn't offered is the claim's doing.
   */
  async function handed(chatId: string): Promise<{ main: string[]; sub: string[] }> {
    const r = rig(delegating(HARBOUR.reader), (s) => (s.delegation.grant = "definition"));
    await r.turn(chatId);
    const sub = r.host.calls.find((c) => from(c) === "sub");
    expect(system(sub)).toStartWith(READER.instructions);
    return { main: offered(r.host.calls.find((c) => from(c) === "main")), sub: offered(sub) };
  }

  test("is offered to none of the claimed chat's agents: not the main agent, not a sub-agent it delegates to", async () => {
    // Both definitions name it: the keeper by its family, the reader by its name.
    expect(await handed(CLAIMED)).toEqual({
      main: [HARBOUR.tides, "lore_index", HARBOUR.search, "lore_read", "lore_related", "lore_about", "active_lore", "chat_read", "skill_load", "delegate", "agent_message", "write_reply", "scratch_read"],
      sub: [HARBOUR.tides, HARBOUR.search, "scratch_read"],
    });
  });

  test("is offered as usual in a chat the extension doesn't claim", async () => {
    const { main, sub } = await handed(PLAIN);
    expect(main).toContain(HARBOUR.withdrawn);
    expect(sub).toEqual([HARBOUR.tides, HARBOUR.search, HARBOUR.withdrawn, "scratch_read"]);
  });

  test("doesn't cost the user a definition of their own that names it: theirs still stands over the extension's in the claimed chat, without that tool", async () => {
    const r = rig(delegating(HARBOUR.reader), (s) => (s.delegation.grant = "definition"));
    r.stored.definitions = { agents: { [HARBOUR.reader]: { ...READER, instructions: "Read the tide table aloud, slowly.", tools: [HARBOUR.withdrawn, "chat_read"] } } };
    await r.turn(CLAIMED);
    const sub = r.host.calls.find((c) => from(c) === "sub");
    expect(system(sub)).toBe("Read the tide table aloud, slowly.");
    expect(offered(sub)).toEqual(["chat_read", "scratch_read"]);
    expect(r.host.logs).toEqual([]);
  });

  test("stays withdrawn whatever Settings give the agent", async () => {
    const r = rig(quick, (s) => (s.agents[HARBOUR.keeper] = { ...KEEPER, tools: [HARBOUR.withdrawn, "lore_read", "write_reply"] }));
    await r.turn(CLAIMED);
    expect(offered(r.host.calls[0])).toEqual(["lore_read", "write_reply", "scratch_read"]);
  });

  test("changes nothing when it names no built-in: the extension's own tool, an agent, a name that is nothing", async () => {
    const claimed = async (withdraw: string[]) => {
      const r = rig(quick);
      r.sample.extension.claim = async () => ({ mainAgent: HARBOUR.keeper, withdraw });
      await r.turn(CLAIMED);
      return offered(r.host.calls[0]);
    };
    const nothing = await claimed([]);
    expect(nothing).toContain(HARBOUR.tides);
    expect(nothing).toContain(HARBOUR.withdrawn);
    expect(await claimed([HARBOUR.tides, HARBOUR.reader, "no_such_tool"])).toEqual(nothing);
  });
});

describe("an extension that is slow or broken never holds a turn", () => {
  const WAIT = 4000;
  const slow = (s: Settings): void => void (s.extension.waitMs = WAIT);
  const never = (): Promise<never> => new Promise<never>(() => undefined);

  /**
   * Lets a turn come to rest on its `nth` wait for the extension since `before`, and moves the host's
   * clock on to the end of that wait, to the millisecond: how many model calls had been made when it
   * rested, which is still how many there are a millisecond short of the wait.
   */
  async function waitOut(host: MemoryHost, before: number, nth: number): Promise<number> {
    await until(() => host.clock.slept.length >= before + nth);
    await idle();
    const sent = host.calls.length;
    host.clock.advance(WAIT - 1);
    await idle();
    expect(host.calls).toHaveLength(sent);
    host.clock.advance(1);
    return sent;
  }

  test("a claim that never answers costs Settings' wait and no more: the chat is answered as one the extension doesn't claim", async () => {
    const r = rig(quick, slow);
    r.sample.extension.claim = never;
    const before = r.host.clock.slept.length;
    const running = r.turn(CLAIMED);
    // A run asks for the definitions and the claim together: the claim's is the second wait.
    expect(await waitOut(r.host, before, 2)).toBe(0);
    const { result } = await running;
    expect(result).toMatchObject({ status: "done", reply: REPLY });
    expect(started(r.host).map((a) => a.role)).toEqual(["main", "writer"]);
    expect(offered(r.host.calls[0])).toContain(HARBOUR.withdrawn);
    expect(logged(r.host, HARBOUR.name, "gave no answer for the chat", `no answer in ${WAIT} ms`)).toBeString();
  });

  test("definitions that are refused cost nothing: the run goes on with LumiAH's own and the user's", async () => {
    const r = rig(quick, slow);
    r.sample.extension.definitions = () => Promise.reject(new Error("the harbour office is shut"));
    const { result } = await r.turn(CLAIMED);
    expect(result).toMatchObject({ status: "done", reply: REPLY });
    // The agent its claim names isn't there to answer, so LumiAH's own does; the rest of the claim holds.
    expect(started(r.host).map((a) => a.role)).toEqual(["main", "writer"]);
    expect(offered(r.host.calls[0])).not.toContain(HARBOUR.withdrawn);
    expect(logged(r.host, HARBOUR.name, "gave no definitions", "the harbour office is shut")).toBeString();
  });

  test("a writer's request that throws leaves the writer the messages as the core built them", async () => {
    const r = rig(quick, slow);
    r.sample.extension.writerRequest = () => {
      throw new Error("the almanac is lost");
    };
    const { result, request } = await r.turn(CLAIMED);
    expect(result).toMatchObject({ status: "done", reply: REPLY });
    const plain = request.messages.map(({ source: _source, ...m }) => m);
    expect(r.host.calls.at(-1)?.messages).toEqual([plain[0]!, { role: "system", content: renderDefault(TEXT.writer.brief, { brief: BRIEF }) }, plain[1]!]);
    expect(logged(r.host, HARBOUR.name, "gave no writer's request", "the almanac is lost")).toBeString();
  });

  test("a writer's request that never comes costs Settings' wait and no more", async () => {
    const r = rig(quick, slow);
    r.sample.extension.writerRequest = never;
    const before = r.host.clock.slept.length;
    const running = r.turn(CLAIMED);
    // The definitions, the claim, the run beginning, then the writer's request: the main agent has made its one call by then.
    expect(await waitOut(r.host, before, 4)).toBe(1);
    const { result } = await running;
    expect(result).toMatchObject({ status: "done", reply: REPLY });
    expect(r.host.calls.at(-1)?.messages.map((m) => m.content)).not.toContain(HARBOUR.almanac);
    expect(logged(r.host, HARBOUR.name, "gave no writer's request", `no answer in ${WAIT} ms`)).toBeString();
  });

  test("a run's beginning that is never answered holds the first model call for Settings' wait and no more", async () => {
    const r = rig(quick, slow);
    r.sample.extension.runBegan = never;
    const before = r.host.clock.slept.length;
    const running = r.turn(CLAIMED);
    expect(await waitOut(r.host, before, 3)).toBe(0);
    const { result } = await running;
    expect(result).toMatchObject({ status: "done", reply: REPLY });
    expect(started(r.host).map((a) => a.role)).toEqual([HARBOUR.keeper, "writer"]);
    expect(logged(r.host, HARBOUR.name, "gave no answer to a run beginning", `no answer in ${WAIT} ms`)).toBeString();
  });

  test("a hook that never answers after the reply holds nothing: the turn ends at once, and the hook after it is called once the wait is out", async () => {
    const r = rig(quick, slow);
    r.sample.extension.replyWritten = never;
    const t0 = r.host.clock.now();
    const { result } = await r.turn(CLAIMED);
    expect(result).toMatchObject({ status: "done", reply: REPLY });
    expect(r.host.clock.now()).toBe(t0);
    await idle();
    expect(r.sample.seen.hooks.map((h) => h.hook)).toEqual(["runBegan"]);
    r.host.clock.advance(WAIT);
    await until(() => r.sample.seen.hooks.length === 2);
    expect(r.sample.seen.hooks.map((h) => h.hook)).toEqual(["runBegan", "runEnded"]);
    expect(logged(r.host, HARBOUR.name, "the reply being written", `no answer in ${WAIT} ms`)).toBeString();
  });

  test("with no wait set, an answer is waited for as long as it takes", async () => {
    const r = rig(quick, (s) => (s.extension.waitMs = null));
    const began = Promise.withResolvers<void>();
    r.sample.extension.runBegan = () => began.promise;
    const before = r.host.clock.slept.length;
    const running = r.turn(CLAIMED);
    await idle(30);
    // Nothing waits on the clock, and nothing was sent to a model.
    expect(r.host.clock.slept.length).toBe(before);
    expect(r.host.calls).toHaveLength(0);
    began.resolve();
    expect((await running).result).toMatchObject({ status: "done", reply: REPLY });
    expect(r.host.logs).toEqual([]);
  });
});

describe("what the extension lists and answers is outside data", () => {
  test("a listed tool with no name, an unknown tier or no schema is left out with a line in the log, and the run goes on with the rest", async () => {
    const r = rig(calling(call(HARBOUR.tides, {}, "c1")));
    const { parameters: _parameters, ...noSchema } = { ...TIDES, name: "harbour_berths" };
    r.host.tools = { list: async () => [{ ...TIDES, name: "" }, { ...TIDES, name: "harbour_locks", tier: "root" }, noSchema, null, "harbour_pilots", TIDES] as unknown as RemoteTool[], call: r.sample.tools.call };
    const { result } = await r.turn(CLAIMED);
    expect(result).toMatchObject({ status: "done", reply: REPLY });
    // Of the keeper's family, the one that is a tool is offered, and runs.
    expect(offered(r.host.calls[0]).filter((name) => name.startsWith("harbour_"))).toEqual([HARBOUR.tides]);
    expect(resultOf(r.host, "c1")?.failed).toBe(false);
    const lines = r.host.logs.map((line) => line.message).filter((message) => message.includes("isn't one"));
    expect(lines).toHaveLength(5);
    expect(lines.filter((line) => line.includes("(no name)"))).toHaveLength(3);
    expect(lines.some((line) => line.includes("(harbour_locks)"))).toBe(true);
    expect(lines.some((line) => line.includes("(harbour_berths)"))).toBe(true);
    expect(r.host.logs.every((line) => line.level === "warn")).toBe(true);
  });

  test("a list that isn't one, or that can't be had, gives the run none of the extension's tools: LumiAH's own stand", async () => {
    for (const list of [async () => ({ tools: [TIDES] }) as unknown as RemoteTool[], () => Promise.reject(new Error("the link dropped"))]) {
      const r = rig(quick);
      r.host.tools = { list, call: r.sample.tools.call };
      const { result } = await r.turn(CLAIMED);
      expect(result).toMatchObject({ status: "done", reply: REPLY });
      expect(started(r.host).map((a) => a.role)).toEqual([HARBOUR.keeper, "writer"]);
      expect(offered(r.host.calls[0])).not.toContain(HARBOUR.tides);
      expect((r.host.calls[0]?.tools ?? []).filter((t) => t.name === HARBOUR.search).map((t) => t.description)).toEqual([renderDefault(TEXT.tool(HARBOUR.search))]);
    }
  });

  test("a listed tool's answer reaches the model whole up to the length it says it gives whole; a length that isn't one is left off with a line in the log", async () => {
    const long = "The tide table for the whole season, hour by hour. ".repeat(240);
    for (const [wholeChars, whole] of [[20_000, true], [0, false], ["lots", false]] as const) {
      const r = rig(calling(call(HARBOUR.tides, {}, "c1")));
      r.host.tools = { list: async () => [{ ...TIDES, wholeChars }] as unknown as RemoteTool[], call: async () => ({ text: long }) };
      const { result } = await r.turn(CLAIMED);
      expect(result).toMatchObject({ status: "done", reply: REPLY });
      const content = resultOf(r.host, "c1")?.content ?? "";
      expect(content === long).toBe(whole);
      if (whole) continue;
      // Still offered, and clipped as any tool's answer is.
      expect(content).toContain(`[Clipped: the first 6000 of ${long.length} characters.`);
      expect(logged(r.host, HARBOUR.tides, "reads whole")).toBeDefined();
    }
  });

  test("a tool call the extension's port rejects is a failed result the model reads, not a failed turn", async () => {
    const r = rig(calling(call(HARBOUR.tides, {}, "c1")));
    r.host.tools = { list: r.sample.tools.list, call: () => Promise.reject(new Error("the tide gauge is offline")) };
    const { result } = await r.turn(CLAIMED);
    expect(resultOf(r.host, "c1")).toEqual({ content: `${HARBOUR.tides} failed: the tide gauge is offline`, failed: true });
    expect(result).toMatchObject({ status: "done", reply: REPLY });
    expect(started(r.host).map((a) => a.role)).toEqual([HARBOUR.keeper, "writer"]);
  });

  test("a failure the port answers with is the tool's result, marked as failed", async () => {
    const r = rig(calling(call(HARBOUR.tides, {}, "c1")));
    r.host.tools = { list: r.sample.tools.list, call: async () => ({ text: "The tide gauge is being mended. Ask again after noon.", error: true }) };
    await r.turn(CLAIMED);
    expect(resultOf(r.host, "c1")).toEqual({ content: "The tide gauge is being mended. Ask again after noon.", failed: true });
  });

  test("an answer that holds no text is a failed result too: the agent reads that the tool gave nothing, and goes on", async () => {
    for (const answer of [null, {}, { text: 7 }, "high water at six"]) {
      const r = rig(calling(call(HARBOUR.tides, {}, "c1")));
      r.host.tools = { list: r.sample.tools.list, call: async () => answer as unknown as { text: string } };
      const { result } = await r.turn(CLAIMED);
      expect(resultOf(r.host, "c1")?.failed).toBe(true);
      expect(resultOf(r.host, "c1")?.content).toContain(HARBOUR.tides);
      expect(result).toMatchObject({ status: "done", reply: REPLY });
      // The main agent went on to its brief: the writer wasn't left to write without one.
      expect(r.host.calls.at(-1)?.messages.map((m) => m.content)).toContain(renderDefault(TEXT.writer.brief, { brief: BRIEF }));
    }
  });

  test("a definition or a skill that isn't one is left out with a line in the log, and the run goes on with the rest", async () => {
    const r = rig(delegating(HARBOUR.reader));
    r.sample.extension.definitions = async () => ({ agents: [null, { id: "harbour_pilot", name: "Pilot" }, KEEPER, READER], skills: [{ id: "harbour_knots", name: "Knots" }, "splice", LOG_SKILL] }) as never;
    const { result } = await r.turn(CLAIMED);
    expect(result).toMatchObject({ status: "done", reply: REPLY });
    expect(started(r.host).map((a) => a.role)).toEqual([HARBOUR.keeper, HARBOUR.reader, "writer"]);
    const answer = await r.harness.definitions.get({ chatId: CLAIMED });
    // The two that are definitions stand after the core's own; the two that aren't are nowhere.
    const core = { agents: r.harness.agents.all().map((d) => d.id), skills: r.harness.skills.all().map((s) => s.id) };
    expect(core.agents.slice(0, 3)).toEqual(["main", "writer", "summarizer"]);
    expect(answer.agents.map((a) => a.id)).toEqual([...core.agents, HARBOUR.keeper, HARBOUR.reader]);
    expect(answer.skills.map((s) => s.id)).toEqual([...core.skills, HARBOUR.skill]);
    expect(logged(r.host, "the extension's agent definition", "harbour_pilot", "description")).toBeString();
    expect(logged(r.host, "the extension's agent definition", "It must be an agent definition.")).toBeString();
    expect(logged(r.host, "the extension's skill", "harbour_knots", "body")).toBeString();
    expect(logged(r.host, "the extension's skill", "It must be a skill.")).toBeString();
  });

  test("an answer for a chat that isn't a claim claims nothing", async () => {
    const r = rig(quick);
    r.sample.extension.claim = async () => "mine" as never;
    await r.turn(CLAIMED);
    expect(started(r.host).map((a) => a.role)).toEqual(["main", "writer"]);
    expect((r.host.calls[0]?.tools ?? []).filter((t) => t.name === HARBOUR.search).map((t) => t.description)).toEqual([renderDefault(TEXT.tool(HARBOUR.search))]);
  });

  test("a writer's request that isn't messages is not sent: the writer gets the messages as the core built them, and the log says so", async () => {
    for (const answer of [[], "the almanac", [null], [{ role: "pilot", content: "High water at six." }], [{ role: "system", content: 6 }]]) {
      const r = rig(quick);
      r.sample.extension.writerRequest = async () => answer as never;
      const { result, request } = await r.turn(CLAIMED);
      expect(result).toMatchObject({ status: "done", reply: REPLY });
      const plain = request.messages.map(({ source: _source, ...m }) => m);
      expect(r.host.calls.at(-1)?.messages).toEqual([plain[0]!, { role: "system", content: renderDefault(TEXT.writer.brief, { brief: BRIEF }) }, plain[1]!]);
      expect(logged(r.host, "writer's request", "isn't a list of model messages")).toBeString();
    }
  });
});

describe("an extension's tools and the user's word", () => {
  /** External tools set to ask first: one switch on the Tools page. */
  const asking = (s: Settings): void => void (s.approval.tiers.external = "ask");

  test("as LumiAH ships, a call of its external tool runs with nobody asked: installing the extension was the user's word", async () => {
    const r = rig(calling(call(HARBOUR.tides, { day: "today" }, "c1")));
    expect(defaultSettings().approval.tiers.external).toBe("allow");
    const asks: ApprovalAsk[] = [];
    r.host.approvals = { ask: async (ask) => (asks.push(ask), { decision: "refused" }) };
    await r.turn(CLAIMED);
    expect(asks).toEqual([]);
    expect(r.sample.seen.calls.map((c) => c.callId)).toEqual(["c1"]);
    expect(resultOf(r.host, "c1")?.failed).toBe(false);
  });

  test("set to ask with nobody to ask, a call of its external tool is refused in words and never reaches its backend; its read tool runs", async () => {
    const r = rig(calling(call(HARBOUR.tides, {}, "c1"), call(HARBOUR.search, { query: "berth" }, "c2")), asking);
    const { result } = await r.turn(CLAIMED);
    expect(resultOf(r.host, "c1")).toEqual({ content: `Not run: this call of ${HARBOUR.tides} needs the user's approval, and there is no way to ask them here. Go on without it, or say in your answer what you needed it for.`, failed: true });
    expect(r.sample.seen.calls.map((c) => c.name)).toEqual([HARBOUR.search]);
    expect(resultOf(r.host, "c2")?.failed).toBe(false);
    expect(result).toMatchObject({ status: "done", reply: REPLY });
  });

  test("with somebody to ask, the call is held as an external tool's, and runs once they say yes", async () => {
    const r = rig(calling(call(HARBOUR.tides, { day: "today" }, "c1")), asking);
    const asks: ApprovalAsk[] = [];
    r.host.approvals = { ask: async (ask) => (asks.push(ask), { decision: "once" }) };
    const { request } = await r.turn(CLAIMED);
    expect(asks).toMatchObject([{ turn: request.generationId, chatId: CLAIMED, role: HARBOUR.keeper, callId: "c1", tool: HARBOUR.tides, tier: "external", args: { day: "today" } }]);
    expect(r.sample.seen.calls.map((c) => c.callId)).toEqual(["c1"]);
    expect(resultOf(r.host, "c1")?.failed).toBe(false);
  });

  test("Settings may let one of its tools run by name while the tier still asks", async () => {
    const r = rig(calling(call(HARBOUR.tides, {}, "c1")), (s) => {
      asking(s);
      s.approval.tools[HARBOUR.tides] = "allow";
    });
    await r.turn(CLAIMED);
    expect(r.sample.seen.calls.map((c) => c.callId)).toEqual(["c1"]);
  });
});

describe("what counts as the story, in a run", () => {
  /** The opening note's word on the user's direction where only the model's replies are the story, as the chat stands before the turn. */
  async function noteOf(host: MemoryHost, chatId: string, newest: "directive" | "leave_out"): Promise<string> {
    const before = await host.chat.path(chatId);
    const note = await directedNote({ source: { hidden: "leave_out", from: "replies", newest }, before, read: async (m) => (await host.chat.messages(chatId, m.index, m.index + 1))[0]?.content ?? null, texts: new Texts() });
    if (note === null) throw new Error("no note where only the replies are the story");
    return note;
  }
  /** Everything the main agent was sent, as one text. */
  const toMain = (host: MemoryHost): string => host.calls.filter((c) => from(c) === "main").flatMap((c) => c.messages.map((m) => m.content)).join("\n");
  const replies = (newest: "directive" | "leave_out") => (s: Settings): void => void (s.story = { hidden: "leave_out", from: "replies", newest });

  test("the claim's word, then the chat's own choice, then the user's setting, member by member: the run is told what holds", async () => {
    const r = rig(quick, (s) => void (s.story = { hidden: "include", from: "everyone", newest: "leave_out" }), { story: { from: "replies" } });
    r.host.infos.set(CLAIMED, { story: { hidden: "leave_out", from: "everyone" } });
    await r.turn();
    await until(() => r.sample.seen.hooks.length === 3);
    expect(r.sample.seen.hooks.flatMap((h) => (h.hook === "runBegan" ? [h.told.story] : []))).toEqual([{ hidden: "leave_out", from: "replies", newest: "leave_out" }]);
  });

  test("with only the replies, the main agent is told the user directs it, with the newest message as the direction or without it; with everyone's, nothing is added", async () => {
    const directive = rig(quick, replies("directive"));
    const told = await noteOf(directive.host, PLAIN, "directive");
    expect(told).toContain("I ask Brann when the tide turns.");
    await directive.turn(PLAIN);
    expect(toMain(directive.host)).toContain(told);

    const quiet = rig(quick, replies("leave_out"));
    const untold = await noteOf(quiet.host, PLAIN, "leave_out");
    expect(untold).not.toContain("I ask Brann");
    await quiet.turn(PLAIN);
    expect(toMain(quiet.host)).toContain(untold);

    const everyone = rig(quick);
    const notes = [await noteOf(everyone.host, PLAIN, "directive"), await noteOf(everyone.host, PLAIN, "leave_out")];
    await everyone.turn(PLAIN);
    for (const note of notes) expect(toMain(everyone.host)).not.toContain(note);
  });
});
