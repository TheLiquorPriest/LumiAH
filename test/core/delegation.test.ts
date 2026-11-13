// Delegation (DESIGN §14) through whole turns on the in-memory host: the main agent hands tasks to
// sub-agents with `delegate` and goes on with them by their handles with `agent_message`, under the
// settings that bound it: how deep it goes, how many work at once, how many a turn starts, what a
// sub-agent may be given, and how much of a task's files goes with it.
//
// One scripted model answers every agent, so a script says which agent each answer is for: an
// agent's calls are told from another's by its instructions (the call's system message) and, for
// two agents of one definition, by the task that opens their conversation.

import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../../src/core/agents";
import { checkAgent, type StoredDefinitions } from "../../src/core/definitions";
import { createHarness } from "../../src/core/harness";
import { textHash } from "../../src/core/hash";
import type { AgentStarted, ModelPart, ModelRequest, TraceEvent } from "../../src/core/ports";
import { defaultSettings, newAgentSettings, type Settings } from "../../src/core/settings";
import { renderDefault, TEXT } from "../../src/core/texts";
import { transcriptOf } from "../../src/core/transcript";
import { versionOf } from "../../src/core/workspace";
import { type Answer, call, idle, MemoryHost, promptText, runTurn, type Script, until } from "./support/host";

const CHAT = "chat-1";

/** How the main agent's instructions open, whoever writes the reply. */
const MAIN = "You are the main agent behind a roleplay chat in Lumiverse.";
const SUMMARIZER = renderDefault(TEXT.agents.summarizer);
const SCOUT = "You are a scout. Find what your task names and report it in a line.";

const PLAN = "Mara wants the lighthouse lit before the storm.\nBrann holds the key.";
const BRANN = "Brann mends nets by the quay and trusts nobody.";

/** What ends the first message of an agent that has `n` rounds of tool calls. */
const rounds = (n: number): string => `\n\n[You have ${n} rounds of tool calls for this. A round is one answer of yours that calls tools, however many. An answer that calls a tool after your last round isn't run and your work stops there, so keep a round for what must come last.]`;

/** What a delegating agent is told of an agent that answered (the line that names its handle, then its answer), and of one that stopped short. */
const answered = (answer: string, handle: string, agent = "summarizer"): string => `${renderDefault(TEXT.agents.from, { agent, handle })}\n\n${answer}`;
const stopped = (handle: string, why: string, agent = "summarizer"): string => `${agent} (handle ${handle}) stopped before it answered: ${why}\nagent_message with this handle has it go on, if it still may; or go on without it.`;

const version = async (text: string): Promise<string> => versionOf(await textHash(text));

// ---------------------------------------------------------------- a script for several agents

/** One answer of an agent's: as it is, or made from the call it answers. */
type Line = Answer | ((request: ModelRequest, n: number) => Answer | Promise<Answer>);

/** One agent's lines: which model calls are its own, and what it answers them with: a line for each of its calls in the order they come, or one line for them all. */
interface Part {
  is(request: ModelRequest): boolean;
  says: readonly Line[] | ((request: ModelRequest, n: number) => Answer | Promise<Answer>);
}

/** A call's instructions: its system message. */
const system = (request: ModelRequest | undefined): string => (request?.messages[0]?.role === "system" ? request.messages[0].content : "");

/** The message that opens a call's conversation: for a sub-agent, its task. */
const told = (request: ModelRequest | undefined): string => request?.messages.find((m) => m.role === "user")?.content ?? "";

const main = (says: Part["says"]): Part => ({ is: (request) => system(request).includes(MAIN), says });

/** The agents whose instructions are `instructions`; with `task`, the one of them whose task holds it. */
const agent = (instructions: string, says: Part["says"], task = ""): Part => ({ is: (request) => system(request).includes(instructions) && told(request).includes(task), says });

/** A script that answers each call with the next line of the first part the call belongs to. A call nobody has a line for fails, and the turn says so. */
function cast(...parts: Part[]): Script {
  const made = parts.map(() => 0);
  return (request) => {
    const at = parts.findIndex((part) => part.is(request));
    const part = parts[at];
    if (!part) throw new Error(`nothing is scripted for the agent whose instructions open "${system(request).slice(0, 40)}"`);
    const n = made[at] ?? 0;
    made[at] = n + 1;
    const line = typeof part.says === "function" ? part.says : part.says[n];
    if (line === undefined) throw new Error(`no answer ${n + 1} is scripted for the agent whose instructions open "${system(request).slice(0, 40)}"`);
    return typeof line === "function" ? line(request, n) : line;
  };
}

/** A `delegate` call to the summarizer. */
const delegate = (task: string, id: string, more: { agent?: string; files?: string[] | string } = {}) => call("delegate", { agent: more.agent ?? "summarizer", task, ...(more.files !== undefined ? { files: more.files } : {}) }, id);

// ---------------------------------------------------------------- the rig

/** A definition registered beside the core's: it runs with what a new agent runs with (the summarizer's tools and budget) unless a test says otherwise. */
function scout(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: "scout", name: "Scout", description: "Finds what a task names.", instructions: SCOUT, given: "task", ...newAgentSettings(), ...over };
}

/** The tools of a scout whose definition names delegation's two beside what a new agent reads with. */
const DELEGATING: string[] = [...newAgentSettings().tools, "delegate", "agent_message"];

/** A host with a short chat, and a harness over it whose settings the test changes. The main agent writes the reply itself, so a turn's model calls are its own and its sub-agents'. */
function rig(script: Script, change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  host.script = script;
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I walk down to the lighthouse and knock.");
  const stored: { values: Settings; texts: Record<string, string>; definitions?: StoredDefinitions } = { values: defaultSettings(), texts: {} };
  stored.values.reply.writer = "main";
  change(stored.values);
  const harness = createHarness(host, { settings: async () => structuredClone(stored) });
  return { host, harness, stored, turn: (options: Parameters<typeof runTurn>[3] = {}) => runTurn(host, harness, CHAT, options) };
}

const events = (host: MemoryHost): TraceEvent[] => host.traced.map((r) => r.event);

/** The agents that started work as `role`, in the order they started. */
const started = (host: MemoryHost, role: string): AgentStarted[] => events(host).flatMap((e) => (e.kind === "agent_started" && e.agent.role === role ? [e.agent] : []));

/** The model calls of the agents whose instructions hold `instructions`, in order. */
const callsOf = (host: MemoryHost, instructions: string): ModelRequest[] => host.calls.filter((request) => system(request).includes(instructions));

/** The results of the round of tool calls a request ends with, in the calls' order. */
const results = (request: ModelRequest | undefined): Extract<ModelPart, { type: "tool_result" }>[] => (request?.messages.at(-1)?.parts ?? []).flatMap((part) => (part.type === "tool_result" ? [part] : []));

const toolsOf = (request: ModelRequest | undefined): string[] => request?.tools?.map((tool) => tool.name) ?? [];

/** The handle a delegate's result names, as a model copies it from there. */
const handleIn = (text: string | undefined): string => /handle (agent_[0-9a-f]{8})/.exec(text ?? "")?.[1] ?? "";

/** A line that sends a follow-up to the first handle its agent was told of. */
const follow = (text: string, id: string) => (request: ModelRequest): Answer => ({ toolCalls: [call("agent_message", { handle: handleIn(promptText(request)), text }, id)] });

// ---------------------------------------------------------------- delegate

describe("delegate", () => {
  const script = (): Script =>
    cast(
      main([{ content: "The summarizer can look that up.", toolCalls: [delegate("Say who keeps the lighthouse, from the chat.", "d1")] }, "The door opens a hand's width."]),
      agent(SUMMARIZER, [{ toolCalls: [call("chat_search", { query: "lighthouse" }, "s1")] }, "Nobody in the chat says who keeps it."]),
    );

  test("starts the named agent in a session of its own: its own instructions and the task, and none of the main agent's conversation", async () => {
    const r = rig(script());
    await r.turn();
    const [first] = callsOf(r.host, SUMMARIZER);
    expect(first?.messages).toEqual([
      { role: "system", content: SUMMARIZER },
      { role: "user", content: `Say who keeps the lighthouse, from the chat.${rounds(12)}` },
    ]);
    // Neither the request the main agent was sent nor what it wrote beside its call.
    expect(promptText(r.host.calls[0])).toContain("I walk down to the lighthouse and knock.");
    expect(promptText(first)).not.toContain("I walk down to the lighthouse and knock.");
    expect(promptText(first)).not.toContain("The summarizer can look that up.");
    // Its own tools, which reach the chat for themselves.
    expect(toolsOf(first)).toEqual(["chat_search", "chat_grep", "chat_read", "lore_search", "lore_read", "workspace_list", "workspace_read", "workspace_grep", "scratch_read"]);
    // How a hit is written is the chat tools' own test: here, that the message reached it.
    expect(results(callsOf(r.host, SUMMARIZER)[1])[0]?.content).toContain("I walk down to the lighthouse and knock.");
  });

  test("its answer is the tool's result, with a handle, and the main agent reads it and goes on", async () => {
    const r = rig(script());
    const { result } = await r.turn();
    const [sub] = started(r.host, "summarizer");
    expect(sub?.id).toMatch(/^agent_[0-9a-f]{8}$/);
    expect(results(callsOf(r.host, MAIN)[1])).toEqual([{ type: "tool_result", toolUseId: "d1", content: answered("Nobody in the chat says who keeps it.", sub?.id ?? "") }]);
    expect(result).toMatchObject({ status: "done", reply: "The door opens a hand's width." });
    // The main agent's two calls and the sub-agent's two, all counted as the turn's.
    expect(r.host.calls).toHaveLength(4);
    expect(result.usage).toMatchObject({ calls: 4, toolTurns: 2 });
  });

  test("the main agent is told whom it can delegate to: every definition but itself and the writer, each with what it is for", async () => {
    const r = rig(cast(main(["The reply."])));
    r.harness.agents.register(scout());
    await r.turn();
    const offered = r.host.calls[0]?.tools?.find((tool) => tool.name === "delegate");
    // Everything registered but the two a task can't go to, in the order registered: the core's own workers, then the one registered beside them.
    const workers = r.harness.agents.all().filter((d) => d.id !== "main" && d.id !== "writer");
    expect(workers.map((d) => d.id).slice(0, 1)).toEqual(["summarizer"]);
    expect(workers.at(-1)?.id).toBe("scout");
    expect(offered?.description).toEndWith(`The agents you can delegate to:\n${workers.map((d) => `- ${d.id}: ${d.name}. ${d.description}`).join("\n")}`);
    expect(offered?.description).toContain("\n- summarizer: Summarizer. Summarizes what it is asked to: a span of the chat, lore entries, workspace files, or a text given in its task. It reads them itself and answers with the summary.\n");
    expect(offered?.description).toEndWith("\n- scout: Scout. Finds what a task names.");
    expect(offered?.parameters).toMatchObject({ properties: { agent: { enum: workers.map((d) => d.id) } }, required: ["agent", "task"] });
  });

  test("a task can't be handed to the writer, the main agent or an agent there isn't: the result names the ones there are, and nobody is started", async () => {
    const r = rig(cast(main([{ toolCalls: [delegate("Write the reply.", "d1", { agent: "writer" }), delegate("Plan the reply.", "d2", { agent: "main" }), delegate("Look around.", "d3", { agent: "lookout" })] }, "The reply."])));
    await r.turn();
    const workers = r.harness.agents.all().flatMap((d) => (d.id === "main" || d.id === "writer" ? [] : [d.id])).join(", ");
    expect(workers).toStartWith("summarizer");
    expect(results(r.host.calls[1])).toEqual([
      { type: "tool_result", toolUseId: "d1", content: `There's no agent writer to delegate to. You can delegate to: ${workers}.`, isError: true },
      { type: "tool_result", toolUseId: "d2", content: `There's no agent main to delegate to. You can delegate to: ${workers}.`, isError: true },
      { type: "tool_result", toolUseId: "d3", content: `There's no agent lookout to delegate to. You can delegate to: ${workers}.`, isError: true },
    ]);
    expect(events(r.host).flatMap((e) => (e.kind === "agent_started" ? [e.agent.role] : []))).toEqual(["main"]);
  });
});

// ---------------------------------------------------------------- the files given with a task

describe("the files given with a task", () => {
  /** A rig whose workspace holds two files, written as the user. */
  async function filed(change: (s: Settings) => void, files: string[] | string) {
    const r = rig(cast(main([{ toolCalls: [delegate("Summarize the plan.", "d1", { files })] }, "The reply."]), agent(SUMMARIZER, ["Light the lamp; Brann has the key."])), change);
    await r.harness.workspace.write({ chatId: CHAT, area: "chat", path: "notes/plan.md", text: PLAN, base: null });
    await r.harness.workspace.write({ chatId: CHAT, area: "learned", path: "brann.md", text: BRANN, base: null });
    await r.turn();
    return r;
  }
  const whole = async (path: string, text: string): Promise<string> => `[${path}: ${text.length} characters, version ${await version(text)}]\n${text}`;
  const named = (path: string, text: string): string => `[${path}: ${text.length} characters, not included here: past the room Files given with a task (Settings → Delegation) leaves. workspace_read reads it.]`;

  test("are in the sub-agent's first message, whole, each under its path, its length and its version", async () => {
    const r = await filed(() => undefined, ["/notes/plan.md", "learned/brann.md"]);
    expect(told(callsOf(r.host, SUMMARIZER)[0])).toBe(`Summarize the plan.\n\nFiles given with this task:\n\n${await whole("/notes/plan.md", PLAN)}\n\n${await whole("learned/brann.md", BRANN)}${rounds(12)}`);
  });

  test("a path written alone is taken as a list of one", async () => {
    const r = await filed(() => undefined, "notes/plan.md");
    expect(told(callsOf(r.host, SUMMARIZER)[0])).toBe(`Summarize the plan.\n\nFiles given with this task:\n\n${await whole("/notes/plan.md", PLAN)}${rounds(12)}`);
  });

  test("are whole while Files given with a task gives room, and one that doesn't fit is named with its length", async () => {
    // Room for the plan to the character, and none left for the second file.
    const exact = await filed((s) => (s.delegation.fileChars = PLAN.length), ["/notes/plan.md", "learned/brann.md"]);
    expect(told(callsOf(exact.host, SUMMARIZER)[0])).toBe(`Summarize the plan.\n\nFiles given with this task:\n\n${await whole("/notes/plan.md", PLAN)}\n\n${named("learned/brann.md", BRANN)}${rounds(12)}`);
    // One character short of the plan: it is named, and the room it didn't take is the next file's.
    const short = await filed((s) => (s.delegation.fileChars = PLAN.length - 1), ["/notes/plan.md", "learned/brann.md"]);
    expect(told(callsOf(short.host, SUMMARIZER)[0])).toBe(`Summarize the plan.\n\nFiles given with this task:\n\n${named("/notes/plan.md", PLAN)}\n\n${await whole("learned/brann.md", BRANN)}${rounds(12)}`);
    // The sub-agent reads a named file itself: its tools reach the same workspace.
    expect(toolsOf(callsOf(short.host, SUMMARIZER)[0])).toContain("workspace_read");
  });

  test("a file that isn't there is an error result that says so, and no agent is started", async () => {
    const r = await filed(() => undefined, ["/notes/plan.md", "/notes/nobody.md"]);
    expect(results(r.host.calls[1])).toEqual([{ type: "tool_result", toolUseId: "d1", content: "Not started: there's no workspace file /notes/nobody.md. workspace_list shows what there is. Call delegate again with the right path, or without it.", isError: true }]);
    expect(started(r.host, "summarizer")).toEqual([]);
    expect(r.host.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- several at once

describe("several delegate calls in one answer", () => {
  const DAYS = ["first", "second", "third"] as const;

  /** A turn whose main agent delegates three tasks in one answer; each sub-agent's call stays under way until the test lets it go. */
  function three(change: (s: Settings) => void) {
    const atWork: string[] = [];
    const done: string[] = [];
    const gates = new Map<string, PromiseWithResolvers<void>>();
    const gate = (day: string): PromiseWithResolvers<void> => {
      const made = gates.get(day) ?? Promise.withResolvers<void>();
      gates.set(day, made);
      return made;
    };
    const r = rig(
      cast(
        main([{ toolCalls: DAYS.map((day, i) => delegate(`Read the ${day} day.`, `d${i + 1}`)) }, "The reply."]),
        agent(SUMMARIZER, async (request) => {
          const day = DAYS.find((d) => told(request).includes(d)) ?? "";
          atWork.push(day);
          await gate(day).promise;
          atWork.splice(atWork.indexOf(day), 1);
          done.push(day);
          return `Read: the ${day} day.`;
        }),
      ),
      change,
    );
    return { ...r, atWork, done, release: (day: string) => gate(day).resolve() };
  }

  test("run at once", async () => {
    const r = three(() => undefined);
    const running = r.turn();
    await until(() => r.atWork.length === 3);
    for (const day of DAYS) r.release(day);
    expect((await running).result.status).toBe("done");
  });

  test("run no more than Sub-agents at once at a time: one past it waits its turn, all answer, and the results come back in the calls' order", async () => {
    const r = three((s) => (s.delegation.atOnce = 2));
    const running = r.turn();
    await until(() => r.atWork.length === 2);
    // Given every chance to start, the third hasn't: nothing was sent to a model for it.
    await idle();
    expect(r.atWork).toHaveLength(2);
    expect(callsOf(r.host, SUMMARIZER)).toHaveLength(2);
    // The one that started last ends first, so the order they end in isn't the order they were called in.
    const [, last = ""] = r.atWork;
    r.release(last);
    await until(() => r.done.length === 1 && r.atWork.length === 2);
    expect(callsOf(r.host, SUMMARIZER)).toHaveLength(3);
    // The one that waited is the later of the two at work now: it ends next, and the one that started first ends last.
    const [, waited = ""] = r.atWork;
    r.release(waited);
    await until(() => r.done.length === 2);
    for (const day of DAYS) r.release(day);
    const { result } = await running;
    expect(result.status).toBe("done");
    expect(r.done).not.toEqual([...DAYS]);
    const handles = started(r.host, "summarizer");
    expect(handles).toHaveLength(3);
    expect(results(callsOf(r.host, MAIN)[1])).toEqual(DAYS.map((day, i) => ({ type: "tool_result", toolUseId: `d${i + 1}`, content: answered(`Read: the ${day} day.`, handles.find((a) => a.task === `Read the ${day} day.`)?.id ?? "") })));
  });
});

// ---------------------------------------------------------------- the handle

describe("a sub-agent's handle", () => {
  test("agent_message continues that agent with everything it had read: its request holds its earlier conversation", async () => {
    const r = rig(
      cast(
        main([{ toolCalls: [delegate("Say who keeps the lighthouse, from the chat.", "d1")] }, follow("And who knocks?", "m1"), "The reply."]),
        agent(SUMMARIZER, [{ toolCalls: [call("chat_search", { query: "lighthouse" }, "s1")] }, "Nobody in the chat says who keeps it.", "Mara knocks."]),
      ),
    );
    await r.turn();
    const [, second, third] = callsOf(r.host, SUMMARIZER);
    // What it was sent, what it called and what came back, then its answer, then the follow-up.
    expect(second?.messages).toHaveLength(4);
    expect(third?.messages).toEqual([...(second?.messages ?? []), { role: "assistant", content: "Nobody in the chat says who keeps it." }, { role: "user", content: "And who knocks?" }]);
    // One agent did both: the follow-up started nobody new, and its answer names the same handle.
    const subs = started(r.host, "summarizer");
    expect(subs).toHaveLength(1);
    expect(results(callsOf(r.host, MAIN)[2])).toEqual([{ type: "tool_result", toolUseId: "m1", content: answered("Mara knocks.", subs[0]?.id ?? "") }]);
  });

  test("continues it no more often than its definition's Revisions: past them the result says why, and the agent isn't called", async () => {
    const r = rig(cast(main([{ toolCalls: [delegate("Say who keeps the lighthouse.", "d1")] }, follow("Say more.", "m1"), follow("Say more.", "m2"), "The reply."]), agent(SUMMARIZER, ["Okoro keeps it.", "He has kept it for years."])));
    await r.turn();
    const [sub] = started(r.host, "summarizer");
    const calls = callsOf(r.host, MAIN);
    // The summarizer may be sent one message after its first answer.
    expect(results(calls[2])).toEqual([{ type: "tool_result", toolUseId: "m1", content: answered("He has kept it for years.", sub?.id ?? "") }]);
    expect(results(calls[3])).toEqual([{ type: "tool_result", toolUseId: "m2", content: stopped(sub?.id ?? "", "it has had the 1 revision it may have after its first answer, all that Revisions (Settings → Agents → Summarizer → Budget) allows."), isError: true }]);
    expect(callsOf(r.host, SUMMARIZER)).toHaveLength(2);
  });

  test("the cap is the one Settings give its definition", async () => {
    const r = rig(cast(main([{ toolCalls: [delegate("Say who keeps the lighthouse.", "d1")] }, follow("Say more.", "m1"), "The reply."]), agent(SUMMARIZER, ["Okoro keeps it."])), (s) => (s.agents.summarizer!.budget.revisions = 0));
    await r.turn();
    expect(results(callsOf(r.host, MAIN)[2])[0]).toMatchObject({ isError: true, content: stopped(started(r.host, "summarizer")[0]?.id ?? "", "it has had the 0 revisions it may have after its first answer, all that Revisions (Settings → Agents → Summarizer → Budget) allows.") });
    expect(callsOf(r.host, SUMMARIZER)).toHaveLength(1);
  });

  test("survives a long answer: the line that names it comes before the answer, so a result clipped for its length keeps it, and agent_message goes on with it", async () => {
    const long = `Okoro keeps it. ${"The keeper's log runs on, night after night, in a cramped hand. ".repeat(40)}`;
    const r = rig(
      cast(
        main([{ toolCalls: [delegate("Say who keeps the lighthouse.", "d1")] }, (request) => ({ toolCalls: [call("agent_message", { handle: handleIn(results(request)[0]?.content), text: "And who holds the key?" }, "m1")] }), "The reply."]),
        agent(SUMMARIZER, [long, "Brann holds it."]),
      ),
      (s) => (s.loop.clipChars = 400),
    );
    await r.turn();
    const [sub] = started(r.host, "summarizer");
    const read = results(callsOf(r.host, MAIN)[1])[0]?.content ?? "";
    // What the main agent read of the answer was clipped, and names the handle all the same.
    expect(read.length).toBeLessThan(long.length);
    expect(read).not.toContain(long);
    expect(handleIn(read)).toBe(sub?.id ?? "none");
    // The follow-up went to that agent: nobody new was started.
    expect(started(r.host, "summarizer")).toHaveLength(1);
    expect(results(callsOf(r.host, MAIN)[2])).toEqual([{ type: "tool_result", toolUseId: "m1", content: answered("Brann holds it.", sub?.id ?? "") }]);
  });

  test("an unknown handle names the ones there are; with nobody started, the result says to delegate first", async () => {
    const r = rig(
      cast(
        main([
          { toolCalls: [call("agent_message", { handle: "agent_00000000", text: "Are you there?" }, "m0")] },
          { toolCalls: [delegate("Read the first day.", "d1"), delegate("Read the second day.", "d2")] },
          { toolCalls: [call("agent_message", { handle: "agent_00000000", text: "Are you there?" }, "m1")] },
          "The reply.",
        ]),
        agent(SUMMARIZER, () => "Read."),
      ),
    );
    await r.turn();
    const calls = callsOf(r.host, MAIN);
    expect(results(calls[1])).toEqual([{ type: "tool_result", toolUseId: "m0", content: "You haven't delegated to anyone this turn, so there is nobody to message. delegate starts an agent.", isError: true }]);
    const handles = started(r.host, "summarizer").map((a) => a.id);
    expect(handles).toHaveLength(2);
    expect(results(calls[3])).toEqual([{ type: "tool_result", toolUseId: "m1", content: `There's no agent with the handle agent_00000000 among those you started this turn. Your handles: ${handles.join(", ")}.`, isError: true }]);
  });

  test("is its starter's alone: another agent's agent_message with it is refused, and the agent it names isn't called", async () => {
    // What the scout sends the handle its task names: the main agent's sub-agent, which isn't the scout's to message.
    const ask = (id: string) => (request: ModelRequest): Answer => ({ toolCalls: [call("agent_message", { handle: /Ask (agent_[0-9a-f]{8})/.exec(told(request))?.[1] ?? "", text: "Who holds the key?" }, id)] });
    const r = rig(
      cast(
        main([
          { toolCalls: [delegate("Say who keeps the lighthouse.", "d1")] },
          (request) => ({ toolCalls: [delegate(`Ask ${handleIn(promptText(request))} who holds the key.`, "d2", { agent: "scout" })] }),
          // The scout's answer names the agent it started itself: the main agent tries that handle, not the one its result is headed with.
          (request) => ({ toolCalls: [call("agent_message", { handle: /I asked handle (agent_[0-9a-f]{8})/.exec(results(request)[0]?.content ?? "")?.[1] ?? "", text: "Who holds the key?" }, "m3")] }),
          "The reply.",
        ]),
        agent(SCOUT, [ask("m1"), { toolCalls: [delegate("Say who holds the key.", "d3")] }, ask("m2"), (request) => `It wouldn't hear me. I asked handle ${handleIn(promptText(request))} instead.`]),
        agent(SUMMARIZER, ["Okoro keeps it."], "Say who keeps the lighthouse."),
        agent(SUMMARIZER, ["Brann holds it."], "Say who holds the key."),
      ),
      // Deep enough for the scout to delegate, so it holds agent_message too.
      (s) => (s.delegation.depth = 2),
    );
    r.harness.agents.register(scout({ tools: DELEGATING }));
    const { result } = await r.turn();
    expect(result.status).toBe("done");
    const [mainAgent] = started(r.host, "main");
    const [theScout] = started(r.host, "scout");
    const ofMain = started(r.host, "summarizer").find((a) => a.parent === mainAgent?.id);
    const ofScout = started(r.host, "summarizer").find((a) => a.parent === theScout?.id);
    expect([ofMain?.task, ofScout?.task]).toEqual(["Say who keeps the lighthouse.", "Say who holds the key."]);
    const asked = callsOf(r.host, SCOUT);
    // The scout has started nobody yet, then one of its own: the main agent's sub-agent is never among its handles.
    expect(results(asked[1])).toEqual([{ type: "tool_result", toolUseId: "m1", content: "You haven't delegated to anyone this turn, so there is nobody to message. delegate starts an agent.", isError: true }]);
    expect(results(asked[3])).toEqual([{ type: "tool_result", toolUseId: "m2", content: `There's no agent with the handle ${ofMain?.id} among those you started this turn. Your handles: ${ofScout?.id}.`, isError: true }]);
    // And the other way round: what the scout started isn't the main agent's to message.
    expect(results(callsOf(r.host, MAIN)[3])).toEqual([{ type: "tool_result", toolUseId: "m3", content: `There's no agent with the handle ${ofScout?.id} among those you started this turn. Your handles: ${ofMain?.id}, ${theScout?.id}.`, isError: true }]);
    // Each summarizer answered its task and was sent nothing more.
    expect(callsOf(r.host, SUMMARIZER)).toHaveLength(2);
  });

  test("is gone when the turn ends: the next turn's agent_message with it is refused", async () => {
    let handle = "";
    const r = rig(cast(main([{ toolCalls: [delegate("Say who keeps the lighthouse.", "d1")] }, "The door opens.", () => ({ toolCalls: [call("agent_message", { handle, text: "And who holds the key?" }, "m1")] }), "Nobody answers."]), agent(SUMMARIZER, ["Okoro keeps it."])));
    await r.turn();
    handle = started(r.host, "summarizer")[0]?.id ?? "";
    expect(handle).not.toBe("");
    r.host.say(CHAT, "user", "I knock again.");
    const { result } = await r.turn();
    expect(result).toMatchObject({ status: "done", reply: "Nobody answers." });
    expect(results(r.host.calls.at(-1))).toEqual([{ type: "tool_result", toolUseId: "m1", content: "You haven't delegated to anyone this turn, so there is nobody to message. delegate starts an agent.", isError: true }]);
    expect(callsOf(r.host, SUMMARIZER)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- depth

describe("Depth", () => {
  test("at 1, only the main agent delegates: a sub-agent isn't offered delegate, whatever its definition names", async () => {
    const r = rig(cast(main([{ toolCalls: [delegate("Find the lighthouse.", "d1", { agent: "scout" })] }, "The reply."]), agent(SCOUT, ["It is on the point."])), (s) => (s.delegation.depth = 1));
    r.harness.agents.register(scout({ tools: DELEGATING }));
    await r.turn();
    expect(toolsOf(callsOf(r.host, MAIN)[0])).toEqual(expect.arrayContaining(["delegate", "agent_message"]));
    const offered = toolsOf(callsOf(r.host, SCOUT)[0]);
    expect(offered).toContain("chat_search");
    expect(offered).not.toContain("delegate");
    expect(offered).not.toContain("agent_message");
  });

  test("at 2, the default, a sub-agent delegates too, and the agent it starts doesn't", async () => {
    const r = rig(
      cast(
        main([{ toolCalls: [delegate("Find the lighthouse.", "d1", { agent: "scout" })] }, "The reply."]),
        agent(SCOUT, [{ toolCalls: [delegate("Say what the chat says of the lighthouse.", "d2")] }, "It is on the point."]),
        agent(SUMMARIZER, ["The chat says little."]),
      ),
      (s) => {
        expect(s.delegation.depth).toBe(2);
        // The summarizer's definition names delegate as well: only the depth keeps it from it.
        s.agents.summarizer!.tools.push("delegate", "agent_message");
      },
    );
    r.harness.agents.register(scout({ tools: DELEGATING }));
    const { result } = await r.turn();
    expect(result.status).toBe("done");
    expect(toolsOf(callsOf(r.host, SCOUT)[0])).toEqual(expect.arrayContaining(["delegate", "agent_message"]));
    const deepest = toolsOf(callsOf(r.host, SUMMARIZER)[0]);
    expect(deepest).toContain("chat_search");
    expect(deepest).not.toContain("delegate");
    expect(deepest).not.toContain("agent_message");
    // Each is in the trace under the agent that started it.
    const [mainAgent] = started(r.host, "main");
    const [theScout] = started(r.host, "scout");
    expect(theScout?.parent).toBe(mainAgent?.id);
    expect(started(r.host, "summarizer")[0]?.parent).toBe(theScout?.id);
    expect(results(callsOf(r.host, SCOUT)[1])[0]?.content).toBe(answered("The chat says little.", started(r.host, "summarizer")[0]?.id ?? ""));
  });

  test("at 0, nobody delegates: the main agent isn't offered delegate", async () => {
    const r = rig(cast(main(["The reply."])), (s) => (s.delegation.depth = 0));
    await r.turn();
    const offered = toolsOf(r.host.calls[0]);
    expect(offered).toContain("workspace_read");
    expect(offered).not.toContain("delegate");
    expect(offered).not.toContain("agent_message");
  });
});

// ---------------------------------------------------------------- what a sub-agent may be given

describe("a sub-agent's tools", () => {
  /** A turn in which the main agent, which Settings took chat_grep from, delegates to the summarizer, whose definition names it. */
  async function granted(grant: Settings["delegation"]["grant"]) {
    const r = rig(cast(main([{ toolCalls: [delegate("Find the lighthouse.", "d1")] }, "The reply."]), agent(SUMMARIZER, ["It is on the point."])), (s) => {
      s.agents.main!.tools = s.agents.main!.tools.filter((name) => name !== "chat_grep");
      s.delegation.grant = grant;
    });
    await r.turn();
    return r;
  }

  test("are its definition's, less whatever the agent that started it doesn't hold", async () => {
    const r = await granted("own");
    expect(toolsOf(callsOf(r.host, MAIN)[0])).not.toContain("chat_grep");
    expect(toolsOf(callsOf(r.host, SUMMARIZER)[0])).toEqual(["chat_search", "chat_read", "lore_search", "lore_read", "workspace_list", "workspace_read", "workspace_grep", "scratch_read"]);
  });

  test("are its definition's whole once Settings say so", async () => {
    const r = await granted("definition");
    expect(toolsOf(callsOf(r.host, MAIN)[0])).not.toContain("chat_grep");
    expect(toolsOf(callsOf(r.host, SUMMARIZER)[0])).toEqual(["chat_search", "chat_grep", "chat_read", "lore_search", "lore_read", "workspace_list", "workspace_read", "workspace_grep", "scratch_read"]);
  });

  test("are never more than its definition's: what the main agent holds beside them isn't passed on", async () => {
    const r = await granted("own");
    const offered = toolsOf(callsOf(r.host, SUMMARIZER)[0]);
    for (const name of ["workspace_write", "lore_index", "job_start", "delegate"]) {
      expect(toolsOf(callsOf(r.host, MAIN)[0])).toContain(name);
      expect(offered).not.toContain(name);
    }
  });

  /** The scout's trade is two tools the main agent is given neither of here: what the scout was offered when the main agent hands it a task. */
  const TRADE = ["chat_grep", "chat_read"];
  async function scouting(definition: Partial<AgentDefinition>, change: (s: Settings) => void = () => undefined, stored?: StoredDefinitions) {
    const r = rig(cast(main([{ toolCalls: [delegate("Find the lighthouse.", "d1", { agent: "scout" })] }, "The reply."]), agent(SCOUT, ["It is on the point."])), (s) => {
      s.agents.main!.tools = s.agents.main!.tools.filter((name) => !TRADE.includes(name));
      change(s);
    });
    r.harness.agents.register(scout({ tools: TRADE, ...definition }));
    if (stored) r.stored.definitions = stored;
    await r.turn();
    expect(toolsOf(callsOf(r.host, MAIN)[0]).filter((name) => TRADE.includes(name))).toEqual([]);
    return toolsOf(callsOf(r.host, SCOUT)[0]);
  }

  test("a definition that keeps its own tools whoever starts it is given them by an agent that holds none of them, whatever Settings say", async () => {
    expect(defaultSettings().delegation.grant).toBe("own");
    expect(await scouting({ grant: "definition" })).toEqual([...TRADE, "scratch_read"]);
    // Never more than its definition names: nothing of the main agent's comes with them.
    expect(await scouting({ grant: "definition", tools: ["chat_grep"] })).toEqual(["chat_grep", "scratch_read"]);
  });

  test("a definition that says nothing leaves it to Settings, and one that says own keeps to its starter's tools though Settings give a sub-agent its definition's", async () => {
    expect(await scouting({})).toEqual([]);
    expect(await scouting({}, (s) => (s.delegation.grant = "definition"))).toEqual([...TRADE, "scratch_read"]);
    expect(await scouting({ grant: "own" }, (s) => (s.delegation.grant = "definition"))).toEqual([]);
  });

  test("the user's own definition of that id decides in its place: it may take the grant away, or give one", async () => {
    // The registered scout keeps its tools; the user's, which stands over it, says nothing, so Settings rule again.
    expect(await scouting({ grant: "definition" }, undefined, { agents: { scout: scout({ tools: TRADE }) } })).toEqual([]);
    expect(await scouting({}, undefined, { agents: { scout: scout({ tools: TRADE, grant: "definition" }) } })).toEqual([...TRADE, "scratch_read"]);
  });

  test("the check of a definition takes own, definition or nothing, keeps what it took, and refuses anything else in words", () => {
    const names = [...TRADE];
    expect(checkAgent(scout({ tools: TRADE, grant: "definition" }), names).agent?.grant).toBe("definition");
    expect(checkAgent(scout({ tools: TRADE, grant: "own" }), names).agent?.grant).toBe("own");
    const plain = checkAgent(scout({ tools: TRADE }), names).agent;
    expect(plain !== null && "grant" in plain).toBe(false);
    const wrong = checkAgent({ ...scout({ tools: TRADE }), grant: "everything" }, names);
    expect(wrong.agent).toBeNull();
    expect(wrong.problems).toEqual([{ path: ["grant"], message: "It must say own (no tool the agent that starts it doesn't hold) or definition (its own tools, whoever starts it), or be left out for Settings to decide." }]);
  });
});

// ---------------------------------------------------------------- a sub-agent's writes

describe("a sub-agent's writes", () => {
  test("are its own versioned writes: the file is recorded as written by it, and the main agent's write based on the old version is refused with the version there is", async () => {
    const first = "Light the lamp.";
    const second = "Light the lamp. Brann holds the key.";
    const [v1, v2] = [await version(first), await version(second)];
    const r = rig(
      cast(
        main([
          { toolCalls: [call("workspace_write", { path: "/notes/plan.md", content: first, base: "new" }, "w1")] },
          { toolCalls: [delegate("Add who holds the key to the plan.", "d1", { files: ["/notes/plan.md"] })] },
          { toolCalls: [call("workspace_write", { path: "/notes/plan.md", content: "Light the lamp. Mara holds the key.", base: v1 }, "w2")] },
          "The reply.",
        ]),
        agent(SUMMARIZER, [{ toolCalls: [call("workspace_write", { path: "/notes/plan.md", content: second, base: v1 }, "w3")] }, "Added."]),
      ),
      // The main agent holds workspace_write, so it may be given on.
      (s) => s.agents.summarizer!.tools.push("workspace_write"),
    );
    await r.turn();
    const [mainAgent] = started(r.host, "main");
    const [sub] = started(r.host, "summarizer");
    // The sub-agent's write was taken on the version it was given with its task.
    expect(told(callsOf(r.host, SUMMARIZER)[0])).toContain(`[/notes/plan.md: ${first.length} characters, version ${v1}]\n${first}`);
    expect(results(callsOf(r.host, SUMMARIZER)[1])).toEqual([{ type: "tool_result", toolUseId: "w3", content: `Wrote /notes/plan.md: ${second.length} characters, now at version ${v2}. Your next change to it takes that version as base.` }]);
    expect(results(callsOf(r.host, MAIN)[3])).toEqual([
      { type: "tool_result", toolUseId: "w2", content: `Nothing was changed: /notes/plan.md is at version ${v2} now, and that isn't the version you gave as base: it was changed since you read it, or the base was miscopied. Read it again with workspace_read and make your change on what it holds now.`, isError: true },
    ]);
    // The file stands as the sub-agent left it, under its name; the version before it is the main agent's.
    const read = await r.harness.workspace.read({ chatId: CHAT, area: "chat", path: "notes/plan.md" });
    expect(read.text).toBe(second);
    expect(read.file.by).toEqual({ who: "agent", id: sub?.id ?? "", role: "summarizer" });
    const { versions } = await r.harness.workspace.history({ chatId: CHAT, area: "chat", path: "notes/plan.md" });
    expect(versions.map((v) => v.by)).toEqual([
      { who: "agent", id: sub?.id ?? "", role: "summarizer" },
      { who: "agent", id: mainAgent?.id ?? "", role: "main" },
    ]);
  });
});

// ---------------------------------------------------------------- how many a turn starts

describe("Sub-agents per turn", () => {
  /** The refusal, with the limit as the answer writes it: the count and its noun, in the number the count takes. */
  const refusal = (limit: string): string => `Not started: this turn has started the ${limit} Sub-agents per turn (Settings → Delegation) allows. Ask one you already have with agent_message, or do it yourself.`;

  test("one past it is refused in words that name the setting, and what it already started can still be asked more", async () => {
    const r = rig(
      cast(
        main([
          { toolCalls: [delegate("Read the first day.", "d1")] },
          { toolCalls: [delegate("Read the second day.", "d2")] },
          { toolCalls: [delegate("Read the third day.", "d3")] },
          follow("Read it again.", "m1"),
          "The reply.",
        ]),
        agent(SUMMARIZER, () => "Read."),
      ),
      (s) => (s.delegation.perRun = 2),
    );
    await r.turn();
    const calls = callsOf(r.host, MAIN);
    expect(results(calls[2])[0]).not.toHaveProperty("isError");
    expect(results(calls[3])).toEqual([{ type: "tool_result", toolUseId: "d3", content: refusal("2 sub-agents"), isError: true }]);
    expect(results(calls[4])[0]).toMatchObject({ toolUseId: "m1", content: answered("Read.", started(r.host, "summarizer")[0]?.id ?? "") });
    expect(started(r.host, "summarizer")).toHaveLength(2);
  });

  test("holds for the calls of one answer, which run at once: of three, two start and the third is refused", async () => {
    const r = rig(cast(main([{ toolCalls: [delegate("Read the first day.", "d1"), delegate("Read the second day.", "d2"), delegate("Read the third day.", "d3")] }, "The reply."]), agent(SUMMARIZER, () => "Read.")), (s) => (s.delegation.perRun = 2));
    await r.turn();
    const subs = started(r.host, "summarizer");
    expect(subs.map((a) => a.task)).toEqual(["Read the first day.", "Read the second day."]);
    expect(callsOf(r.host, SUMMARIZER)).toHaveLength(2);
    expect(results(callsOf(r.host, MAIN)[1])).toEqual([
      { type: "tool_result", toolUseId: "d1", content: answered("Read.", subs[0]?.id ?? "") },
      { type: "tool_result", toolUseId: "d2", content: answered("Read.", subs[1]?.id ?? "") },
      { type: "tool_result", toolUseId: "d3", content: refusal("2 sub-agents"), isError: true },
    ]);
  });

  test("counts the agents started, not the calls: one refused for a file that isn't there leaves its place for the next", async () => {
    const r = rig(cast(main([{ toolCalls: [delegate("Read the plan.", "d1", { files: ["/notes/nobody.md"] }), delegate("Read the first day.", "d2")] }, { toolCalls: [delegate("Read the second day.", "d3")] }, "The reply."]), agent(SUMMARIZER, () => "Read.")), (s) => (s.delegation.perRun = 1));
    await r.turn();
    const calls = callsOf(r.host, MAIN);
    expect(results(calls[1]).map((part) => [part.toolUseId, part.isError === true])).toEqual([["d1", true], ["d2", false]]);
    expect(results(calls[1])[0]?.content).toStartWith("Not started: there's no workspace file /notes/nobody.md.");
    expect(results(calls[2])).toEqual([{ type: "tool_result", toolUseId: "d3", content: refusal("1 sub-agent"), isError: true }]);
    expect(started(r.host, "summarizer").map((a) => a.task)).toEqual(["Read the first day."]);
  });

  test("at a limit of 1 the refusal counts one sub-agent, not several, and the noun is a text the user can replace", async () => {
    const script = (): Script => cast(main([{ toolCalls: [delegate("Read the first day.", "d1"), delegate("Read the second day.", "d2")] }, "The reply."]), agent(SUMMARIZER, () => "Read."));
    const one = rig(script(), (s) => (s.delegation.perRun = 1));
    await one.turn();
    expect(results(callsOf(one.host, MAIN)[1])[1]).toEqual({ type: "tool_result", toolUseId: "d2", content: refusal("1 sub-agent"), isError: true });

    const worded = rig(script(), (s) => (s.delegation.perRun = 1));
    worded.stored.texts["word.sub_agent"] = "helper|helpers";
    await worded.turn();
    expect(results(callsOf(worded.host, MAIN)[1])[1]?.content).toStartWith("Not started: this turn has started the 1 helper Sub-agents per turn (Settings → Delegation) allows.");
  });

  test("with no limit a turn starts as many as it asks for", async () => {
    const r = rig(cast(main([{ toolCalls: Array.from({ length: 14 }, (_, i) => delegate(`Read day ${i + 1}.`, `d${i + 1}`)) }, "The reply."]), agent(SUMMARIZER, () => "Read.")), (s) => {
      s.delegation.perRun = null;
      // Every call of the answer is run.
      s.agents.main!.budget.concurrency = 14;
    });
    await r.turn();
    expect(started(r.host, "summarizer")).toHaveLength(14);
    expect(results(callsOf(r.host, MAIN)[1]).some((part) => part.isError)).toBe(false);
  });
});

// ---------------------------------------------------------------- the trace

describe("a sub-agent's session", () => {
  const script = (): Script =>
    cast(
      main([{ toolCalls: [delegate("Say who keeps the lighthouse, from the chat.", "d1")] }, "The door opens a hand's width."]),
      agent(SUMMARIZER, [{ content: "First the chat.", toolCalls: [call("chat_search", { query: "lighthouse" }, "s1")] }, "Nobody in the chat says who keeps it."]),
    );

  test("is in the trace under the agent that started it, with what it was started for, and its steps are events of the same turn", async () => {
    const r = rig(script());
    const { request } = await r.turn();
    const [mainAgent] = started(r.host, "main");
    const [sub] = started(r.host, "summarizer");
    expect(mainAgent?.parent).toBeUndefined();
    expect(sub).toMatchObject({ role: "summarizer", parent: mainAgent?.id, task: "Say who keeps the lighthouse, from the chat.", system: SUMMARIZER, history: 0 });
    // One trace: every record is the turn's, numbered with no gap.
    expect(r.host.traced.every((record) => record.turn === request.generationId && record.chatId === CHAT)).toBe(true);
    expect(r.host.traced.map((record) => record.seq)).toEqual(r.host.traced.map((_, i) => i + 1));
    const steps = events(r.host).flatMap((e) => (e.kind === "agent_entry" && e.agentId === sub?.id ? [e.entry] : []));
    expect(steps.map((entry) => entry.kind)).toEqual(["message", "answer", "result", "answer"]);
    expect(steps[0]).toMatchObject({ text: `Say who keeps the lighthouse, from the chat.${rounds(12)}` });
    expect(steps[1]).toMatchObject({ text: "First the chat.", calls: [{ id: "s1", name: "chat_search", args: { query: "lighthouse" } }] });
    expect(steps[3]).toMatchObject({ text: "Nobody in the chat says who keeps it.", calls: [] });
    // Its work lies between the main agent's call and that call's result.
    const all = events(r.host);
    const called = all.findIndex((e) => e.kind === "agent_entry" && e.agentId === mainAgent?.id && e.entry.kind === "answer" && e.entry.calls.some((c) => c.id === "d1"));
    const came = all.findIndex((e) => e.kind === "agent_entry" && e.agentId === mainAgent?.id && e.entry.kind === "result" && e.entry.callId === "d1");
    const subAt = all.flatMap((e, i) => ((e.kind === "agent_started" && e.agent.id === sub?.id) || ((e.kind === "agent_entry" || e.kind === "usage" || e.kind === "agent_idle") && e.agentId === sub?.id) ? [i] : []));
    expect(subAt.length).toBeGreaterThanOrEqual(8);
    expect(called).toBeGreaterThan(0);
    expect(Math.min(...subAt)).toBeGreaterThan(called);
    expect(Math.max(...subAt)).toBeLessThan(came);
    // What it spent is told as its own, and counted in the turn's.
    expect(all.filter((e) => e.kind === "usage" && e.agentId === sub?.id)).toHaveLength(2);
    expect(all.at(-1)).toMatchObject({ kind: "turn_ended", status: "done", usage: { calls: 4 } });
  });

  test("is kept with the turn's transcript", async () => {
    const r = rig(script());
    const { result, request } = await r.turn();
    const [sub] = started(r.host, "summarizer");
    const transcript = transcriptOf(r.host.blobStore.get(result.record?.transcript ?? "") ?? "");
    expect(transcript).toMatchObject({ turn: request.generationId, chatId: CHAT, ended: { status: "done" } });
    expect(transcript?.events).toEqual(r.host.traced);
    const kept = (transcript?.events ?? []).flatMap((record) => (record.event.kind === "agent_entry" && record.event.agentId === sub?.id ? [record.event.entry.kind] : []));
    expect(kept).toEqual(["message", "answer", "result", "answer"]);
    expect((transcript?.events ?? []).some((record) => record.event.kind === "agent_started" && record.event.agent.id === sub?.id && record.event.agent.parent !== undefined)).toBe(true);
  });

  test("a long task is told in the trace by how it opens, and reaches the agent whole", async () => {
    const task = `Say who keeps the lighthouse. ${"Look at every message, however old. ".repeat(8)}`.trim();
    const r = rig(cast(main([{ toolCalls: [delegate(task, "d1")] }, "The reply."]), agent(SUMMARIZER, ["Okoro keeps it."])));
    await r.turn();
    const [sub] = started(r.host, "summarizer");
    expect(sub?.task).toBe(`${task.slice(0, 159)}…`);
    expect(told(callsOf(r.host, SUMMARIZER)[0])).toBe(`${task}${rounds(12)}`);
  });
});

// ---------------------------------------------------------------- what a definition is given

describe("what a definition is given", () => {
  test("one given the request gets the request the turn answers with its task; one given its task alone doesn't", async () => {
    const r = rig(cast(main([{ toolCalls: [delegate("Say who keeps the lighthouse.", "d1"), delegate("Find the lighthouse.", "d2", { agent: "scout" })] }, "The reply."]), agent(SUMMARIZER, ["Okoro keeps it."]), agent(SCOUT, ["It is on the point."])));
    r.harness.agents.register(scout({ given: "request" }));
    await r.turn();
    // The request as the main agent reads it: between what leads its message and what it is asked to do with it. What LumiAH notes after the messages (what of the chat the prompt holds, §24.1) is part of it.
    const sent = told(callsOf(r.host, MAIN)[0]);
    const lead = "The request, as Lumiverse assembled it for this reply (2 messages, in order):\n\n";
    const document = sent.slice(sent.indexOf(lead) + lead.length, sent.indexOf("\n\nWork out what this reply needs"));
    expect(document).toStartWith("[1] assistant · chat message #0, Joss\nThe harbour is quiet tonight.\n\n[2] user · chat message #1, Mara\nI walk down to the lighthouse and knock.");
    expect(told(callsOf(r.host, SCOUT)[0])).toBe(`Find the lighthouse.\n\nFor reference, the request this turn answers (2 messages), as Lumiverse assembled it:\n\n${document}${rounds(12)}`);
    expect(told(callsOf(r.host, SUMMARIZER)[0])).toBe(`Say who keeps the lighthouse.${rounds(12)}`);
  });
});

// ---------------------------------------------------------------- a sub-agent that stops short

describe("a sub-agent that stops short", () => {
  /** A turn whose main agent delegates once: what its next call is sent as the result. */
  async function delegated(sub: Part["says"], change: (s: Settings) => void = () => undefined) {
    const r = rig(cast(main([{ toolCalls: [delegate("Say who keeps the lighthouse.", "d1")] }, "The reply."]), agent(SUMMARIZER, sub)), change);
    const { result } = await r.turn();
    return { ...r, result, handle: started(r.host, "summarizer")[0]?.id ?? "", told: results(callsOf(r.host, MAIN)[1]) };
  }

  test("at its budget: an error result with why and what it had last written, and the main agent goes on", async () => {
    const r = await delegated([{ content: "First the chat.", toolCalls: [call("chat_search", { query: "lighthouse" }, "s1")] }, { content: "Now the lore.", toolCalls: [call("lore_search", { query: "lighthouse" }, "s2")] }], (s) => (s.agents.summarizer!.budget.toolTurns = 1));
    expect(r.told).toEqual([{ type: "tool_result", toolUseId: "d1", content: stopped(r.handle, "the agent has had its 1 round of tool calls, all that Tool rounds per agent (Settings → Agents → Summarizer → Budget) allows. It had last written: Now the lore."), isError: true }]);
    expect(r.result).toMatchObject({ status: "done", reply: "The reply." });
  });

  test("at a call that failed: an error result with the failure in its own words", async () => {
    const r = await delegated([{ content: "First the chat.", toolCalls: [call("chat_search", { query: "lighthouse" }, "s1")] }, { error: "401: the key was refused" }]);
    expect(r.told).toEqual([{ type: "tool_result", toolUseId: "d1", content: stopped(r.handle, "401: the key was refused. It had last written: First the chat."), isError: true }]);
    expect(r.result.status).toBe("done");
  });

  test("before it wrote anything: the result says why, and nothing of what it had written", async () => {
    const r = await delegated([{ error: "401: the key was refused" }]);
    expect(r.told).toEqual([{ type: "tool_result", toolUseId: "d1", content: stopped(r.handle, "401: the key was refused."), isError: true }]);
  });

  test("an answer cut at its length limit is told as stopped short, with what there is of it", async () => {
    const r = await delegated([{ content: "The lighthouse was li", finishReason: "length" }]);
    expect(r.told).toEqual([{ type: "tool_result", toolUseId: "d1", content: stopped(r.handle, "its answer was cut at its length limit, Answer per call (Settings → Agents → Summarizer → Budget), so it isn't the whole of what it meant to say. It had last written: The lighthouse was li"), isError: true }]);
  });

  test("an empty answer is no answer", async () => {
    const r = await delegated([""]);
    expect(r.told).toEqual([{ type: "tool_result", toolUseId: "d1", content: stopped(r.handle, "its model answered with nothing."), isError: true }]);
  });

  test("the turn's stop ends a sub-agent at work, and the turn ends as stopped", async () => {
    const r = rig(cast(main([{ toolCalls: [delegate("Say who keeps the lighthouse.", "d1")] }, "never reached"]), agent(SUMMARIZER, [{ hang: true }])));
    const stop = new AbortController();
    const running = r.turn({ signal: stop.signal });
    await until(() => callsOf(r.host, SUMMARIZER).length === 1);
    stop.abort();
    const { result } = await running;
    expect(result).toMatchObject({ status: "stopped", reply: "" });
    const [sub] = started(r.host, "summarizer");
    expect(events(r.host).flatMap((e) => (e.kind === "agent_entry" && e.agentId === sub?.id && e.entry.kind === "stop" ? [e.entry.status] : []))).toEqual(["cancelled"]);
    expect(r.host.calls).toHaveLength(2);
  });
});
