// Approval (DESIGN §17) through whole turns on the in-memory host: which tool calls Settings hold
// for the user's word, what the user is asked, what each of their answers does (this once, for this
// chat, no), what becomes of a call nobody answers for or nobody can be asked about, and that a
// sub-agent's and a job's calls are held the same way. The steps a held call leaves in its agent's
// transcript and what its wait does to the agent's clocks are the loop's own (loop.test.ts).

import { describe, expect, test } from "bun:test";
import { approvalOf } from "../../src/core/approval";
import { createHarness, type Harness, type StoredState } from "../../src/core/harness";
import { DOC } from "../../src/core/paths";
import type { AgentStarted, ApprovalAnswer, ApprovalAsk, ModelRequest } from "../../src/core/ports";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { type Answer, call, idle, MemoryHost, runTurn, type Script, until } from "./support/host";

const CHAT = "chat-1";
const OTHER = "chat-2";
const REPLY = "The door opens a hand's width.";
const KEY = "Brann holds the lighthouse key.";

// ---------------------------------------------------------------- a script for several agents

/** One scripted answer, or what gives it when its call is made (a promise, for a call the test answers when it will). */
type Step = Answer | ((request: ModelRequest) => Answer | Promise<Answer>);

/** Whose call a request is: a job's agent is told it is one in its first message; the writer is offered no tools; of the others only the agent a turn starts with holds write_reply. */
function caller(request: ModelRequest): "job" | "writer" | "main" | "sub" {
  if (request.messages.find((m) => m.role === "user")?.content.startsWith("You are running as a job")) return "job";
  if (!request.tools) return "writer";
  return request.tools.some((tool) => tool.name === "write_reply") ? "main" : "sub";
}

/** A script that answers each caller from its own list, in the order its calls are made, across every run of a test; the writer always writes the same reply. */
function cast(lines: { main?: Step[]; sub?: Step[]; job?: Step[] }): Script {
  const next = { main: 0, sub: 0, job: 0 };
  return (request) => {
    const who = caller(request);
    if (who === "writer") return REPLY;
    const step = lines[who]?.[next[who]++];
    if (step === undefined) throw new Error(`no answer scripted for the ${who}'s call ${next[who]}`);
    return typeof step === "function" ? step(request) : step;
  };
}

/** The main agent hands the writer its brief: the last step of a turn. */
const brief: Answer = { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "w1")] };
const write = (path: string, id: string) => call("workspace_write", { path: `learned/${path}`, content: KEY, base: "new" }, id);
const pin = (path: string, id: string) => call("workspace_pin", { path: `learned/${path}`, pinned: true }, id);

// ---------------------------------------------------------------- the rig

/** A host with two short chats, and a harness over it whose settings the test changes; `options` makes a second harness over the same host, as a restart does. */
function rig(script: Script, change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  host.script = script;
  for (const chat of [CHAT, OTHER]) {
    host.say(chat, "assistant", "The harbour is quiet tonight.");
    host.say(chat, "user", "I walk down to the lighthouse and knock.");
  }
  const stored: StoredState & { values: Settings } = { values: defaultSettings(), texts: {} };
  change(stored.values);
  const options = { settings: async () => structuredClone(stored) };
  const harness = createHarness(host, options);
  return { host, harness, stored, options, turn: (chatId = CHAT, o: Parameters<typeof runTurn>[3] = {}) => runTurn(host, harness, chatId, o) };
}

/** Write tools ask, as a user sets them to. */
const asking = (s: Settings): void => void (s.approval.tiers.write = "ask");

/**
 * The user at the host's approvals port: every ask is kept with its signal and answered as `word`
 * says; with no word (null) it waits until its signal ends it, as a card nobody answers does.
 */
function user(host: MemoryHost, word: (ask: ApprovalAsk) => ApprovalAnswer | Promise<ApprovalAnswer> | null) {
  const asks: ApprovalAsk[] = [];
  const signals: AbortSignal[] = [];
  host.approvals = {
    ask: (ask, signal) => {
      asks.push(ask);
      signals.push(signal);
      const said = word(ask);
      if (said !== null) return Promise.resolve(said);
      const { promise, reject } = Promise.withResolvers<ApprovalAnswer>();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      return promise;
    },
  };
  return { asks, signals };
}

/** What a tool call was answered with, as its model read it in the request that followed. */
function resultOf(host: MemoryHost, callId: string): { content: string; failed: boolean } | undefined {
  for (const request of host.calls) for (const message of request.messages) for (const part of message.parts ?? []) if (part.type === "tool_result" && part.toolUseId === callId) return { content: part.content, failed: part.isError === true };
  return undefined;
}

/** The files of a chat's learned/ area, by path: what the tests' writes leave when they run. */
const learned = async (harness: Harness, chatId = CHAT): Promise<string[]> => (await harness.workspace.list({ chatId, area: "learned" })).files.map((file) => file.path).sort();

/** The agents of a run that started work as `role`, in the order they started. */
const started = (host: MemoryHost, role: string, run?: string): AgentStarted[] => host.traced.flatMap((t) => (t.event.kind === "agent_started" && t.event.agent.role === role && (run === undefined || t.turn === run) ? [t.event.agent] : []));

const never = new AbortController().signal;

const NOT_ASKED = "Not run: this call of workspace_write needs the user's approval";
const GO_ON = "Go on without it, or say in your answer what you needed it for.";

// ---------------------------------------------------------------- which calls wait

describe("Settings decide for each tier, with a rule of its own for a tool", () => {
  /** One round that reads a message, searches the chat and writes a file; then the reply. */
  const round = (): Script => cast({ main: [{ toolCalls: [call("chat_read", { from: 1 }, "c1"), call("chat_search", { query: "lighthouse" }, "c2"), write("key.md", "c3")] }, brief] });

  test("as a new user has them, tools that read and tools that write run, and nobody is asked", async () => {
    const r = rig(round());
    // Whoever is asked here says no: a call that was held would not run.
    const asked = user(r.host, () => ({ decision: "refused" }));
    const { result } = await r.turn();
    expect(asked.asks).toEqual([]);
    expect(resultOf(r.host, "c1")).toMatchObject({ failed: false, content: expect.stringContaining("I walk down to the lighthouse and knock.") as unknown as string });
    expect(resultOf(r.host, "c3")?.failed).toBe(false);
    expect(await learned(r.harness)).toEqual(["key.md"]);
    expect(result).toMatchObject({ status: "done", reply: REPLY });
  });

  test("with Write tools set to ask, a workspace_write call is asked about and the calls that read are not", async () => {
    const r = rig(round(), asking);
    const asked = user(r.host, () => ({ decision: "once" }));
    await r.turn();
    expect(asked.asks.map((ask) => [ask.tool, ask.callId])).toEqual([["workspace_write", "c3"]]);
    expect([resultOf(r.host, "c1")?.failed, resultOf(r.host, "c2")?.failed, resultOf(r.host, "c3")?.failed]).toEqual([false, false, false]);
    expect(await learned(r.harness)).toEqual(["key.md"]);
  });

  test("a rule for one tool holds that tool, and no other of its tier", async () => {
    const r = rig(round(), (s) => (s.approval.tools.chat_read = "ask"));
    const asked = user(r.host, () => ({ decision: "once" }));
    await r.turn();
    expect(asked.asks.map((ask) => [ask.tool, ask.tier, ask.callId])).toEqual([["chat_read", "read", "c1"]]);
    expect([resultOf(r.host, "c1")?.failed, resultOf(r.host, "c2")?.failed, resultOf(r.host, "c3")?.failed]).toEqual([false, false, false]);
  });

  test("a tool's own rule lets it run while the rest of its tier still asks", async () => {
    const r = rig(cast({ main: [{ toolCalls: [write("key.md", "c1")] }, { toolCalls: [pin("key.md", "c2")] }, brief] }), (s) => {
      asking(s);
      s.approval.tools.workspace_write = "allow";
    });
    const asked = user(r.host, () => ({ decision: "refused" }));
    await r.turn();
    // The write ran unasked; the pin, a write tool with no rule of its own, was held and refused.
    expect(asked.asks.map((ask) => ask.tool)).toEqual(["workspace_pin"]);
    expect(resultOf(r.host, "c1")?.failed).toBe(false);
    expect(await learned(r.harness)).toEqual(["key.md"]);
    expect(resultOf(r.host, "c2")?.failed).toBe(true);
  });

  test("write_reply and scratch_read are never held by a tier's rule: with every tier asking, only the tool that reads the chat is asked about", async () => {
    const log = `Ilse copied the keeper's log out by hand: ${"the lamp was lit at dusk and trimmed at midnight; ".repeat(14)}and the last line names Mara.`;
    const r = rig(cast({ main: [{ toolCalls: [call("chat_read", { from: 2 }, "c1")] }, { toolCalls: [call("scratch_read", { handle: "s1", offset: 700 }, "c2")] }, brief] }), (s) => {
      s.approval.tiers = { read: "ask", write: "ask", external: "ask" };
      // A result this long reaches the model clipped, with the rest in scratch.
      s.loop.clipChars = 200;
    });
    r.host.say(CHAT, "user", log);
    const asked = user(r.host, () => ({ decision: "once" }));
    const { result } = await r.turn();
    expect(asked.asks.map((ask) => ask.tool)).toEqual(["chat_read"]);
    expect(resultOf(r.host, "c2")).toMatchObject({ failed: false, content: expect.stringContaining("and the last line names Mara.") as unknown as string });
    expect(result).toMatchObject({ status: "done", reply: REPLY });
  });
});

describe("approvalOf", () => {
  test("gives a tool's own rule where Settings hold one, else its tier's; a tool that names no tier reads", () => {
    const s = defaultSettings();
    // As it ships, no tier asks.
    expect(approvalOf(s, { name: "workspace_write", tier: "write" })).toBe("allow");
    expect(approvalOf(s, { name: "mcp:files:read_file", tier: "external" })).toBe("allow");
    s.approval.tiers.external = "ask";
    expect(approvalOf(s, { name: "mcp:files:read_file", tier: "external" })).toBe("ask");
    s.approval.tools = { workspace_write: "ask", "mcp:files:read_file": "allow" };
    expect(approvalOf(s, { name: "workspace_write", tier: "write" })).toBe("ask");
    expect(approvalOf(s, { name: "workspace_edit", tier: "write" })).toBe("allow");
    expect(approvalOf(s, { name: "mcp:files:read_file", tier: "external" })).toBe("allow");
    s.approval.tiers = { read: "ask", write: "allow", external: "allow" };
    expect(approvalOf(s, { name: "harbour_tides" })).toBe("ask");
    expect(approvalOf(s, { name: "harbour_tides", tier: "external" })).toBe("allow");
  });

  test("lets write_reply and scratch_read run whatever their tier's rule, and holds either one a rule names", () => {
    const s = defaultSettings();
    s.approval.tiers = { read: "ask", write: "ask", external: "ask" };
    expect(approvalOf(s, { name: "write_reply", tier: "read" })).toBe("allow");
    expect(approvalOf(s, { name: "scratch_read" })).toBe("allow");
    expect(approvalOf(s, { name: "chat_read", tier: "read" })).toBe("ask");
    s.approval.tools = { write_reply: "ask", scratch_read: "ask" };
    expect(approvalOf(s, { name: "write_reply", tier: "read" })).toBe("ask");
    expect(approvalOf(s, { name: "scratch_read" })).toBe("ask");
  });

  test("reads a tool named like something every object has by its tier, never as a rule", () => {
    const s = defaultSettings();
    s.approval.tiers.external = "ask";
    expect(approvalOf(s, { name: "constructor", tier: "external" })).toBe("ask");
    expect(approvalOf(s, { name: "toString", tier: "write" })).toBe("allow");
  });
});

// ---------------------------------------------------------------- what the user is asked, and their answers

describe("a held call", () => {
  test("is asked about with its tool, tier and arguments, the agent by id and definition, the turn, the chat, and when the wait runs out", async () => {
    const r = rig(cast({ main: [{ toolCalls: [write("key.md", "c1")] }, brief] }), asking);
    const asked = user(r.host, () => ({ decision: "once" }));
    const at = r.host.clock.now();
    const { request } = await r.turn();
    const main = started(r.host, "main")[0];
    expect(asked.asks).toEqual([{ turn: request.generationId, chatId: CHAT, agentId: main?.id ?? "", role: "main", callId: "c1", tool: "workspace_write", tier: "write", args: { path: "learned/key.md", content: KEY, base: "new" }, at, until: at + 300_000 }]);
    // The trace port is given the same, as steps of the agent that asked: the live view's card.
    const steps = r.host.traced.flatMap((t) => (t.event.kind === "agent_entry" && t.event.agentId === main?.id ? [t.event.entry] : []));
    expect(steps.flatMap((step) => (step.kind === "approval_asked" || step.kind === "approval" ? [step] : []))).toMatchObject([
      { kind: "approval_asked", callId: "c1", tool: "workspace_write", tier: "write", args: { path: "learned/key.md", content: KEY, base: "new" }, until: at + 300_000 },
      { kind: "approval", callId: "c1", decision: "once" },
    ]);
  });

  test("through the host's port, an answer that isn't exactly an approval runs nothing and keeps nothing for the chat (fails closed)", async () => {
    // What a page, a link or another process may hand back in an answer's place: none of it is anybody's word. (An answer of nothing at all is the loop's own test: here it is how a card nobody answers is played.)
    for (const junk of [{}, { decision: "Chat" }, { decision: "expired" }, { error: "the page went away" }, "chat"]) {
      const r = rig(cast({ main: [{ toolCalls: [write("key.md", "c1")] }, { toolCalls: [write("door.md", "c2")] }, brief] }), asking);
      const asked = user(r.host, () => junk as unknown as ApprovalAnswer);
      await r.turn();
      expect(await learned(r.harness)).toEqual([]);
      expect(resultOf(r.host, "c1")).toEqual({ content: `${NOT_ASKED}, and what came back was neither an approval nor a refusal, so nobody gave their word for it. ${GO_ON}`, failed: true });
      // Nothing was kept as approved for the chat: the next call of the tool is asked about again, and no approval is on record.
      expect(asked.asks.map((ask) => ask.callId)).toEqual(["c1", "c2"]);
      expect((await r.harness.approvals.kept({ chatId: CHAT })).kept).toEqual([]);
    }
  });

  test("with no bound on the wait, the ask says there is none", async () => {
    const r = rig(cast({ main: [{ toolCalls: [write("key.md", "c1")] }, brief] }), (s) => {
      asking(s);
      s.approval.waitMs = null;
    });
    const asked = user(r.host, () => ({ decision: "once" }));
    await r.turn();
    expect(asked.asks.map((ask) => ask.until)).toEqual([null]);
  });

  test("approved once, runs; the same tool's next call in the turn is asked about again, and so is the next turn's", async () => {
    const r = rig(cast({ main: [{ toolCalls: [write("a.md", "c1")] }, { toolCalls: [write("b.md", "c2")] }, brief, { toolCalls: [write("c.md", "c3")] }, brief] }), asking);
    const asked = user(r.host, () => ({ decision: "once" }));
    await r.turn();
    expect(asked.asks.map((ask) => ask.callId)).toEqual(["c1", "c2"]);
    expect(await learned(r.harness)).toEqual(["a.md", "b.md"]);
    r.host.say(CHAT, "user", "I wait on the step.");
    await r.turn();
    expect(asked.asks.map((ask) => ask.callId)).toEqual(["c1", "c2", "c3"]);
  });

  test("approved for this chat, runs, and the tool's later calls in the chat aren't asked about: not in the turn, not in the next, not after a restart; another tool and another chat still are", async () => {
    const r = rig(
      cast({
        main: [{ toolCalls: [write("a.md", "c1")] }, { toolCalls: [write("b.md", "c2"), pin("a.md", "c3")] }, brief, { toolCalls: [write("c.md", "c4")] }, brief, { toolCalls: [write("d.md", "c5")] }, brief, { toolCalls: [write("a.md", "c6")] }, brief],
      }),
      asking,
    );
    const asked = user(r.host, (ask) => ({ decision: ask.tool === "workspace_write" ? "chat" : "once" }));
    await r.turn();
    expect(asked.asks.map((ask) => [ask.tool, ask.callId])).toEqual([
      ["workspace_write", "c1"],
      ["workspace_pin", "c3"],
    ]);
    expect(await learned(r.harness)).toEqual(["a.md", "b.md"]);
    r.host.say(CHAT, "user", "I wait on the step.");
    await r.turn();
    expect(asked.asks).toHaveLength(2);
    // The user's word is kept in the store, not in the harness: one made anew over the same store holds it.
    r.host.say(CHAT, "user", "I knock again.");
    await runTurn(r.host, createHarness(r.host, r.options), CHAT);
    expect(asked.asks).toHaveLength(2);
    expect(await learned(r.harness)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    // It was given for one chat.
    await r.turn(OTHER);
    expect(asked.asks.slice(2).map((ask) => [ask.chatId, ask.tool, ask.callId])).toEqual([[OTHER, "workspace_write", "c6"]]);
    expect(await learned(r.harness, OTHER)).toEqual(["a.md"]);
    // The live view draws a card for each call that was asked about, and for no other.
    expect(r.host.traced.flatMap((t) => (t.event.kind === "agent_entry" && t.event.entry.kind === "approval_asked" ? [t.event.entry.callId] : []))).toEqual(["c1", "c3", "c6"]);
  });

  test("refused with a reason, doesn't run: the agent is given the reason, and goes on to finish the turn", async () => {
    const r = rig(cast({ main: [{ toolCalls: [write("key.md", "c1")] }, brief] }), asking);
    user(r.host, () => ({ decision: "refused", reason: "Brann hasn't agreed to that." }));
    const { result } = await r.turn();
    expect(resultOf(r.host, "c1")).toEqual({ content: "Not run: the user refused this call of workspace_write. Don't make it again unless they ask for it; go on without it, or say in your answer what you needed it for.\nTheir reason: Brann hasn't agreed to that.", failed: true });
    expect(await learned(r.harness)).toEqual([]);
    expect(result).toMatchObject({ status: "done", reply: REPLY });
    expect(r.host.calls.map(caller)).toEqual(["main", "main", "writer"]);
  });
});

// ---------------------------------------------------------------- nobody answers, nobody to ask

describe("a held call nobody gives their word for", () => {
  test("waits no longer than Wait for your word: then it is refused, the agent is told why, and the turn ends with its reply", async () => {
    const r = rig(cast({ main: [{ toolCalls: [write("key.md", "c1")] }, brief] }), (s) => {
      asking(s);
      s.approval.waitMs = 60_000;
    });
    const asked = user(r.host, () => null);
    const turning = r.turn();
    await until(() => asked.asks.length === 1);
    expect(asked.asks[0]?.until).toBe(r.host.clock.now() + 60_000);
    r.host.clock.advance(59_999);
    await idle();
    // A moment short of the bound it still waits: nothing ran, and the agent wasn't called again.
    expect(asked.signals[0]?.aborted).toBe(false);
    expect(r.host.calls).toHaveLength(1);
    r.host.clock.advance(1);
    const { result } = await turning;
    // The host is told to take the ask down.
    expect(asked.signals[0]?.aborted).toBe(true);
    expect(resultOf(r.host, "c1")).toEqual({ content: `${NOT_ASKED}, and none came in the 60 seconds it may wait (Wait for your word). ${GO_ON}`, failed: true });
    expect(await learned(r.harness)).toEqual([]);
    expect(result).toMatchObject({ status: "done", reply: REPLY });
  });

  test("on a host with no way to ask, is refused in words that say so, and the turn still ends with its reply", async () => {
    const r = rig(cast({ main: [{ toolCalls: [write("key.md", "c1")] }, brief] }), asking);
    expect(r.host.approvals).toBeUndefined();
    const { result } = await r.turn();
    expect(resultOf(r.host, "c1")).toEqual({ content: `${NOT_ASKED}, and there is no way to ask them here. ${GO_ON}`, failed: true });
    expect(await learned(r.harness)).toEqual([]);
    expect(result).toMatchObject({ status: "done", reply: REPLY });
  });

  test("when asking fails, is refused with the failure said", async () => {
    const r = rig(cast({ main: [{ toolCalls: [write("key.md", "c1")] }, brief] }), asking);
    r.host.approvals = { ask: () => Promise.reject(new Error("the page's link is down")) };
    const { result } = await r.turn();
    expect(resultOf(r.host, "c1")).toEqual({ content: `${NOT_ASKED}, and asking for it failed (the page's link is down). ${GO_ON}`, failed: true });
    expect(await learned(r.harness)).toEqual([]);
    expect(result).toMatchObject({ status: "done", reply: REPLY });
  });

  test("ends with its turn when the turn is stopped: the ask is taken down, nothing runs, and the turn ends as stopped", async () => {
    const r = rig(cast({ main: [{ toolCalls: [write("key.md", "c1")] }, brief] }), asking);
    const asked = user(r.host, () => null);
    const stop = new AbortController();
    const turning = r.turn(CHAT, { signal: stop.signal });
    await until(() => asked.asks.length === 1);
    expect(asked.signals[0]?.aborted).toBe(false);
    stop.abort();
    const { result, sink } = await turning;
    expect(asked.signals[0]?.aborted).toBe(true);
    expect(result).toMatchObject({ status: "stopped", reply: "" });
    expect(sink.failed).toMatchObject({ code: "stopped" });
    expect(r.host.calls).toHaveLength(1);
    expect(await learned(r.harness)).toEqual([]);
    expect(r.host.traced.at(-1)?.event).toMatchObject({ kind: "turn_ended", status: "stopped" });
  });
});

// ---------------------------------------------------------------- every agent of every run

describe("a sub-agent's call and a job's call", () => {
  test("a sub-agent's held call is asked about as the sub-agent's, in the turn that started it", async () => {
    const r = rig(
      cast({
        main: [{ toolCalls: [call("delegate", { agent: "summarizer", task: "Say who knocks at the lighthouse." }, "d1")] }, brief],
        sub: [{ toolCalls: [call("chat_read", { from: 1 }, "s1")] }, "Mara knocks."],
      }),
      (s) => (s.approval.tools.chat_read = "ask"),
    );
    const asked = user(r.host, () => ({ decision: "once" }));
    const { request, result } = await r.turn();
    const sub = started(r.host, "summarizer")[0];
    expect(sub?.parent).toBe(started(r.host, "main")[0]?.id);
    expect(asked.asks).toMatchObject([{ turn: request.generationId, chatId: CHAT, agentId: sub?.id ?? "", role: "summarizer", callId: "s1", tool: "chat_read", tier: "read", args: { from: 1 } }]);
    expect(resultOf(r.host, "s1")?.failed).toBe(false);
    expect(resultOf(r.host, "d1")?.content).toStartWith("Mara knocks.");
    expect(result.status).toBe("done");
  });

  test("a job's held call is asked about as its agent's, with the job's id as the turn", async () => {
    const r = rig(cast({ job: [{ toolCalls: [write("key.md", "j1")] }, "I wrote learned/key.md."] }), (s) => {
      asking(s);
      s.agents.summarizer?.tools.push("workspace_write");
    });
    const asked = user(r.host, () => ({ decision: "once" }));
    const { job } = await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: "Note who holds the key.", when: "now" });
    const ran = await r.harness.jobs.run({ id: job.id }, never);
    const agent = started(r.host, "summarizer", job.id)[0];
    expect(asked.asks).toMatchObject([{ turn: job.id, chatId: CHAT, agentId: agent?.id ?? "", role: "summarizer", callId: "j1", tool: "workspace_write", tier: "write" }]);
    expect(ran.state).toBe("done");
    expect(await learned(r.harness)).toEqual(["key.md"]);
  });
});

// ---------------------------------------------------------------- two runs under way in one chat

describe("two runs under way in one chat", () => {
  /** Write tools ask, and the summarizer, which a job runs as here, is given two of them. */
  const both = (s: Settings): void => {
    asking(s);
    s.agents.summarizer?.tools.push("workspace_write", "workspace_pin");
  };
  const startJob = async (harness: Harness): Promise<string> => (await harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: "Pin the note of who holds the key.", when: "now" })).job.id;
  /** Which run each ask came from, and for which tool. */
  const by = (asks: readonly ApprovalAsk[], job: string): string[] => asks.map((ask) => `${ask.turn === job ? "job" : "turn"}: ${ask.tool}`);
  /** A turn that calls both tools: the third run, which is asked about neither once both are approved for the chat. */
  const third: Step[] = [{ toolCalls: [write("last.md", "t1"), pin("key.md", "t2")] }, brief];

  test("each adds to what the chat already holds: a turn is approved for one tool, a job begun before that for another, and a third run is asked about neither", async () => {
    const first = Promise.withResolvers<Answer>();
    const r = rig(cast({ job: [() => first.promise, "Pinned."], main: [{ toolCalls: [write("key.md", "c1")] }, brief, ...third] }), both);
    const asked = user(r.host, () => ({ decision: "chat" }));
    // The job begins, and reads what the chat holds, before anything was approved: its first call is under way.
    const job = await startJob(r.harness);
    const running = r.harness.jobs.run({ id: job }, never);
    await until(() => r.host.calls.length === 1);
    await r.turn();
    expect(by(asked.asks, job)).toEqual(["turn: workspace_write"]);
    first.resolve({ toolCalls: [pin("key.md", "j1")] });
    expect((await running).state).toBe("done");
    expect(by(asked.asks, job)).toEqual(["turn: workspace_write", "job: workspace_pin"]);
    r.host.say(CHAT, "user", "I wait on the step.");
    const { result } = await r.turn();
    expect(by(asked.asks, job)).toEqual(["turn: workspace_write", "job: workspace_pin"]);
    expect([resultOf(r.host, "t1")?.failed, resultOf(r.host, "t2")?.failed]).toEqual([false, false]);
    expect(result.status).toBe("done");
  });

  test("both wait at once and are answered in the same moment: both tools are kept", async () => {
    const word = Promise.withResolvers<ApprovalAnswer>();
    const r = rig(cast({ job: [{ toolCalls: [pin("key.md", "j1")] }, "Pinned."], main: [{ toolCalls: [write("more.md", "c1")] }, brief, ...third] }), both);
    await r.harness.workspace.write({ chatId: CHAT, area: "learned", path: "key.md", text: KEY, base: null });
    const asked = user(r.host, () => word.promise);
    const job = await startJob(r.harness);
    const running = r.harness.jobs.run({ id: job }, never);
    await until(() => asked.asks.length === 1);
    const turning = r.turn();
    await until(() => asked.asks.length === 2);
    expect(by(asked.asks, job)).toEqual(["job: workspace_pin", "turn: workspace_write"]);
    word.resolve({ decision: "chat" });
    expect((await running).state).toBe("done");
    expect((await turning).result.status).toBe("done");
    r.host.say(CHAT, "user", "I wait on the step.");
    await r.turn();
    expect(asked.asks).toHaveLength(2);
    expect([resultOf(r.host, "t1")?.failed, resultOf(r.host, "t2")?.failed]).toEqual([false, false]);
  });

  test("a tool approved for the chat in one run isn't asked about in the other, though that one began before", async () => {
    const first = Promise.withResolvers<Answer>();
    const r = rig(cast({ job: [() => first.promise, "Written."], main: [{ toolCalls: [write("key.md", "c1")] }, brief] }), both);
    const asked = user(r.host, () => ({ decision: "chat" }));
    const job = await startJob(r.harness);
    const running = r.harness.jobs.run({ id: job }, never);
    await until(() => r.host.calls.length === 1);
    await r.turn();
    first.resolve({ toolCalls: [write("more.md", "j1")] });
    expect((await running).state).toBe("done");
    expect(by(asked.asks, job)).toEqual(["turn: workspace_write"]);
    expect(resultOf(r.host, "j1")?.failed).toBe(false);
    expect(await learned(r.harness)).toEqual(["key.md", "more.md"]);
  });
});

// ---------------------------------------------------------------- a store that fails

describe("what the store can't give or keep", () => {
  const approvals = DOC.approvals(CHAT);

  test("approvals that can't be read are taken as none: the user is asked again, and the log says why", async () => {
    const r = rig(cast({ main: [{ toolCalls: [write("a.md", "c1")] }, brief, { toolCalls: [write("b.md", "c2")] }, brief] }), asking);
    const asked = user(r.host, () => ({ decision: "chat" }));
    await r.turn();
    const read = r.host.store.read;
    r.host.store.read = (path) => (path === approvals ? Promise.reject(new Error("the store is away")) : read(path));
    r.host.say(CHAT, "user", "I wait on the step.");
    const { result } = await r.turn();
    expect(asked.asks.map((ask) => ask.callId)).toEqual(["c1", "c2"]);
    expect(r.host.logs.some((line) => line.level === "warn" && line.message.includes(`the tools approved for chat ${CHAT} couldn't be read: the store is away`))).toBe(true);
    expect(result.status).toBe("done");
  });

  test("an approval that can't be kept still lets its call run, the log says why, and the next turn asks again", async () => {
    const r = rig(cast({ main: [{ toolCalls: [write("a.md", "c1")] }, { toolCalls: [write("b.md", "c2")] }, brief, { toolCalls: [write("c.md", "c3")] }, brief] }), asking);
    const asked = user(r.host, () => ({ decision: "chat" }));
    const kept = r.host.store.write;
    r.host.store.write = (path, value) => (path === approvals ? Promise.reject(new Error("the store is full")) : kept(path, value));
    await r.turn();
    // The turn that was told holds it for as long as it runs.
    expect(asked.asks.map((ask) => ask.callId)).toEqual(["c1"]);
    expect(await learned(r.harness)).toEqual(["a.md", "b.md"]);
    expect(r.host.logs.some((line) => line.level === "warn" && line.message.includes(`approving workspace_write for chat ${CHAT} couldn't be kept: the store is full`))).toBe(true);
    r.host.say(CHAT, "user", "I wait on the step.");
    await r.turn();
    expect(asked.asks.map((ask) => ask.callId)).toEqual(["c1", "c3"]);
  });
});
