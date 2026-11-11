// Side sessions (DESIGN §19) on the in-memory host and a scripted model: a conversation with an
// agent that is no reply in a chat. Whom it is with and what it is about, what it has of a turn's
// (its tools, the workspace, guidance, the live view), how it is kept (in the store, on no message),
// how a long one is summarized, and what the user can do while it answers.

import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../../src/core/agents";
import { createHarness, type Harness, type StoredState } from "../../src/core/harness";
import { textHash } from "../../src/core/hash";
import type { ModelRequest, TraceEvent } from "../../src/core/ports";
import { HarnessRefusal } from "../../src/core/refusal";
import { defaultSettings, newAgentSettings, type Settings } from "../../src/core/settings";
import { renderDefault, TEXT } from "../../src/core/texts";
import { transcriptOf } from "../../src/core/transcript";
import { versionOf } from "../../src/core/workspace";
import { type Answer, call, idle, MemoryHost, runTurn, type Script, Sink, until } from "./support/host";

const CHAT = "chat-1";
const never = new AbortController().signal;

const MAIN = renderDefault(TEXT.main.system);
const SUMMARIZER = renderDefault(TEXT.agents.summarizer);
const SCOUT = "You are a scout. Find what you are asked for and say it in a line.";

/** What follows an agent's instructions in a side session: that it is one, and what it is about. */
const SIDE = "This is a side conversation with the user, on LumiAH's page: not a reply in a chat. Answer the user directly, as yourself. Nothing you write here goes into a chat's messages, and there is no writer: your answer is what they read.";
const ABOUT_CHAT = `${SIDE} It is about the chat “The lighthouse”: your chat, lore and workspace tools read that chat as it stands now.`;
const ABOUT_NOTHING = `${SIDE} It is about no chat in particular: there is no chat or lore to read, and of the workspace only the user's own files (~/).`;

/** What ends the instructions of an agent that holds skill_load, as the main agent does: the skills the core ships, each by its id, name and what it is for. */
const SKILLS = `\n\nSkills you can load with skill_load. Each is a procedure written for you: load one when what you are doing is what it is for, and follow it.\n${createHarness(new MemoryHost(), { settings: async () => ({ values: defaultSettings(), texts: {} }) })
  .skills.all()
  .map((skill) => `- ${skill.id}: ${skill.name}. ${skill.description}`)
  .join("\n")}`;

/** What ends the first message of an agent that has `n` rounds of tool calls. */
const rounds = (n: number): string => `\n\n[You have ${n} rounds of tool calls for this. A round is one answer of yours that calls tools, however many. An answer that calls a tool after your last round isn't run and your work stops there, so keep a round for what must come last.]`;

/** A host with a short chat, and a harness over it whose settings, texts and definitions the test changes; `options` makes a second harness over the same host, as a restart does. */
function rig(script: Script, change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  host.script = script;
  host.infos.set(CHAT, { name: "The lighthouse" });
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I walk down to the lighthouse and knock.");
  const stored: StoredState & { values: Settings; texts: Record<string, string> } = { values: defaultSettings(), texts: {} };
  change(stored.values);
  const options = { settings: async () => structuredClone(stored) };
  const harness = createHarness(host, options);
  let turns = 0;
  /** A side session started about the chat (null: about none), with the main agent unless one is named: its id. */
  const start = async (chatId: string | null = CHAT, agent?: string): Promise<string> => (await harness.sides.start({ chatId, ...(agent !== undefined ? { agent } : {}) })).side.id;
  /** One turn of a side session, as the runtime drives it: what the user says, a sink of its own, and the turn's id. */
  const ask = async (session: string, text: string, signal: AbortSignal = never, on: Harness = harness) => {
    const sink = new Sink();
    const generationId = `side-turn-${++turns}`;
    const result = await on.side({ session, generationId, text }, sink, signal);
    return { result, sink, generationId };
  };
  return { host, harness, stored, options, start, ask };
}

/** A script that answers each call with the next of `lines`, whoever makes it: a line is an answer, or what gives one when its call is made. */
function lines(...answers: (Answer | ((request: ModelRequest) => Answer | Promise<Answer>))[]): Script {
  return (request, n) => {
    const line = answers[n];
    if (line === undefined) throw new Error(`no answer scripted for call ${n + 1}`);
    return typeof line === "function" ? line(request) : line;
  };
}

/** A call's instructions: its system message. */
const system = (request: ModelRequest | undefined): string => (request?.messages[0]?.role === "system" ? request.messages[0].content : "");

/** A call's conversation: what follows its instructions, each message's role and text. */
const conversation = (request: ModelRequest | undefined): { role: string; content: string }[] => (request?.messages ?? []).filter((m) => m.role !== "system").map(({ role, content }) => ({ role, content }));

const toolsOf = (request: ModelRequest | undefined): string[] => request?.tools?.map((tool) => tool.name) ?? [];

const events = (host: MemoryHost, turn: string): TraceEvent[] => host.traced.filter((t) => t.turn === turn).map((t) => t.event);

/** What a model was told a tool call came to: the call's result, as the request after it held it. */
function resultOf(host: MemoryHost, callId: string): { content: string; isError: boolean } | null {
  for (const request of host.calls) {
    for (const m of request.messages) {
      for (const part of m.parts ?? []) if (part.type === "tool_result" && part.toolUseId === callId) return { content: part.content, isError: part.isError === true };
    }
  }
  return null;
}

/** What a request was refused with. */
async function refusal(asked: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await asked;
  } catch (error) {
    if (error instanceof HarnessRefusal) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("the request wasn't refused");
}

const version = async (text: string): Promise<string> => versionOf(await textHash(text));

/** What `workspace_read` answers for a file read whole. */
const page = async (path: string, text: string): Promise<string> => `[${path}: characters 0 to ${text.length} of ${text.length}, version ${await version(text)}. A write, an edit, a move or a delete of this file takes that version as base.]\n${text}`;

/** A definition registered beside the core's: it runs with what a new agent runs with. */
function scout(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: "scout", name: "Scout", description: "Finds what it is asked for.", instructions: SCOUT, given: "task", ...newAgentSettings(), ...over };
}

// ---------------------------------------------------------------- with the main agent, about a chat

describe("a side session with the main agent about a chat", () => {
  const script = (): Script => lines({ content: "Let me look.", toolCalls: [call("chat_search", { query: "lighthouse" }, "c1")], usage: { prompt_tokens: 1000, completion_tokens: 40 } }, { content: "Nobody says who keeps it. Mara only knocks.", usage: { prompt_tokens: 1200, completion_tokens: 60 } });

  test("the agent is told, after its own instructions, that this is a side conversation and which chat it is about", async () => {
    const r = rig(script());
    const id = await r.start();
    await r.ask(id, "Who keeps the lighthouse?");
    expect(system(r.host.calls[0])).toBe(`${MAIN}\n\n${ABOUT_CHAT}${SKILLS}`);
    // What the user said is its message, as they said it, with its rounds told as to every agent.
    expect(conversation(r.host.calls[0])).toEqual([{ role: "user", content: `Who keeps the lighthouse?${rounds(24)}` }]);
  });

  test("what it is told is the user's text where they replaced it", async () => {
    const r = rig(script());
    r.stored.texts["side.about"] = "You are talking with the user outside the story. {{about}}";
    r.stored.texts["side.about.chat"] = "The chat in question: {{chat}}.";
    await r.ask(await r.start(), "Who keeps the lighthouse?");
    expect(system(r.host.calls[0])).toBe(`${MAIN}\n\nYou are talking with the user outside the story. The chat in question: The lighthouse.${SKILLS}`);
  });

  test("it has a turn's tools over the chat, its lore and the workspace, and none that belong to a generation: no write_reply", async () => {
    const r = rig(lines(...["One.", "Two.", "Three."]));
    await r.ask(await r.start(), "Who keeps the lighthouse?");
    const offered = toolsOf(r.host.calls[0]);
    expect(offered).toEqual(expect.arrayContaining(["chat_search", "chat_grep", "chat_read", "lore_index", "lore_search", "lore_grep", "lore_read", "past_turn", "workspace_list", "workspace_read", "workspace_grep", "workspace_write", "workspace_edit", "workspace_move", "workspace_delete", "workspace_pin", "delegate", "agent_message", "job_start"]));
    expect(offered).not.toContain("write_reply");
    // The same tools as the chat's own turn gives its main agent, less the three a generation alone has: what Lumiverse activated for it, its preset, and its reply.
    await runTurn(r.host, r.harness, CHAT);
    const turn = toolsOf(r.host.calls[1]);
    expect(turn).toContain("write_reply");
    expect(offered).toEqual(turn.filter((name) => !["active_lore", "preset_instructions", "write_reply"].includes(name)));
  });

  test("it works with its tools and answers: the answer goes to the sink whole, with one done", async () => {
    const r = rig(script());
    const { result, sink } = await r.ask(await r.start(), "Who keeps the lighthouse?");
    // Its tool ran over the chat as it stands, and it read the result.
    expect(resultOf(r.host, "c1")).toEqual({ content: expect.stringContaining("I walk down to the lighthouse and knock."), isError: false });
    expect(result).toMatchObject({ status: "done", reply: "Nobody says who keeps it. Mara only knocks.", usage: { calls: 2, toolTurns: 1, in: 2200, out: 100 } });
    expect(result.reason).toBeUndefined();
    expect(sink.order).toEqual(["content", "done"]);
    expect(sink.text).toBe("Nobody says who keeps it. Mara only knocks.");
    expect(sink.ended).toEqual({ finish: "stop", usage: result.usage });
    expect(sink.failed).toBeNull();
  });

  test("nothing is written to the chat's messages, and no record is anchored", async () => {
    const r = rig(lines({ toolCalls: [call("workspace_write", { path: "/notes/keeper.md", content: "Nobody says who keeps it.", base: "new" }, "w1")] }, "Noted."));
    const before = structuredClone(r.host.chats.get(CHAT));
    const { result } = await r.ask(await r.start(), "Note who keeps the lighthouse.");
    expect(result.status).toBe("done");
    expect(resultOf(r.host, "w1")?.isError).toBe(false);
    expect(r.host.chats.get(CHAT)).toEqual(before);
    expect((await r.host.chat.anchors()).anchors).toEqual([]);
    expect(Object.keys(result).sort()).toEqual(["reply", "status", "turn", "usage"]);
  });
});

// ---------------------------------------------------------------- kept in the store

describe("a side session is kept in the store", () => {
  const script = (): Script => lines({ toolCalls: [call("chat_search", { query: "lighthouse" }, "c1")], usage: { prompt_tokens: 1000, completion_tokens: 40 } }, { content: "Nobody says who keeps it.", usage: { prompt_tokens: 1200, completion_tokens: 60 } }, "Brann holds the key.", "Ilse.");

  test("each turn is kept with what was said, what was answered, how it ended, what it spent and its transcript", async () => {
    const r = rig(script());
    const id = await r.start();
    const { result, generationId } = await r.ask(id, "Who keeps the lighthouse?");
    const { side, turns } = await r.harness.sides.turns({ id });
    expect(side).toMatchObject({ id, chatId: CHAT, agent: "main", turns: 1 });
    expect(turns).toEqual([{ turn: generationId, at: r.host.clock.now(), asked: "Who keeps the lighthouse?", answered: "Nobody says who keeps it.", status: "done", usage: result.usage, transcript: expect.any(String) as unknown as string }]);
    expect(turns[0]?.usage).toMatchObject({ calls: 2, toolTurns: 1, in: 2200, out: 100 });
    // The turn as it came back is the turn as it was kept, its words by their blobs.
    expect(result.turn).toMatchObject({ turn: generationId, status: "done", transcript: turns[0]?.transcript ?? "" });
    expect([r.host.blobStore.get(result.turn?.asked ?? ""), r.host.blobStore.get(result.turn?.answered ?? "")]).toEqual(["Who keeps the lighthouse?", "Nobody says who keeps it."]);
    // Its transcript is the turn's live view, whole: every event the trace port was handed.
    const transcript = transcriptOf(r.host.blobStore.get(turns[0]?.transcript ?? "") ?? "");
    expect(transcript).toMatchObject({ turn: generationId, chatId: CHAT, generation: "side", messageId: null, ended: { status: "done" } });
    expect(transcript?.events).toEqual(r.host.traced);
    expect(transcript?.events.at(-1)?.event.kind).toBe("turn_ended");
  });

  test("no transcript is kept while Settings keep none", async () => {
    const r = rig(script(), (s) => (s.keep.transcripts = false));
    const id = await r.start();
    await r.ask(id, "Who keeps the lighthouse?");
    const [turn] = (await r.harness.sides.turns({ id })).turns;
    expect(turn).toMatchObject({ asked: "Who keeps the lighthouse?", answered: "Nobody says who keeps it.", status: "done" });
    expect(turn?.transcript).toBeUndefined();
  });

  test("the next turn's request holds the conversation so far: what was said and what was answered, in order", async () => {
    const r = rig(script());
    const id = await r.start();
    await r.ask(id, "Who keeps the lighthouse?");
    await r.ask(id, "And who holds its key?");
    await r.ask(id, "Who owes her a boat?");
    expect(system(r.host.calls[2])).toBe(`${MAIN}\n\n${ABOUT_CHAT}${SKILLS}`);
    // The rounds of an earlier turn aren't carried: what it came to is its answer.
    expect(conversation(r.host.calls[2])).toEqual([
      { role: "user", content: "Who keeps the lighthouse?" },
      { role: "assistant", content: "Nobody says who keeps it." },
      { role: "user", content: `And who holds its key?${rounds(24)}` },
    ]);
    expect(conversation(r.host.calls[3])).toEqual([
      { role: "user", content: "Who keeps the lighthouse?" },
      { role: "assistant", content: "Nobody says who keeps it." },
      { role: "user", content: "And who holds its key?" },
      { role: "assistant", content: "Brann holds the key." },
      { role: "user", content: `Who owes her a boat?${rounds(24)}` },
    ]);
    expect((await r.harness.sides.turns({ id })).turns.map((turn) => [turn.asked, turn.answered])).toEqual([
      ["Who keeps the lighthouse?", "Nobody says who keeps it."],
      ["And who holds its key?", "Brann holds the key."],
      ["Who owes her a boat?", "Ilse."],
    ]);
  });

  test("it is listed under how its first message opens, the session used last first", async () => {
    const r = rig(() => "An answer.", (s) => (s.reply.progressChars = 30));
    const first = await r.start();
    expect((await r.harness.sides.list({})).sides).toEqual([{ id: first, chatId: CHAT, agent: "main", title: "", createdAt: r.host.clock.now(), lastAt: r.host.clock.now(), turns: 0 }]);
    const created = r.host.clock.now();
    r.host.clock.advance(1000);
    await r.ask(first, "  Who keeps\n\tthe lighthouse?  ");
    r.host.clock.advance(1000);
    const second = await r.start();
    // A line of the list, so Progress line length long at most: a longer opening is cut.
    await r.ask(second, "Tell me everything the chat says about the harbour at night.");
    expect((await r.harness.sides.list({})).sides).toEqual([
      { id: second, chatId: CHAT, agent: "main", title: "Tell me everything the chat s…", createdAt: created + 2000, lastAt: created + 2000, turns: 1 },
      { id: first, chatId: CHAT, agent: "main", title: "Who keeps the lighthouse?", createdAt: created, lastAt: created + 1000, turns: 1 },
    ]);
    // Used again, the first is the latest; its title stays its first message's.
    r.host.clock.advance(1000);
    await r.ask(first, "And who holds its key?");
    expect((await r.harness.sides.list({})).sides.map((side) => [side.id, side.title, side.lastAt, side.turns])).toEqual([
      [first, "Who keeps the lighthouse?", created + 3000, 2],
      [second, "Tell me everything the chat s…", created + 2000, 1],
    ]);
  });

  test("the list is all of them, those about one chat, or those about none", async () => {
    const r = rig(() => "An answer.");
    r.host.say("chat-2", "user", "I row out past the point.");
    const [one, other, none] = [await r.start(CHAT), await r.start("chat-2"), await r.start(null)];
    const ids = async (input: { chatId?: string | null }): Promise<string[]> => (await r.harness.sides.list(input)).sides.map((side) => side.id).sort();
    expect(await ids({})).toEqual([one, other, none].sort());
    expect(await ids({ chatId: CHAT })).toEqual([one]);
    expect(await ids({ chatId: "chat-2" })).toEqual([other]);
    expect(await ids({ chatId: null })).toEqual([none]);
    expect(await ids({ chatId: "chat-3" })).toEqual([]);
  });

  test("removed, it is gone from the list, its turns can't be read and it answers no more", async () => {
    const r = rig(() => "An answer.");
    const [gone, stays] = [await r.start(), await r.start()];
    await r.ask(gone, "Who keeps the lighthouse?");
    expect(await r.harness.sides.remove({ id: gone })).toEqual({ removed: true });
    expect((await r.harness.sides.list({})).sides.map((side) => side.id)).toEqual([stays]);
    expect((await refusal(r.harness.sides.turns({ id: gone }))).code).toBe("not_found");
    const calls = r.host.calls.length;
    expect((await refusal(r.ask(gone, "Are you there?"))).code).toBe("not_found");
    expect(r.host.calls).toHaveLength(calls);
    expect((await refusal(r.harness.sides.remove({ id: gone }))).code).toBe("not_found");
    // The other one is as it was.
    expect((await r.ask(stays, "Who holds the key?")).result.status).toBe("done");
  });

  test("it outlives the process: after a restart it is listed, read and carried on", async () => {
    const r = rig(script());
    const id = await r.start();
    await r.ask(id, "Who keeps the lighthouse?");
    const again = createHarness(r.host, r.options);
    expect((await again.sides.list({ chatId: CHAT })).sides).toMatchObject([{ id, title: "Who keeps the lighthouse?", turns: 1 }]);
    expect((await again.sides.turns({ id })).turns.map((turn) => turn.answered)).toEqual(["Nobody says who keeps it."]);
    const { result } = await r.ask(id, "And who holds its key?", never, again);
    expect(result.reply).toBe("Brann holds the key.");
    expect(conversation(r.host.calls[2]).slice(0, 2)).toEqual([
      { role: "user", content: "Who keeps the lighthouse?" },
      { role: "assistant", content: "Nobody says who keeps it." },
    ]);
  });
});

// ---------------------------------------------------------------- with any agent the user picks

describe("a side session with an agent the user picks", () => {
  test("the summarizer answers as itself: its own instructions, told what this is, and its own tools", async () => {
    const r = rig(lines({ toolCalls: [call("chat_read", { from: 1 }, "c1")] }, "Mara walks down to the lighthouse and knocks."));
    const id = await r.start(CHAT, "summarizer");
    expect((await r.harness.sides.list({})).sides).toMatchObject([{ id, agent: "summarizer", chatId: CHAT }]);
    const { result, generationId } = await r.ask(id, "Summarize the chat so far.");
    expect(result).toMatchObject({ status: "done", reply: "Mara walks down to the lighthouse and knocks." });
    expect(system(r.host.calls[0])).toBe(`${SUMMARIZER}\n\n${ABOUT_CHAT}`);
    // What its definition reads with, and nothing that changes anything.
    expect(toolsOf(r.host.calls[0])).toEqual(["chat_search", "chat_grep", "chat_read", "lore_search", "lore_read", "workspace_list", "workspace_read", "workspace_grep", "scratch_read"]);
    expect(resultOf(r.host, "c1")).toEqual({ content: expect.stringContaining("I walk down to the lighthouse and knock."), isError: false });
    expect(events(r.host, generationId).flatMap((e) => (e.kind === "agent_started" ? [e.agent.role] : []))).toEqual(["summarizer"]);
  });

  test("an agent registered beside the core's answers with its own instructions", async () => {
    const r = rig(lines("It stands on the point."));
    r.harness.agents.register(scout());
    const id = await r.start(CHAT, "scout");
    const { result } = await r.ask(id, "Where is the lighthouse?");
    expect(result).toMatchObject({ status: "done", reply: "It stands on the point." });
    expect(system(r.host.calls[0])).toBe(`${SCOUT}\n\n${ABOUT_CHAT}`);
    expect((await r.harness.sides.turns({ id })).side.agent).toBe("scout");
  });

  test("the writer, an agent there is none of and one switched off are refused, and nothing is started", async () => {
    const r = rig(lines());
    r.harness.agents.register(scout());
    r.stored.definitions = { off: { agents: ["scout"] } };
    for (const agent of ["writer", "nobody", "scout"]) {
      const refused = await refusal(r.harness.sides.start({ chatId: CHAT, agent }));
      expect([agent, refused.code]).toEqual([agent, "not_found"]);
      expect(refused.message).toBe(`There is no agent "${agent}" to talk to: it may have been removed or switched off.`);
    }
    expect((await r.harness.sides.list({})).sides).toEqual([]);
  });

  test("a session whose agent was switched off since says so, and answers again once it is back", async () => {
    const r = rig(lines("It stands on the point."));
    r.harness.agents.register(scout());
    const id = await r.start(CHAT, "scout");
    r.stored.definitions = { off: { agents: ["scout"] } };
    const { result, sink } = await r.ask(id, "Where is the lighthouse?");
    expect(result).toMatchObject({ status: "failed", reason: 'the agent "scout" this session is with is gone or switched off', reply: "" });
    expect(sink.order).toEqual(["error"]);
    expect(sink.failed).toEqual({ message: 'the agent "scout" this session is with is gone or switched off', code: "failed" });
    expect(r.host.calls).toHaveLength(0);
    r.stored.definitions = {};
    expect((await r.ask(id, "Where is the lighthouse?")).result.status).toBe("done");
  });
});

// ---------------------------------------------------------------- about nothing in particular

describe("a side session about nothing in particular", () => {
  test("it is told so, and is offered no tool that reads a chat, its lore or its jobs", async () => {
    const r = rig(lines("Ask away."));
    const id = await r.start(null);
    expect((await r.harness.sides.list({ chatId: null })).sides).toMatchObject([{ id, chatId: "", agent: "main" }]);
    const { result, generationId } = await r.ask(id, "What can you do here?");
    expect(result.status).toBe("done");
    expect(system(r.host.calls[0])).toBe(`${MAIN}\n\n${ABOUT_NOTHING}${SKILLS}`);
    const offered = toolsOf(r.host.calls[0]);
    expect(offered.filter((name) => /^(chat|lore|book|job|chronicle|memory|databank|web)_|^active_lore$|^preset_instructions$|^write_reply$/.test(name))).toEqual([]);
    expect(offered).toEqual(expect.arrayContaining(["workspace_list", "workspace_read", "workspace_grep", "workspace_write", "workspace_edit", "workspace_move", "workspace_delete", "workspace_pin", "delegate", "agent_message"]));
    // Its trace is no chat's.
    expect(r.host.traced.filter((t) => t.turn === generationId).map((t) => t.chatId)).toEqual(r.host.traced.map(() => ""));
    expect(events(r.host, generationId)[0]).toMatchObject({ kind: "turn_started", chatId: "", generation: "side", side: id });
  });

  test("its workspace is the user's own area alone: a write anywhere else is refused in words that say which areas there are", async () => {
    const r = rig(lines({ toolCalls: [call("workspace_write", { path: "/x.md", content: "Short replies.", base: "new" }, "w1"), call("workspace_write", { path: "learned/x.md", content: "Short replies.", base: "new" }, "w2"), call("workspace_write", { path: "~/x.md", content: "Short replies.", base: "new" }, "w3"), call("workspace_list", {}, "l1"), call("workspace_list", { path: "~/" }, "l2")] }, "Written to your own files."));
    const id = await r.start(null);
    const { result } = await r.ask(id, "Note that I like short replies.");
    expect(result.status).toBe("done");
    expect(resultOf(r.host, "w1")).toEqual({ content: "Your workspace has no / here. It has: ~/ (the user's own files). Give a path in one of those.", isError: true });
    expect(resultOf(r.host, "w2")).toEqual({ content: "Your workspace has no learned/ here. It has: ~/ (the user's own files). Give a path in one of those.", isError: true });
    expect(resultOf(r.host, "w3")).toEqual({ content: `Wrote ~/x.md: 14 characters, now at version ${await version("Short replies.")}. Your next change to it takes that version as base.`, isError: false });
    // A listing without a path would list the chat's area, which isn't there either.
    expect(resultOf(r.host, "l1")).toEqual({ content: "Your workspace has no / here. It has: ~/ (the user's own files). Give a path in one of those.", isError: true });
    expect(resultOf(r.host, "l2")?.isError).toBe(false);
    // The file is the user's, on the page and in every chat: written by the session's agent.
    const read = await r.harness.workspace.read({ chatId: null, area: "user", path: "x.md" });
    expect(read.text).toBe("Short replies.");
    expect(read.file.by).toMatchObject({ who: "agent", role: "main" });
    expect((await r.harness.workspace.read({ chatId: CHAT, area: "user", path: "x.md" })).text).toBe("Short replies.");
    expect((await r.harness.workspace.list({ chatId: CHAT, area: "chat" })).files).toEqual([]);
    expect((await r.harness.workspace.list({ chatId: CHAT, area: "learned" })).files).toEqual([]);
  });

  test("its guidance is the user's own level alone", async () => {
    const r = rig(lines("Ask away."));
    await r.harness.guidance.set({ chatId: null, level: "user", text: "Keep answers under a hundred words.", base: null });
    await r.harness.guidance.set({ chatId: CHAT, level: "chat", text: "Okoro never raises his voice.", base: null });
    await r.ask(await r.start(null), "What can you do here?");
    expect(system(r.host.calls[0])).toBe(`[Guidance from the user, for every chat. Follow it.]\nKeep answers under a hundred words.\n\n${MAIN}\n\n${ABOUT_NOTHING}${SKILLS}`);
  });
});

// ---------------------------------------------------------------- the same workspace, guidance and live view

describe("a side session has the chat's workspace, guidance and live view", () => {
  /** The chat's main agent writes its replies itself here, so a turn's calls are its own. */
  const writes = (s: Settings): void => void (s.reply.writer = "main");
  const NOTE = "Brann holds the lighthouse key.";
  const PLAN = "Mara wants the lamp lit before the storm.";

  test("a file it writes to the chat's area before any turn is there for the chat's first turn", async () => {
    const r = rig(lines({ toolCalls: [call("workspace_write", { path: "/notes/key.md", content: NOTE, base: "new" }, "w1")] }, "Noted.", { toolCalls: [call("workspace_read", { path: "/notes/key.md" }, "r1")] }, "The door opens."), writes);
    const id = await r.start();
    const { result } = await r.ask(id, "Note who holds the key.");
    expect(result.status).toBe("done");
    expect(resultOf(r.host, "w1")?.isError).toBe(false);
    const sideAgent = r.host.traced.flatMap((t) => (t.event.kind === "agent_started" ? [t.event.agent.id] : []))[0] ?? "";
    await runTurn(r.host, r.harness, CHAT);
    expect(resultOf(r.host, "r1")).toEqual({ content: await page("/notes/key.md", NOTE), isError: false });
    // It is the side session's agent's write, like any agent's.
    expect((await r.harness.workspace.read({ chatId: CHAT, area: "chat", path: "notes/key.md" })).file.by).toEqual({ who: "agent", id: sideAgent, role: "main" });
  });

  test("it reads what the chat's turns wrote, and what it writes after a turn is there for the next", async () => {
    const r = rig(
      lines(
        // The chat's first turn writes the plan.
        { toolCalls: [call("workspace_write", { path: "/notes/plan.md", content: PLAN, base: "new" }, "w1"), call("workspace_write", { path: "learned/who.md", content: "Okoro keeps the lighthouse.", base: "new" }, "w2")] },
        "The door opens.",
        // The side session reads it, and writes beside it.
        { toolCalls: [call("workspace_read", { path: "/notes/plan.md" }, "r1"), call("workspace_read", { path: "learned/who.md" }, "r2"), call("workspace_write", { path: "/notes/key.md", content: NOTE, base: "new" }, "w3")] },
        "Read and noted.",
        // The chat's next turn has both.
        { toolCalls: [call("workspace_list", { path: "/notes/" }, "l1"), call("workspace_read", { path: "/notes/key.md" }, "r3")] },
        "Okoro looks out.",
      ),
      writes,
    );
    await runTurn(r.host, r.harness, CHAT);
    const { result } = await r.ask(await r.start(), "Read the plan and note who holds the key.");
    expect(result.status).toBe("done");
    expect(resultOf(r.host, "r1")).toEqual({ content: await page("/notes/plan.md", PLAN), isError: false });
    expect(resultOf(r.host, "r2")).toEqual({ content: await page("learned/who.md", "Okoro keeps the lighthouse."), isError: false });
    r.host.say(CHAT, "user", "I knock again.");
    await runTurn(r.host, r.harness, CHAT);
    expect(resultOf(r.host, "l1")?.content).toBe(`2 folders and files found; showing 1 to 2.\n- /notes/key.md (${NOTE.length} characters, version ${await version(NOTE)})\n- /notes/plan.md (${PLAN.length} characters, version ${await version(PLAN)})`);
    expect(resultOf(r.host, "r3")).toEqual({ content: await page("/notes/key.md", NOTE), isError: false });
  });

  test("the guidance written for the chat and for the user leads its instructions, as it leads a turn's", async () => {
    const r = rig(lines("An answer.", "The door opens."), writes);
    await r.harness.guidance.set({ chatId: CHAT, level: "user", text: "Keep answers under a hundred words.", base: null });
    await r.harness.guidance.set({ chatId: CHAT, level: "chat", text: "Okoro never raises his voice.", base: null });
    await r.ask(await r.start(), "Who keeps the lighthouse?");
    const guidance = "[Guidance from the user, for every chat. Follow it.]\nKeep answers under a hundred words.\n\n[Guidance for this chat. Follow it.]\nOkoro never raises his voice.";
    expect(system(r.host.calls[0])).toBe(`${guidance}\n\n${MAIN}\n\n${ABOUT_CHAT}${SKILLS}`);
    await runTurn(r.host, r.harness, CHAT);
    expect(system(r.host.calls[1])).toStartWith(`${guidance}\n\n`);
  });

  test("a file pinned for its agent leads what it is sent, as it leads a turn's message", async () => {
    const r = rig(lines("An answer."));
    await r.harness.workspace.write({ chatId: CHAT, area: "learned", path: "who.md", text: "Okoro keeps the lighthouse.", base: null });
    await r.harness.workspace.pin({ chatId: CHAT, area: "learned", path: "who.md", on: true });
    const id = await r.start();
    await r.ask(id, "Who keeps the lighthouse?");
    expect(conversation(r.host.calls[0])).toEqual([{ role: "user", content: `Your pinned workspace files, as they stand now:\n\n[learned/who.md: 27 characters, version ${await version("Okoro keeps the lighthouse.")}]\nOkoro keeps the lighthouse.\n\nWho keeps the lighthouse?${rounds(24)}` }]);
    // What is kept of the turn is what the user said: the files lead each turn anew, as they stand then.
    expect((await r.harness.sides.turns({ id })).turns[0]?.asked).toBe("Who keeps the lighthouse?");
  });

  test("its trace is a run's: started as a side session's turn with the session's id, every step numbered with no gap, ended with what it spent", async () => {
    const r = rig(lines({ toolCalls: [call("chat_search", { query: "lighthouse" }, "c1")] }, "Nobody says who keeps it."));
    const id = await r.start();
    const { result, generationId } = await r.ask(id, "Who keeps the lighthouse?");
    expect(r.host.traced.map((t) => [t.turn, t.chatId])).toEqual(r.host.traced.map(() => [generationId, CHAT]));
    expect(r.host.traced.map((t) => t.seq)).toEqual(r.host.traced.map((_, i) => i + 1));
    const all = events(r.host, generationId);
    expect(all[0]).toEqual({ kind: "turn_started", turn: generationId, chatId: CHAT, generation: "side", messageId: null, side: id, at: r.host.clock.now() });
    expect(all.map((e) => (e.kind === "agent_entry" ? e.entry.kind : e.kind))).toEqual(["turn_started", "agent_started", "message", "usage", "answer", "result", "usage", "answer", "agent_idle", "turn_ended"]);
    expect(all.flatMap((e) => (e.kind === "agent_started" ? [[e.agent.role, e.agent.system]] : []))).toEqual([["main", `${MAIN}\n\n${ABOUT_CHAT}${SKILLS}`]]);
    expect(all.at(-1)).toEqual({ kind: "turn_ended", status: "done", usage: result.usage, at: r.host.clock.now() });
  });
});

// ---------------------------------------------------------------- a long one is summarized

describe("a long side session is summarized", () => {
  const SUMMARY_SYSTEM = "You are given the earlier part of a conversation between a user and an agent, and a summary of what came before it, if there is one. Write one summary that stands for all of it, for the agent to go on from: what the user asked for and why, what was decided, what the agent found or did (with the names of files it wrote), and what is still open. Keep it under 6000 tokens. Answer with the summary alone.";
  const isSummary = (request: ModelRequest): boolean => system(request).startsWith("You are given the earlier part of a conversation");
  const ASKED = ["Who keeps the lighthouse?", "Who holds its key?", "Who owes Ilse a boat?", "Is the lamp lit?", "Where does Joss sleep?", "What does Mara want?"];
  const ANSWERED = ["Okoro keeps it.", "Brann holds the key.", "Joss owes her one.", "Not since the storm.", "Above the net loft.", "The lamp lit before dark."];

  /** A session whose agent answers each message with the next of `ANSWERED`, and whose summaries are `summaries`, in the order they are asked for. One turn stays whole after a summary. */
  function long(summaries: Answer[], change: (s: Settings) => void = () => undefined) {
    let answered = 0;
    let summarized = 0;
    const r = rig(
      (request) => {
        if (!isSummary(request)) return ANSWERED[answered++] ?? "An answer.";
        const summary = summaries[summarized++];
        if (summary === undefined) throw new Error(`no summary ${summarized} is scripted`);
        return summary;
      },
      (s) => {
        s.session.keepTurns = 1;
        change(s);
      },
    );
    /** The next `count` messages, each answered. */
    const talk = async (id: string, count: number): Promise<void> => {
      for (let i = 0; i < count; i++) await r.ask(id, ASKED[answered] ?? "And then?");
    };
    /** Summarize past, as the user sets it: so low that any conversation is past it, or back at its default. */
    const summarizePast = (tokens: number): void => void (r.stored.values.session.summarizeAtTokens = tokens);
    return { ...r, talk, summarizePast, summaries: (): ModelRequest[] => r.host.calls.filter(isSummary) };
  }

  const exchange = (i: number): string => `The user:\n${ASKED[i]}\n\nThe agent:\n${ANSWERED[i]}`;

  test("past Summarize past the older turns are summarized in one call without tools, the summary leads the conversation, and the latest turns stay whole", async () => {
    const r = long(["Okoro keeps the lighthouse; Brann holds its key."]);
    const id = await r.start();
    await r.talk(id, 3);
    // Under the setting, nothing was summarized: the third turn was sent the first two whole.
    expect(r.summaries()).toEqual([]);
    expect(conversation(r.host.calls[2])).toHaveLength(5);
    r.summarizePast(10);
    const { result, generationId } = await r.ask(id, ASKED[3] ?? "");
    expect(result).toMatchObject({ status: "done", reply: ANSWERED[3] ?? "", usage: { calls: 2 } });
    const [summary] = r.summaries();
    expect(r.summaries()).toHaveLength(1);
    expect(summary?.tools).toBeUndefined();
    expect(summary?.messages).toEqual([
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: `The summary so far:\n(none)\n\nThe conversation since:\n\n${exchange(0)}\n\n${exchange(1)}` },
    ]);
    expect(conversation(r.host.calls.at(-1))).toEqual([
      { role: "user", content: `[The earlier part of this conversation, summarized:]\nOkoro keeps the lighthouse; Brann holds its key.\n\n${ASKED[2]}` },
      { role: "assistant", content: ANSWERED[2] ?? "" },
      { role: "user", content: `${ASKED[3]}${rounds(24)}` },
    ]);
    // The call is the summarizer's, in the session's live view like every call of the turn.
    expect(events(r.host, generationId).flatMap((e) => (e.kind === "agent_started" ? [e.agent.role] : []))).toEqual(["summarizer", "main"]);
    // What the page shows of the session is every turn, whole.
    expect((await r.harness.sides.turns({ id })).turns.map((turn) => [turn.asked, turn.answered])).toEqual([0, 1, 2, 3].map((i) => [ASKED[i] ?? "", ANSWERED[i] ?? ""]));
  });

  test("the summary is kept with the session: it leads the turns after it without a second call, and the next summary is made from it and the turns since", async () => {
    const r = long(["Okoro keeps the lighthouse; Brann holds its key.", "Okoro keeps the lighthouse, Brann its key; Joss owes Ilse a boat, and the lamp is dark."]);
    const id = await r.start();
    await r.talk(id, 3);
    r.summarizePast(10);
    await r.talk(id, 1);
    r.summarizePast(32_000);
    await r.talk(id, 1);
    expect(r.summaries()).toHaveLength(1);
    expect(conversation(r.host.calls.at(-1))).toEqual([
      { role: "user", content: `[The earlier part of this conversation, summarized:]\nOkoro keeps the lighthouse; Brann holds its key.\n\n${ASKED[2]}` },
      { role: "assistant", content: ANSWERED[2] ?? "" },
      { role: "user", content: ASKED[3] ?? "" },
      { role: "assistant", content: ANSWERED[3] ?? "" },
      { role: "user", content: `${ASKED[4]}${rounds(24)}` },
    ]);
    // After a restart too: the summary is in the store, not in memory.
    const again = createHarness(r.host, r.options);
    r.summarizePast(10);
    await r.ask(id, ASKED[5] ?? "", never, again);
    expect(r.summaries()).toHaveLength(2);
    expect(r.summaries()[1]?.messages[1]?.content).toBe(`The summary so far:\nOkoro keeps the lighthouse; Brann holds its key.\n\nThe conversation since:\n\n${exchange(2)}\n\n${exchange(3)}`);
    expect(conversation(r.host.calls.at(-1))).toEqual([
      { role: "user", content: `[The earlier part of this conversation, summarized:]\nOkoro keeps the lighthouse, Brann its key; Joss owes Ilse a boat, and the lamp is dark.\n\n${ASKED[4]}` },
      { role: "assistant", content: ANSWERED[4] ?? "" },
      { role: "user", content: `${ASKED[5]}${rounds(24)}` },
    ]);
  });

  test("with no turn kept whole, the summary leads the message the user sends", async () => {
    const r = long(["Okoro keeps the lighthouse; Brann holds its key."], (s) => (s.session.keepTurns = 0));
    const id = await r.start();
    await r.talk(id, 2);
    r.summarizePast(10);
    await r.talk(id, 1);
    expect(r.summaries()[0]?.messages[1]?.content).toBe(`The summary so far:\n(none)\n\nThe conversation since:\n\n${exchange(0)}\n\n${exchange(1)}`);
    // Nothing is put in the agent's mouth to carry it: the conversation is the summary and what the user said.
    expect(conversation(r.host.calls.at(-1))).toEqual([{ role: "user", content: `[The earlier part of this conversation, summarized:]\nOkoro keeps the lighthouse; Brann holds its key.\n\n${ASKED[2]}${rounds(24)}` }]);
    expect((await r.harness.sides.turns({ id })).turns.at(-1)?.asked).toBe(ASKED[2] ?? "");
  });

  test("a turn that wasn't answered is told to the summarizer and to the agent as one it didn't answer", async () => {
    const stop = new AbortController();
    let answered = 0;
    const r = rig(
      (request) => (isSummary(request) ? "Okoro keeps the lighthouse." : answered++ === 1 ? { hang: true } : "An answer."),
      (s) => (s.session.keepTurns = 1),
    );
    const id = await r.start();
    await r.ask(id, "Who keeps the lighthouse?");
    const stopped = r.ask(id, "Who holds its key?", stop.signal);
    await until(() => r.host.calls.length === 2);
    stop.abort();
    expect((await stopped).result.status).toBe("stopped");
    await r.ask(id, "Who owes Ilse a boat?");
    expect(conversation(r.host.calls.at(-1)).slice(2, 4)).toEqual([
      { role: "user", content: "Who holds its key?" },
      { role: "assistant", content: "(You didn't answer this: the turn was stopped.)" },
    ]);
    r.stored.values.session.summarizeAtTokens = 10;
    await r.ask(id, "Is the lamp lit?");
    expect(r.host.calls.find(isSummary)?.messages[1]?.content).toEndWith("The user:\nWho holds its key?\n\nThe agent:\n(You didn't answer this: the turn was stopped.)");
  });

  for (const [what, failing, why] of [
    ["fails", { error: "no such model" }, "no such model"],
    ["is cut at its length limit", { content: "Okoro keeps the lighthouse; Brann holds", finishReason: "length" }, "its summary was cut off at its limit"],
    ["says nothing", { content: "  " }, "the summarizing call answered nothing"],
  ] as const) {
    test(`a summary that ${what} leaves the conversation whole, and the next turn tries again`, async () => {
      const r = long([failing, "Okoro keeps the lighthouse; Brann holds its key; Joss owes Ilse a boat."]);
      const id = await r.start();
      await r.talk(id, 3);
      r.summarizePast(10);
      const { result } = await r.ask(id, ASKED[3] ?? "");
      // The turn is answered all the same, from the whole conversation.
      expect(result).toMatchObject({ status: "done", reply: ANSWERED[3] ?? "" });
      expect(r.summaries()).toHaveLength(1);
      expect(conversation(r.host.calls.at(-1))).toEqual([
        { role: "user", content: ASKED[0] ?? "" },
        { role: "assistant", content: ANSWERED[0] ?? "" },
        { role: "user", content: ASKED[1] ?? "" },
        { role: "assistant", content: ANSWERED[1] ?? "" },
        { role: "user", content: ASKED[2] ?? "" },
        { role: "assistant", content: ANSWERED[2] ?? "" },
        { role: "user", content: `${ASKED[3]}${rounds(24)}` },
      ]);
      expect(r.host.logs.filter((log) => log.level === "warn").map((log) => log.message)).toEqual([expect.stringContaining(why) as unknown as string]);
      expect(r.host.logs[0]?.message).toStartWith("the side session's older turns weren't summarized (");
      // The next turn asks for the summary again, of everything but the latest turn.
      await r.ask(id, ASKED[4] ?? "");
      expect(r.summaries()).toHaveLength(2);
      expect(r.summaries()[1]?.messages[1]?.content).toBe(`The summary so far:\n(none)\n\nThe conversation since:\n\n${exchange(0)}\n\n${exchange(1)}\n\n${exchange(2)}`);
      expect(conversation(r.host.calls.at(-1))).toEqual([
        { role: "user", content: `[The earlier part of this conversation, summarized:]\nOkoro keeps the lighthouse; Brann holds its key; Joss owes Ilse a boat.\n\n${ASKED[3]}` },
        { role: "assistant", content: ANSWERED[3] ?? "" },
        { role: "user", content: `${ASKED[4]}${rounds(24)}` },
      ]);
    });
  }

  test("a whole summary stands whatever its last word: whether it was cut is told from how its call ended", async () => {
    // It ends on a word few sentences end on, with no full stop, and its call ended of itself.
    const r = long([{ content: "Okoro keeps the lighthouse, and", finishReason: "stop" }]);
    const id = await r.start();
    await r.talk(id, 3);
    r.summarizePast(10);
    await r.ask(id, ASKED[3] ?? "");
    expect(r.summaries()).toHaveLength(1);
    expect(conversation(r.host.calls.at(-1))).toEqual([
      { role: "user", content: `[The earlier part of this conversation, summarized:]\nOkoro keeps the lighthouse, and\n\n${ASKED[2]}` },
      { role: "assistant", content: ANSWERED[2] ?? "" },
      { role: "user", content: `${ASKED[3]}${rounds(24)}` },
    ]);
    expect(r.host.logs.filter((log) => log.level === "warn")).toEqual([]);
  });
});

// ---------------------------------------------------------------- one turn at a time

describe("a side session takes one turn at a time", () => {
  test("a second message while it answers is refused as a conflict, also when the two are sent back to back; once it has answered it takes the next", async () => {
    const first = Promise.withResolvers<Answer>();
    const r = rig(lines(() => first.promise, "Brann holds the key."));
    const id = await r.start();
    // Back to back, with nothing awaited between them: the second finds the first in its place.
    const one = r.ask(id, "Who keeps the lighthouse?");
    const two = refusal(r.ask(id, "And who holds its key?"));
    expect(await two).toEqual({ code: "conflict", message: "That side session is still answering your last message." });
    await until(() => r.host.calls.length === 1);
    expect((await refusal(r.ask(id, "Are you there?"))).code).toBe("conflict");
    first.resolve("Okoro keeps it.");
    expect((await one).result).toMatchObject({ status: "done", reply: "Okoro keeps it." });
    // Nothing of the refused messages reached a model or the session.
    expect(r.host.calls).toHaveLength(1);
    expect((await r.harness.sides.turns({ id })).turns.map((turn) => turn.asked)).toEqual(["Who keeps the lighthouse?"]);
    expect((await r.ask(id, "And who holds its key?")).result).toMatchObject({ status: "done", reply: "Brann holds the key." });
  });

  test("two sessions answer at the same time", async () => {
    const first = Promise.withResolvers<Answer>();
    const r = rig((request) => (conversation(request).at(-1)?.content.startsWith("Who keeps") ? first.promise : "Brann holds the key."));
    const [one, other] = [await r.start(), await r.start()];
    const slow = r.ask(one, "Who keeps the lighthouse?");
    await until(() => r.host.calls.length === 1);
    expect((await r.ask(other, "Who holds its key?")).result).toMatchObject({ status: "done", reply: "Brann holds the key." });
    first.resolve("Okoro keeps it.");
    expect((await slow).result.reply).toBe("Okoro keeps it.");
  });

  test("a message to a session there is none of is refused as not found, and an empty one as a bad request: nothing is sent and the sink hears nothing", async () => {
    const r = rig(lines());
    const id = await r.start();
    for (const [session, text, code] of [["side_0000beef", "Hello?", "not_found"], [id, "   ", "bad_request"]] as const) {
      const sink = new Sink();
      expect((await refusal(r.harness.side({ session, generationId: "side-turn-x", text }, sink, never))).code).toBe(code);
      expect(sink.order).toEqual([]);
    }
    expect(r.host.calls).toHaveLength(0);
    expect(r.host.traced).toEqual([]);
    expect((await r.harness.sides.turns({ id })).turns).toEqual([]);
  });

  test("stopping it ends the turn as stopped, with one error on the sink; it is kept as unanswered, and the session goes on", async () => {
    const stop = new AbortController();
    const r = rig(lines({ hang: true }, "Okoro keeps it."));
    const id = await r.start();
    const asking = r.ask(id, "Who keeps the lighthouse?", stop.signal);
    await until(() => r.host.calls.length === 1);
    stop.abort();
    const { result, sink, generationId } = await asking;
    expect(result).toMatchObject({ status: "stopped", reason: "the turn was stopped", reply: "" });
    expect(sink.order).toEqual(["error"]);
    expect(sink.failed).toEqual({ message: "the turn was stopped", code: "stopped" });
    expect(sink.text).toBe("");
    expect(events(r.host, generationId).at(-1)).toMatchObject({ kind: "turn_ended", status: "stopped", reason: "the turn was stopped" });
    expect((await r.harness.sides.turns({ id })).turns).toMatchObject([{ turn: generationId, asked: "Who keeps the lighthouse?", answered: null, status: "stopped", reason: "the turn was stopped" }]);
    // Its place is free again, and the agent is told what became of the message before.
    const next = await r.ask(id, "Again: who keeps it?");
    expect(next.result).toMatchObject({ status: "done", reply: "Okoro keeps it." });
    expect(conversation(r.host.calls[1])).toEqual([
      { role: "user", content: "Who keeps the lighthouse?" },
      { role: "assistant", content: "(You didn't answer this: the turn was stopped.)" },
      { role: "user", content: `Again: who keeps it?${rounds(24)}` },
    ]);
  });

  test("a stop that says why ends the turn in those words", async () => {
    const stop = new AbortController();
    const r = rig(lines({ hang: true }));
    const asking = r.ask(await r.start(), "Who keeps the lighthouse?", stop.signal);
    await until(() => r.host.calls.length === 1);
    stop.abort(new Error("the page was closed"));
    const { result, sink } = await asking;
    expect(result).toMatchObject({ status: "stopped", reason: "the page was closed" });
    expect(sink.failed).toEqual({ message: "the page was closed", code: "stopped" });
  });

  test("a turn whose model fails ends as failed, with one error on the sink that says why", async () => {
    const r = rig(lines({ error: "no such model" }, "Okoro keeps it."));
    const id = await r.start();
    const { result, sink } = await r.ask(id, "Who keeps the lighthouse?");
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("no such model");
    expect(result.reply).toBe("");
    expect(sink.order).toEqual(["error"]);
    expect(sink.failed).toEqual({ message: result.reason ?? "", code: "failed" });
    expect((await r.harness.sides.turns({ id })).turns).toMatchObject([{ status: "failed", answered: null, reason: result.reason ?? "" }]);
    expect((await r.ask(id, "Again: who keeps it?")).result.status).toBe("done");
  });

  test("a session that is answering can't be removed; once it has answered it can", async () => {
    const first = Promise.withResolvers<Answer>();
    const r = rig(lines(() => first.promise));
    const id = await r.start();
    const asking = r.ask(id, "Who keeps the lighthouse?");
    expect(await refusal(r.harness.sides.remove({ id }))).toEqual({ code: "conflict", message: "That side session is answering: stop it first, then remove it." });
    await until(() => r.host.calls.length === 1);
    expect((await refusal(r.harness.sides.remove({ id }))).code).toBe("conflict");
    first.resolve("Okoro keeps it.");
    await asking;
    // It is still there, with the turn it was answering.
    expect((await r.harness.sides.turns({ id })).turns.map((turn) => turn.answered)).toEqual(["Okoro keeps it."]);
    expect(await r.harness.sides.remove({ id })).toEqual({ removed: true });
    expect((await r.harness.sides.list({})).sides).toEqual([]);
  });

  test("a message sent as it is being removed is refused, and never brings it back", async () => {
    const r = rig(lines("Okoro keeps it."));
    const id = await r.start();
    // Back to back, with nothing awaited between them.
    const removing = r.harness.sides.remove({ id });
    const asking = refusal(r.ask(id, "Who keeps the lighthouse?"));
    expect(await removing).toEqual({ removed: true });
    expect((await asking).code).toBe("not_found");
    await idle();
    expect(r.host.calls).toHaveLength(0);
    expect((await r.harness.sides.list({})).sides).toEqual([]);
    expect((await refusal(r.harness.sides.turns({ id }))).code).toBe("not_found");
  });
});

// ---------------------------------------------------------------- talking to it while it works

describe("the user talks to a side session's turn while it works", () => {
  test("a note reaches its agent at its next round, a pause holds it there, and a resume lets it go on; once it has answered there is nobody to tell", async () => {
    const first = Promise.withResolvers<Answer>();
    const second = Promise.withResolvers<Answer>();
    const r = rig(lines(() => first.promise, () => second.promise, "Brann holds the key."));
    const id = await r.start();
    const asking = r.ask(id, "Who holds the lighthouse key?");
    await until(() => r.host.calls.length === 1);
    // The turn's id, as the runtime gave it and its trace bears it.
    const run = r.host.traced[0]?.turn ?? "";
    expect(run).toBe("side-turn-1");
    expect(await r.harness.say({ run, text: "Look in the chat first." })).toEqual({ said: true });
    first.resolve({ toolCalls: [call("chat_search", { query: "key" }, "s1")] });
    await until(() => r.host.calls.length === 2);
    // The note comes with the round's results, marked as the user's.
    expect(r.host.calls[1]?.messages.at(-1)?.parts?.at(-1)).toEqual({ type: "text", text: "[The user says, while you work:]\nLook in the chat first." });

    expect(await r.harness.pause({ run })).toEqual({ paused: true });
    second.resolve({ toolCalls: [call("chat_search", { query: "Brann" }, "s2")] });
    await idle();
    // Held at its next round: the round's tool ran, and no further call is made.
    expect(r.host.calls).toHaveLength(2);
    expect(await r.harness.resume({ run })).toEqual({ paused: false });
    const { result, sink } = await asking;
    expect(result).toMatchObject({ status: "done", reply: "Brann holds the key.", usage: { calls: 3, toolTurns: 2 } });
    expect(sink.order).toEqual(["content", "done"]);
    expect(r.host.calls).toHaveLength(3);
    expect(events(r.host, run).flatMap((e) => (e.kind === "turn_paused" || e.kind === "turn_resumed" ? [e.kind] : e.kind === "agent_entry" && e.entry.kind === "note" ? [e.entry.text] : []))).toEqual(["Look in the chat first.", "turn_paused", "turn_resumed"]);
    // What is kept as said is the message, not the note.
    expect((await r.harness.sides.turns({ id })).turns.map((turn) => turn.asked)).toEqual(["Who holds the lighthouse key?"]);
    for (const late of [r.harness.say({ run, text: "Too late." }), r.harness.pause({ run }), r.harness.resume({ run })]) expect((await refusal(late)).code).toBe("not_found");
  });

  test("a turn stopped while it is held ends as stopped", async () => {
    const stop = new AbortController();
    const first = Promise.withResolvers<Answer>();
    const r = rig(lines(() => first.promise, "never reached"));
    const asking = r.ask(await r.start(), "Who holds the lighthouse key?", stop.signal);
    await until(() => r.host.calls.length === 1);
    const run = r.host.traced[0]?.turn ?? "";
    await r.harness.pause({ run });
    first.resolve({ toolCalls: [call("chat_search", { query: "key" }, "s1")] });
    await idle();
    stop.abort();
    const { result, sink } = await asking;
    expect(result.status).toBe("stopped");
    expect(sink.order).toEqual(["error"]);
    expect(r.host.calls).toHaveLength(1);
  });
});
