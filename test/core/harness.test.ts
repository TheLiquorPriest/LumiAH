// A whole turn on an in-memory host and a scripted model (DESIGN §2, §3): the main agent chooses
// tools, calls write_reply, the writer answers, and the turn's record comes back; the main agent
// writing the reply itself; what happens when it stops short; and a changed setting and a replaced
// text taking effect on the next turn.

import { describe, expect, test } from "bun:test";
import { createHarness } from "../../src/core/harness";
import type { JsonObject, TraceEvent, TurnRequest } from "../../src/core/ports";
import { readCallPrompt } from "../../src/core/prompts";
import { recordOf, segmentOf } from "../../src/core/sessions";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { transcriptOf } from "../../src/core/transcript";
import { parseJson } from "../../src/core/util";
import { call, MAIN, MemoryHost, promptText, runTurn, type Script, settle, until, WRITER } from "./support/host";

const CHAT = "chat-1";

/** A host with a short chat and a preset, and a harness over it whose settings and texts the test changes. */
function rig(script: Script, change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  host.script = script;
  host.presets.set("preset-1", [
    { id: "b-main", name: "Main prompt", role: "system", kind: "instruction", marker: null, content: "Write in the present tense. Never speak for Mara.", enabled: true },
    { id: "b-history", name: "Chat history", role: "system", kind: "marker", marker: "chat_history", content: "", enabled: true },
  ]);
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I walk down to the lighthouse and knock.");
  const stored: { values: Settings; texts: Record<string, string> } = { values: defaultSettings(), texts: {} };
  stored.values.agents.writer!.connectionId = WRITER;
  change(stored.values);
  const harness = createHarness(host, { settings: async () => structuredClone(stored) });
  return { host, harness, stored, turn: (options: Parameters<typeof runTurn>[3] = {}) => runTurn(host, harness, CHAT, { presetId: "preset-1", ...options }) };
}

const events = (host: MemoryHost): TraceEvent[] => host.traced.map((r) => r.event);

describe("a whole turn", () => {
  const script: Script = [
    { content: "Let me check what the chat says of the lighthouse.", toolCalls: [call("chat_search", { query: "lighthouse" }, "c1")] },
    { toolCalls: [call("write_reply", { brief: "Okoro keeps the lighthouse; he was last seen leaving at dusk." }, "c2")] },
    { content: "The door opens a hand's width. Okoro's lamp swings behind it.", reasoning: "Keep it short.", finishReason: "stop" },
  ];

  test("the main agent works with tools, briefs the writer, and the writer's answer is the reply", async () => {
    const r = rig(script);
    const { result, sink } = await r.turn();
    expect(result.status).toBe("done");
    expect(result.reply).toBe("The door opens a hand's width. Okoro's lamp swings behind it.");
    expect(sink.text).toBe(result.reply);
    expect(sink.thinking).toBe("Keep it short.");
    expect(sink.ended?.finish).toBe("stop");
    expect(sink.failed).toBeNull();
    expect(sink.order.filter((kind) => kind === "done" || kind === "error")).toEqual(["done"]);
    expect(sink.order.at(-1)).toBe("done");
    expect(r.host.calls).toHaveLength(3);
    expect(result.usage).toMatchObject({ calls: 3, toolTurns: 2 });
  });

  test("the main agent is given its instructions, the request as a document with the preset's instructions marked, and the base tools", async () => {
    const r = rig(script);
    await r.turn();
    const [first] = r.host.calls;
    expect(first?.connectionId).toBeNull();
    expect(first?.messages[0]?.content).toStartWith("You are the main agent behind a roleplay chat in Lumiverse.");
    const told = first?.messages.at(-1)?.content ?? "";
    expect(told).toStartWith("The user sent a message: a reply is needed.");
    expect(told).toContain("[1] system · preset instruction “Main prompt”: the reply must achieve this\nWrite in the present tense. Never speak for Mara.");
    expect(told).toContain("[2] assistant · chat message #0, Joss\nThe harbour is quiet tonight.");
    expect(told).toContain("[3] user · chat message #1, Mara\nI walk down to the lighthouse and knock.");
    expect(told).toContain("Work out what this reply needs, then call write_reply with your brief.");
    // Its budget is told up front, so it can end its work within it.
    expect(told).toEndWith("[You have 24 rounds of tool calls for this. A round is one answer of yours that calls tools, however many. An answer that calls a tool after your last round isn't run and your work stops there, so keep a round for what must come last.]");
    // Every tool the core has that has something to offer here, in the order its tools name them: the book tools are left out (the chat has no book), and those that need a port this host doesn't have (memories, databanks).
    expect(first?.tools?.map((t) => t.name)).toEqual(["chat_search", "chat_grep", "chat_read", "lore_index", "lore_search", "lore_grep", "lore_read", "active_lore", "preset_instructions", "past_turn", "workspace_list", "workspace_read", "workspace_grep", "workspace_write", "workspace_edit", "workspace_move", "workspace_delete", "workspace_pin", "skill_load", "delegate", "agent_message", "job_start", "job_list", "job_read", "job_cancel", "write_reply", "chat_outline", "chat_about", "chat_around", "lore_related", "lore_about", "chronicle_check", "scratch_read"]);
    // The tool it called ran over the chat: its result is what the next call was sent.
    const result = r.host.calls[1]?.messages.at(-1)?.parts?.[0];
    expect(result?.type === "tool_result" ? result.content : "").toContain("I walk down to the lighthouse and knock.");
  });

  test("the writer's call is Lumiverse's messages as they came, with the brief put in, the request's sampling and no tools", async () => {
    const r = rig(script);
    const { request } = await r.turn({ params: { temperature: 0.7, top_p: 0.95, stop: ["\nMara:"] }, maxTokens: 512 });
    const writer = r.host.calls[2];
    expect(writer?.connectionId).toBe(WRITER);
    expect(writer?.tools).toBeUndefined();
    expect(writer?.params).toEqual({ temperature: 0.7, top_p: 0.95, stop: ["\nMara:"] });
    expect(writer?.maxTokens).toBe(512);
    expect(writer?.stream).toBe(true);
    const plain = request.messages.map(({ source: _source, ...m }) => m);
    expect(writer?.messages).toEqual([
      plain[0]!,
      plain[1]!,
      { role: "system", content: "[Notes for this reply, from a planner that has read the whole chat and its lore. Follow them where they bear on what you write; never mention them, and never quote them.]\nOkoro keeps the lighthouse; he was last seen leaving at dusk." },
      plain[2]!,
    ]);
  });

  test("the turn's record names its bodies by hash, and they are stored", async () => {
    const r = rig(script);
    const { result, request } = await r.turn();
    const record = result.record;
    expect(record).not.toBeNull();
    expect(recordOf(parseJson(JSON.stringify(record)))).toEqual(record);
    expect(record).toMatchObject({ v: 1, generationId: request.generationId, kind: "new" });
    expect(record?.summary).toBeUndefined();
    const segment = segmentOf(parseJson(r.host.blobStore.get(record?.segment ?? "") ?? ""));
    expect(segment).toMatchObject({ reply: 2, turn: "new", request: { messages: 3, last: 1 } });
    // What it called and what came back; the reply itself isn't kept: it is in the chat.
    expect(segment?.steps).toEqual([
      { kind: "said", text: "Let me check what the chat says of the lighthouse." },
      { kind: "call", name: "chat_search", args: { query: "lighthouse" }, result: expect.stringContaining("I walk down to the lighthouse and knock.") as unknown as string },
      { kind: "call", name: "write_reply", args: { brief: "Okoro keeps the lighthouse; he was last seen leaving at dusk." }, result: "the writer wrote the reply (61 characters; it is chat message #2)" },
    ]);
    expect(JSON.stringify(segment)).not.toContain("The door opens");
    const transcript = transcriptOf(r.host.blobStore.get(record?.transcript ?? "") ?? "");
    expect(transcript).toMatchObject({ turn: request.generationId, chatId: CHAT, generation: "new", ended: { status: "done" } });
    expect(transcript?.events).toEqual(r.host.traced);
  });

  test("every step goes to the trace, numbered with no gap, each call with its tokens, time, cost and exact prompt", async () => {
    const r = rig(script, (s) => (s.prices["scripted"] = { in: 1, cachedIn: 1, out: 1 }));
    await r.turn();
    expect(r.host.traced.map((record) => record.seq)).toEqual(r.host.traced.map((_, i) => i + 1));
    const all = events(r.host);
    expect(all[0]).toMatchObject({ kind: "turn_started", chatId: CHAT, generation: "new" });
    expect(all.at(-1)).toMatchObject({ kind: "turn_ended", status: "done", usage: { calls: 3 } });
    expect(all.find((e) => e.kind === "session")).toMatchObject({ session: { turns: 0, summary: false, dropped: [], missing: 0 } });
    const started = all.flatMap((e) => (e.kind === "agent_started" ? [e.agent] : []));
    expect(started.map((a) => a.role)).toEqual(["main", "writer"]);
    expect(started[1]?.parent).toBe(started[0]?.id);
    const answers = all.flatMap((e) => (e.kind === "agent_entry" && e.entry.kind === "answer" ? [e.entry] : []));
    expect(answers).toHaveLength(3);
    for (const answer of answers) {
      expect(answer.usage.in).toBeGreaterThan(0);
      expect(answer.usage.cost).toBeGreaterThan(0);
      expect(typeof answer.ms).toBe("number");
    }
    // The prompt each call names is the very request the model was sent.
    for (const [i, answer] of answers.entries()) expect(await readCallPrompt(r.host.blobs, answer.prompt ?? "")).toEqual(r.host.calls[i]!);
    expect(all.filter((e) => e.kind === "usage")).toHaveLength(3);
    expect(all.filter((e) => e.kind === "agent_idle")).toHaveLength(2);
  });

  test("the main agent's steps go to the reply's thinking block as progress lines", async () => {
    const r = rig(script);
    const { sink } = await r.turn();
    expect(sink.progressLines).toEqual(["LumiAH: the main agent starts without notes from earlier turns.", 'chat_search {"query":"lighthouse"}', 'write_reply {"brief":"Okoro keeps the lighthouse; he was last seen leaving at dusk."}', "Writing the reply from the main agent's brief…"]);
    const quiet = rig(script, (s) => (s.reply.progress = false));
    expect((await quiet.turn()).sink.progressLines).toEqual([]);
  });

  test("prompts and transcripts aren't stored while Settings keep none", async () => {
    const r = rig(script, (s) => (s.keep = { ...s.keep, prompts: false, transcripts: false }));
    const { result } = await r.turn();
    expect(result.record?.transcript).toBeUndefined();
    expect(events(r.host).some((e) => e.kind === "agent_entry" && e.entry.kind === "answer" && e.entry.prompt !== undefined)).toBe(false);
    expect([...r.host.blobStore.keys()]).toEqual([result.record?.segment ?? ""]);
  });
});

describe("the main agent writing the reply itself", () => {
  test("its final answer is the reply, and there is no second call", async () => {
    const r = rig([{ toolCalls: [call("chat_grep", { text: "harbour" }, "c1")] }, "The lamp turns, and the door stays shut."], (s) => (s.reply.writer = "main"));
    const { result, sink } = await r.turn();
    expect(result).toMatchObject({ status: "done", reply: "The lamp turns, and the door stays shut." });
    expect(sink.text).toBe("The lamp turns, and the door stays shut.");
    expect(r.host.calls).toHaveLength(2);
    expect(r.host.calls[0]?.tools?.map((t) => t.name)).not.toContain("write_reply");
    expect(r.host.calls[0]?.messages[0]?.content).toContain("Each turn a reply is needed, and you write it.");
    expect(r.host.calls[0]?.messages.at(-1)?.content).toContain("Work out what this reply needs, then answer with the reply itself.");
    expect(events(r.host).flatMap((e) => (e.kind === "agent_started" ? [e.agent.role] : []))).toEqual(["main"]);
    const segment = segmentOf(parseJson(r.host.blobStore.get(result.record?.segment ?? "") ?? ""));
    expect(segment?.steps.at(-1)).toEqual({ kind: "reply", chars: 40 });
  });
});

describe("a main agent that stops short", () => {
  test("an answer without write_reply goes to the writer in the brief's place, and the thinking block, the trace and the notes all say that is what happened", async () => {
    const r = rig(["Okoro is away; the door is locked.", "Nobody answers."]);
    const { result, sink } = await r.turn();
    expect(result).toMatchObject({ status: "done", reply: "Nobody answers." });
    expect(promptText(r.host.calls[1])).toContain("never quote them.]\nOkoro is away; the door is locked.");
    expect(sink.progressLines).toContain("The main agent ended without calling write_reply; the writer is given its last answer as the brief.");
    expect(sink.progressLines).not.toContain("Writing the reply from the main agent's brief…");
    const writer = events(r.host).flatMap((e) => (e.kind === "agent_started" && e.agent.role === "writer" ? [e.agent.task] : []));
    expect(writer).toEqual(["write the reply from the main agent's last answer, taken as its brief: it never called write_reply"]);
    // Its notes keep what it wrote, and what became of it: never a write_reply call, which it didn't make.
    const segment = segmentOf(parseJson(r.host.blobStore.get(result.record?.segment ?? "") ?? ""));
    expect(segment?.steps).toEqual([
      { kind: "said", text: "Okoro is away; the door is locked." },
      { kind: "stop", reason: "you ended without calling write_reply, so that answer was handed to the writer as your brief, and the writer wrote the reply (15 characters; it is chat message #2)" },
    ]);
    expect(segment?.steps.some((step) => step.kind === "call")).toBe(false);
  });

  test("an answer cut at its length limit is no brief: the main agent stopped short, and the writer writes from the request alone", async () => {
    const r = rig([{ content: "I'll check the lore fir", finishReason: "length" }, "A reply from the preset alone."]);
    const { result, sink, request } = await r.turn();
    expect(result).toMatchObject({ status: "done", reply: "A reply from the preset alone." });
    expect(r.host.calls.at(-1)?.messages).toEqual(request.messages.map(({ source: _source, ...m }) => m));
    expect(sink.progressLines.at(-1)).toStartWith("The main agent stopped before its brief (its answer was cut at its length limit (Answer per call)");
    const segment = segmentOf(parseJson(r.host.blobStore.get(result.record?.segment ?? "") ?? ""));
    expect(segment?.steps[0]).toEqual({ kind: "said", text: "I'll check the lore fir" });
  });

  test("a call isn't made with its answer tokens nearly spent: the agent stops instead of writing an answer that would be cut", async () => {
    const usage = { prompt_tokens: 50, completion_tokens: 900 };
    const r = rig([{ toolCalls: [call("chat_search", { query: "lamp" })], usage }, "A reply from the preset alone."], (s) => (s.agents.main!.budget.tokensOut = 1000));
    const { result, sink } = await r.turn();
    // 100 answer tokens were left of 1000, fewer than Least answer room: the main agent's second call was never made, and the writer's was.
    expect(r.host.calls).toHaveLength(2);
    expect(result).toMatchObject({ status: "done", reply: "A reply from the preset alone." });
    expect(sink.progressLines.some((line) => line.includes("fewer than Least answer room (256)"))).toBe(true);
  });

  const looping: Script = (request, n) => (request.tools ? { toolCalls: [call("chat_search", { query: `try ${n}` })] } : "A reply from the preset alone.");

  test("stopped by a budget, the writer writes from the request alone, and the thinking block and the trace both say so and why", async () => {
    const r = rig(looping, (s) => {
      s.agents.main!.budget.toolTurns = 2;
      // Room for the whole reason in the progress line.
      s.reply.progressChars = 400;
    });
    const { result, sink, request } = await r.turn();
    expect(result).toMatchObject({ status: "done", reply: "A reply from the preset alone." });
    expect(r.host.calls.at(-1)?.messages).toEqual(request.messages.map(({ source: _source, ...m }) => m));
    const why = "the agent has had its 2 rounds of tool calls, all that Tool rounds per agent (Settings → Agents → Main agent → Budget) allows";
    expect(sink.progressLines.at(-1)).toBe(`The main agent stopped before its brief (${why}); the writer writes from your preset alone.`);
    // The trace: the main agent's stop with its reason, then the writer started for a reply without a brief, with the same reason.
    const traced = events(r.host);
    expect(traced.flatMap((e) => (e.kind === "agent_entry" && e.entry.kind === "stop" ? [e.entry.reason] : []))).toEqual([why]);
    const writer = traced.flatMap((e) => (e.kind === "agent_started" && e.agent.role === "writer" ? [e.agent] : []));
    expect(writer.map((agent) => agent.task)).toEqual([`write the reply without a brief: the main agent stopped short of one (${why})`]);
    const segment = segmentOf(parseJson(r.host.blobStore.get(result.record?.segment ?? "") ?? ""));
    expect(segment?.steps.at(-1)).toEqual({ kind: "stop", reason: why });
  });

  test("or the turn fails, when Settings say so: no reply, no record, one error", async () => {
    const r = rig(looping, (s) => {
      s.agents.main!.budget.toolTurns = 2;
      s.reply.withoutBrief = "fail";
    });
    const { result, sink } = await r.turn();
    const why = "the agent has had its 2 rounds of tool calls, all that Tool rounds per agent (Settings → Agents → Main agent → Budget) allows";
    expect(result).toMatchObject({ status: "failed", reason: why, record: null, reply: "" });
    expect(sink.failed).toEqual({ message: why, code: "failed" });
    expect(sink.ended).toBeNull();
    expect(events(r.host).at(-1)).toMatchObject({ kind: "turn_ended", status: "failed" });
  });

  test("a writer that fails before any of the reply is sent is the main agent's to try again", async () => {
    const r = rig([{ toolCalls: [call("write_reply", { brief: "First brief." }, "c1")] }, { error: "401: the key was refused" }, { toolCalls: [call("write_reply", { brief: "Second brief." }, "c2")] }, "The reply, at the second try."]);
    const { result } = await r.turn();
    expect(result).toMatchObject({ status: "done", reply: "The reply, at the second try." });
    const failed = r.host.calls[2]?.messages.at(-1)?.parts?.[0];
    expect(failed).toMatchObject({ type: "tool_result", isError: true, content: "The writer couldn't write the reply: 401: the key was refused. Nothing was sent to the user. Call write_reply again to try once more." });
  });

  test("a writer's call that fails in passing is made again, and the trace and the thinking block show each try", async () => {
    const r = rig([{ toolCalls: [call("write_reply", { brief: "A brief." }, "c1")] }, { error: "503: overloaded" }, { error: "the stream was cut", deltas: [] }, "The door opens."], (s) => (s.loop.retryWaitMs = 750));
    r.host.clock.auto = true;
    const { result, sink } = await r.turn();
    expect(result).toMatchObject({ status: "done", reply: "The door opens." });
    expect(sink.text).toBe("The door opens.");
    expect(r.host.calls).toHaveLength(4);
    expect(r.host.clock.slept).toEqual([750, 750]);
    const traced = events(r.host);
    const writer = traced.flatMap((e) => (e.kind === "agent_started" && e.agent.role === "writer" ? [e.agent.id] : []));
    const retries = traced.flatMap((e) => (e.kind === "agent_entry" && e.entry.kind === "retry" ? [{ agent: e.agentId, ...e.entry }] : []));
    expect(retries).toMatchObject([
      { agent: writer[0], reason: "503: overloaded", attempt: 1, of: 2, waitMs: 750 },
      { agent: writer[0], reason: "the stream was cut", attempt: 2, of: 2, waitMs: 750 },
    ]);
    expect(sink.progressLines.slice(-2)).toEqual(["A model call failed (503: overloaded); trying again, 1 of 2…", "A model call failed (the stream was cut); trying again, 2 of 2…"]);
    // The main agent is told nothing went wrong: it called write_reply once.
    expect(r.host.calls.filter((c) => c.tools !== undefined)).toHaveLength(1);
  });

  test("a writer that breaks off after part of the reply was sent fails the turn: its call is never made again, and no second reply is written after it", async () => {
    const r = rig([{ toolCalls: [call("write_reply", { brief: "A brief." }, "c1")] }, { deltas: ["The door ", "opens"], error: "the stream was cut" }, "never reached"]);
    // Were the call made again, nothing would hold it back: the wait is over at once.
    r.host.clock.auto = true;
    const { result, sink } = await r.turn();
    expect(result).toMatchObject({ status: "failed", reason: "the stream was cut", reply: "The door opens" });
    expect(sink.text).toBe("The door opens");
    expect(sink.failed).toEqual({ message: "the stream was cut", code: "failed" });
    expect(sink.ended).toBeNull();
    expect(r.host.calls).toHaveLength(2);
    expect(events(r.host).some((e) => e.kind === "agent_entry" && e.entry.kind === "retry")).toBe(false);
    expect(r.host.clock.slept).toEqual([]);
    // What reached the user is on a message, so its record is made: the main agent's notes keep the turn.
    expect(result.record).not.toBeNull();
  });

  test("a host that streams nothing still delivers the reply, whole", async () => {
    const r = rig([{ toolCalls: [call("write_reply", { brief: "A brief." }, "c1")] }, { content: "The door opens.", deltas: [] }]);
    const { result, sink } = await r.turn();
    expect(result).toMatchObject({ status: "done", reply: "The door opens." });
    expect(sink.order.filter((kind) => kind === "content")).toEqual(["content"]);
    expect(sink.text).toBe("The door opens.");
  });

  test("a main agent that writes the reply itself and stops short fails the turn: there is no writer to fall back on", async () => {
    const r = rig(looping, (s) => {
      s.reply.writer = "main";
      s.agents.main!.budget.toolTurns = 1;
    });
    const { result, sink } = await r.turn();
    expect(result).toMatchObject({ status: "failed", record: null, reply: "" });
    expect(sink.failed?.message).toBe("the agent has had its 1 round of tool calls, all that Tool rounds per agent (Settings → Agents → Main agent → Budget) allows");
  });

  test("the turn's signal stops it before any text: the sink gets one error, and nothing is recorded", async () => {
    const r = rig([{ hang: true }]);
    const stop = new AbortController();
    const running = r.turn({ signal: stop.signal });
    await until(() => r.host.calls.length === 1);
    stop.abort();
    const { result, sink } = await running;
    expect(result).toMatchObject({ status: "stopped", record: null, reply: "" });
    expect(sink.failed).toEqual({ message: "the turn was stopped", code: "stopped" });
    expect(events(r.host).at(-1)).toMatchObject({ kind: "turn_ended", status: "stopped" });
  });

  test("stopped while the reply streams, the turn ends as stopped, not failed, and the text already sent is kept with its record", async () => {
    const r = rig([{ toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "c1")] }, { content: "The door opens a hand's width. Okoro's lamp", hang: "after" }]);
    const stop = new AbortController();
    const running = r.turn({ signal: stop.signal });
    await until(() => r.host.calls.length === 2);
    await settle();
    stop.abort(new Error("you pressed Stop"));
    const { result, sink } = await running;
    expect(result.status).toBe("stopped");
    expect(result.reason).toBe("you pressed Stop");
    expect(result.reply).toBe("The door opens a hand's width. Okoro's lamp");
    expect(sink.text).toBe(result.reply);
    expect(sink.failed).toBeNull();
    expect(sink.ended?.finish).toBe("stop");
    expect(result.record).not.toBeNull();
    expect(events(r.host).at(-1)).toMatchObject({ kind: "turn_ended", status: "stopped", reason: "you pressed Stop" });
  });

  test("a turn whose notes can't be stored says so in the reply's thinking block and in the trace, and leaves no record", async () => {
    const r = rig([{ toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "c1")] }, "The door opens."], (s) => (s.keep.prompts = false));
    const put = r.host.blobs.put;
    // The store refuses the turn's notes (the first blob the turn writes, since it keeps no prompts).
    r.host.blobs.put = () => Promise.reject(new Error("the store is full"));
    const { result, sink } = await r.turn();
    r.host.blobs.put = put;
    expect(result).toMatchObject({ status: "done", record: null, reply: "The door opens." });
    expect(sink.progressLines.at(-1)).toBe("This turn's notes couldn't be stored (the store is full): the reply stands, but the main agent won't remember this turn.");
    expect(sink.order.at(-1)).toBe("done");
    expect(events(r.host).some((e) => e.kind === "notice" && e.text.includes("the store is full"))).toBe(true);
  });
});

describe("LumiAH failing never costs the reply", () => {
  const briefs: Script = (request) => (request.tools ? { toolCalls: [call("write_reply", { brief: "Okoro opens the door." })] } : "The door opens.");
  const asCame = (request: TurnRequest) => request.messages.map(({ source: _source, ...m }) => m);
  const writerTasks = (host: MemoryHost): (string | undefined)[] => events(host).flatMap((e) => (e.kind === "agent_started" && e.agent.role === "writer" ? [e.agent.task] : []));

  /** A chat with one turn made, the user's next message, and the chat's path failing to be read: once, or every time. */
  async function unread(times: number, change: (s: Settings) => void = () => undefined) {
    const r = rig(briefs, change);
    await r.turn();
    r.host.say(CHAT, "user", "I knock again.");
    const path = r.host.chat.path;
    let left = times;
    r.host.chat.path = (chatId) => (left-- > 0 ? Promise.reject(new Error("chat.path: no answer in time")) : path(chatId));
    return { ...r, before: r.host.calls.length };
  }

  const why = "chat.path: no answer in time";

  test("a session that can't be resumed: the writer writes from the request alone, and the thinking block and the trace say what failed", async () => {
    const r = await unread(1);
    const { result, sink, request } = await r.turn();
    expect(result).toMatchObject({ status: "done", reply: "The door opens." });
    expect(sink.text).toBe("The door opens.");
    expect(sink.failed).toBeNull();
    expect(sink.order.at(-1)).toBe("done");
    // The main agent never began: the turn's one call is the writer's, sent the request as it came.
    expect(r.host.calls.slice(r.before)).toHaveLength(1);
    expect(r.host.calls.at(-1)?.messages).toEqual(asCame(request));
    const line = `The main agent had no part in this reply (${why}); the writer writes from your preset alone.`;
    expect(sink.progressLines).toContain(line);
    expect(events(r.host).some((e) => e.kind === "notice" && e.text === line)).toBe(true);
    expect(writerTasks(r.host).at(-1)).toBe(`write the reply without a brief: LumiAH failed before the main agent gave one (${why})`);
    expect(events(r.host).at(-1)).toMatchObject({ kind: "turn_ended", status: "done" });
  });

  test("the turn's record says what failed, and the main agent reads it in its notes on the next turn", async () => {
    const r = await unread(1);
    const { result } = await r.turn();
    // The chat was read once more for the record, after the reply was written.
    const kept = "LumiAH failed before you gave a brief (chat.path: no answer in time), so the writer was started on the reply from the request alone";
    expect(segmentOf(parseJson(r.host.blobStore.get(result.record?.segment ?? "") ?? ""))?.steps).toEqual([{ kind: "stop", reason: kept }]);
    r.host.say(CHAT, "user", "I wait.");
    await r.turn();
    expect(promptText(r.host.calls.findLast((c) => c.tools !== undefined))).toContain(`- you stopped before you were done: ${kept}`);
  });

  test("a chat that can't be read at all still gets its reply: the turn leaves no record, and the log says so", async () => {
    const r = await unread(Number.POSITIVE_INFINITY);
    const { result, sink } = await r.turn();
    expect(result).toMatchObject({ status: "done", reply: "The door opens.", record: null });
    expect(sink.text).toBe("The door opens.");
    expect(r.host.logs.some((log) => log.level === "warn" && log.message.startsWith(`the chat couldn't be read for the turn's record (${why})`))).toBe(true);
  });

  test("where Settings say a turn without a brief fails, it fails with what failed, and no model is called", async () => {
    const r = await unread(1, (s) => (s.reply.withoutBrief = "fail"));
    const { result, sink } = await r.turn();
    expect(result).toMatchObject({ status: "failed", reason: why, record: null, reply: "" });
    expect(sink.failed).toEqual({ message: why, code: "failed" });
    expect(r.host.calls).toHaveLength(r.before);
  });

  test("a main agent that writes the reply itself has no writer to fall back on: the turn fails with what failed", async () => {
    const r = rig(["The door opens.", "never reached"], (s) => (s.reply.writer = "main"));
    r.host.chat.path = () => Promise.reject(new Error(why));
    const { result, sink } = await r.turn();
    expect(result).toMatchObject({ status: "failed", reason: why, reply: "" });
    expect(sink.failed?.message).toBe(why);
    expect(r.host.calls).toHaveLength(0);
  });

  test("stopped while the writer writes alone, the turn ends as stopped", async () => {
    const r = await unread(1);
    r.host.script = () => ({ hang: true });
    const stop = new AbortController();
    const running = r.turn({ signal: stop.signal });
    await until(() => r.host.calls.length === r.before + 1);
    stop.abort();
    expect((await running).result).toMatchObject({ status: "stopped", record: null, reply: "" });
  });

  const unreadWhy = "LumiAH couldn't read its settings (the link is down): check that the runtime is linked to the extension";

  test("settings that can't be read: the writer writes from the request alone on the host's default connection, and nothing the user may have switched off is kept", async () => {
    const host = new MemoryHost();
    host.script = ["A reply from the preset alone."];
    host.say(CHAT, "user", "Hello?");
    const harness = createHarness(host, { settings: () => Promise.reject(new Error("the link is down")) });
    const { result, sink, request } = await runTurn(host, harness, CHAT);
    expect(result).toMatchObject({ status: "done", reply: "A reply from the preset alone." });
    expect(sink.failed).toBeNull();
    // One call, the writer's: the request as it came, with its own sampling and answer room, on no connection of LumiAH's choosing (null: the user's default).
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]).toMatchObject({ connectionId: null, model: null, maxTokens: 700, params: { temperature: 0.9 } });
    expect(host.calls[0]?.tools).toBeUndefined();
    expect(host.calls[0]?.messages).toEqual(asCame(request));
    // The thinking block's line is clipped at Progress line length; the trace has it whole.
    expect(sink.progressLines.some((line) => line.startsWith("The main agent had no part in this reply (LumiAH couldn't read its settings (the link is down)"))).toBe(true);
    expect(events(host).some((e) => e.kind === "notice" && e.text === `The main agent had no part in this reply (${unreadWhy}); the writer writes from your preset alone.`)).toBe(true);
    expect(writerTasks(host)).toEqual([`write the reply without a brief: LumiAH failed before the main agent gave one (${unreadWhy})`]);
    // Its notes say why; no prompt and no transcript is kept, since whether the user keeps them couldn't be read.
    expect(segmentOf(parseJson(host.blobStore.get(result.record?.segment ?? "") ?? ""))?.steps).toEqual([{ kind: "stop", reason: `LumiAH failed before you gave a brief (${unreadWhy}), so the writer was started on the reply from the request alone` }]);
    expect(result.record?.transcript).toBeUndefined();
    expect(events(host).some((e) => e.kind === "agent_entry" && e.entry.kind === "answer" && e.entry.prompt !== undefined)).toBe(false);
  });
});

describe("a changed setting and a replaced text", () => {
  test("take effect on the next turn", async () => {
    const r = rig((request) => (request.tools ? { toolCalls: [call("write_reply", { brief: "Keep the lamp lit." })] } : "A reply."));
    await r.turn();
    expect(r.host.calls[0]).toMatchObject({ connectionId: null, maxTokens: 16_000 });
    expect(r.host.calls[1]?.messages.at(-2)).toMatchObject({ role: "system" });

    r.stored.values.agents.main!.connectionId = WRITER;
    r.stored.values.agents.main!.model = "model-small";
    r.stored.values.agents.main!.effort = "low";
    r.stored.values.agents.main!.budget.callTokensOut = 2000;
    r.stored.values.agents.main!.tools = ["chat_read", "write_reply"];
    r.stored.values.agents.writer!.connectionId = MAIN;
    r.stored.values.reply.briefRole = "user";
    r.stored.values.reply.briefAt = "end";
    r.stored.texts["main.system"] = "You plan each reply in one line.";
    r.stored.texts["writer.brief"] = "(Planner's note: {{brief}})";
    r.stored.texts["tool.chat_read"] = "Read the chat.";
    r.host.say(CHAT, "user", "I knock again.");
    const before = r.host.calls.length;
    await r.turn();
    const main = r.host.calls[before];
    expect(main).toMatchObject({ connectionId: WRITER, model: "model-small", effort: "low", maxTokens: 2000 });
    expect(main?.messages[0]?.content).toBe("You plan each reply in one line.");
    expect(main?.tools?.map((t) => [t.name, t.description])).toEqual([["chat_read", "Read the chat."], ["write_reply", expect.any(String) as unknown as string], ["scratch_read", expect.any(String) as unknown as string]]);
    const writer = r.host.calls[before + 1];
    expect(writer?.connectionId).toBe(MAIN);
    expect(writer?.messages.at(-1)).toEqual({ role: "user", content: "(Planner's note: Keep the lamp lit.)" });
  });

  test("a text of the user's that drops a placeholder it must keep isn't sent: the shipped one is", async () => {
    const r = rig((request) => (request.tools ? { toolCalls: [call("write_reply", { brief: "Keep the lamp lit." })] } : "A reply."));
    r.stored.texts["writer.brief"] = "A note with no place for the brief.";
    await r.turn();
    expect(r.host.calls[1]?.messages.at(-2)?.content).toEndWith("never quote them.]\nKeep the lamp lit.");
  });

  test("an extension's own tool, registered and given to the main agent, is offered and run", async () => {
    const r = rig([{ toolCalls: [call("tide_table", {}, "c1")] }, { toolCalls: [call("write_reply", { brief: "High water at six." }, "c2")] }, "The tide is in."]);
    const asked: JsonObject[] = [];
    r.harness.tools.register({ name: "tide_table", family: "tides", tier: "read", build: (env) => ({ name: "tide_table", description: `Tides for ${env.run.chatId}.`, parameters: { type: "object", properties: {} }, run: async (args) => (asked.push(args), { text: "High water at six." }) }) });
    r.stored.values.agents.main!.tools.push("tide_table");
    await r.turn();
    expect(r.host.calls[0]?.tools?.map((t) => t.name)).toContain("tide_table");
    expect(asked).toEqual([{}]);
  });
});

describe("a streaming answer, for the live view", () => {
  const script: Script = [
    { content: "Let me check what the chat says of the lighthouse.", reasoning: "Where is the lighthouse named?", toolCalls: [call("chat_search", { query: "lighthouse" }, "c1")], pace: 90 },
    { toolCalls: [call("write_reply", { brief: "Okoro keeps the lighthouse." }, "c2")] },
    { content: "The door opens a hand's width. Okoro's lamp swings behind it.", reasoning: "Keep it short.", pace: 90 },
  ];

  /** The pieces the live view was sent, in the order they came. */
  const pieces = (host: MemoryHost) => host.feed.flatMap((item) => ("delta" in item ? [item.delta] : []));
  const writerOf = (host: MemoryHost) => events(host).flatMap((e) => (e.kind === "agent_started" && e.agent.role === "writer" ? [e.agent.id] : []))[0];

  test("its pieces arrive in order, add up to the answer's text and reasoning, and stop before the answer's entry", async () => {
    const r = rig(script);
    const { request, result } = await r.turn();
    // What each agent's pieces have added up to for its call under way, held against the answer as its entry arrives.
    const live = new Map<string, { text: string; reasoning: string }>();
    const answered = new Map<string, number>();
    const closed: { text: string; reasoning: string }[] = [];
    let at = 0;
    for (const item of r.host.feed) {
      if ("delta" in item) {
        const piece = item.delta;
        expect(piece).toMatchObject({ turn: request.generationId, chatId: CHAT });
        expect(piece.at).toBeGreaterThanOrEqual(at);
        at = piece.at;
        // A piece is of the call its agent's next answer closes: one that came after its entry would carry a count already used.
        expect(piece.call).toBe((answered.get(piece.agentId) ?? 0) + 1);
        const so = live.get(piece.agentId) ?? { text: "", reasoning: "" };
        live.set(piece.agentId, { text: so.text + (piece.text ?? ""), reasoning: so.reasoning + (piece.reasoning ?? "") });
        continue;
      }
      const { event } = item.record;
      if (event.kind !== "agent_entry" || event.entry.kind !== "answer") continue;
      answered.set(event.agentId, (answered.get(event.agentId) ?? 0) + 1);
      const got = live.get(event.agentId) ?? { text: "", reasoning: "" };
      expect(got).toEqual({ text: event.entry.text, reasoning: event.entry.reasoning ?? "" });
      closed.push(got);
      live.delete(event.agentId);
    }
    expect(live.size).toBe(0);
    // Three calls answered: the main agent's two (the second said nothing beside its call) and the writer's.
    expect(closed).toEqual([
      { text: "Let me check what the chat says of the lighthouse.", reasoning: "Where is the lighthouse named?" },
      { text: "", reasoning: "" },
      { text: "The door opens a hand's width. Okoro's lamp swings behind it.", reasoning: "Keep it short." },
    ]);
    // For the live view only: none is numbered among the turn's events or stored with its transcript.
    expect(r.host.traced.map((record) => record.seq)).toEqual(r.host.traced.map((_, i) => i + 1));
    expect(transcriptOf(r.host.blobStore.get(result.record?.transcript ?? "") ?? "")?.events).toEqual(r.host.traced);
  });

  test("pieces go at most once in the interval Settings give, each with all that arrived since, and what is left goes when the call ends", async () => {
    const r = rig(script, (s) => (s.trace.deltaMs = 200));
    await r.turn();
    const writer = pieces(r.host).filter((piece) => piece.agentId === writerOf(r.host));
    // Twelve pieces streamed 90 ms apart reach the view as five: the first at once, then one each time the interval is up, then the rest.
    expect(writer.map((piece) => piece.reasoning ?? piece.text)).toEqual(["Keep it short.", "The door opens ", "a hand's width. ", "Okoro's lamp swings ", "behind it."]);
    expect(writer.slice(1).map((piece, i) => piece.at - (writer[i]?.at ?? 0))).toEqual([270, 270, 270, 180]);
    expect(writer.every((piece) => piece.call === 1)).toBe(true);
  });

  test("at 0 the view is sent none; a host that takes none still answers; and a call that doesn't stream has none to send", async () => {
    const off = rig(script, (s) => (s.trace.deltaMs = 0));
    const { sink } = await off.turn();
    expect(pieces(off.host)).toEqual([]);
    expect(sink.text).toBe("The door opens a hand's width. Okoro's lamp swings behind it.");

    const plain = rig(script);
    delete plain.host.trace.delta;
    expect((await plain.turn()).result.status).toBe("done");
    expect(plain.host.logs).toEqual([]);

    // With Streaming off only the writer's call streams, as its reply always does: the live view watches a stream, it never asks for one.
    const quiet = rig(script, (s) => (s.loop.stream = false));
    await quiet.turn();
    expect(quiet.host.calls.map((c) => c.stream === true)).toEqual([false, false, true]);
    expect([...new Set(pieces(quiet.host).map((piece) => piece.agentId))]).toEqual([writerOf(quiet.host) ?? ""]);
  });
});
