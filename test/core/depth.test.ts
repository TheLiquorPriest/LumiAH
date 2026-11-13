// What LumiAH gives an extension that writes its own story engine on it (DESIGN §3.4, §14, §15,
// §21): the reply released once, whole, by the agents themselves (by a reply_write of the
// extension's own where its claim gives one), a sub-agent's answer handed the reply's stream, the
// extension's word on each agent's model and on the reply, jobs in lanes and due by the next turn,
// and a claim that shows the main agent only the user's newest message and lets nothing but
// released text be the reply.

import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../../src/core/agents";
import type { AgentModelAsk, ChatClaim, HarnessExtension, ReplyRelease, ReplyTool, ReplyUnreleased } from "../../src/core/extension";
import { Gate } from "../../src/core/gate";
import { createHarness } from "../../src/core/harness";
import type { ModelRequest } from "../../src/core/ports";
import { HarnessRefusal } from "../../src/core/refusal";
import { defaultSettings, newAgentSettings, type Settings } from "../../src/core/settings";
import { renderDefault, TEXT } from "../../src/core/texts";
import { type Answer, call, idle, MemoryHost, runTurn, type Script, until, WRITER } from "./support/host";

const CHAT = "chat-depth";
const never = new AbortController().signal;

const AUTHOR = "You are the author. You decide what happens and release the reply.";
const VOICE = "You are Mara, a lamp keeper. Answer as she would.";
const def = (id: string, instructions: string, tools: string[]): AgentDefinition => ({ ...newAgentSettings(), id, name: id, description: `${id}: part of the story engine.`, instructions, given: "task", tools, grant: "definition" });
const author = def("author", AUTHOR, ["reply_write", "write_reply", "delegate", "agent_message", "job_start", "job_list", "job_read"]);
const voice = def("voice", VOICE, ["reply_write", "job_list"]);

const system = (request: ModelRequest): string => (request.messages[0]?.role === "system" ? request.messages[0].content : "");
/** Every message of a call, as one text: what the agent was sent, its own calls and their results. */
const seen = (request: ModelRequest | undefined): string => JSON.stringify(request?.messages ?? []);
/** What one call came back with, as the agent's next call carried it. */
const resultOf = (request: ModelRequest | undefined, callId: string) => request?.messages.flatMap((m) => m.parts ?? []).find((part) => part.type === "tool_result" && part.toolUseId === callId);

/** One answer of an agent's: as it is, or made from the call it answers. */
type Line = Answer | ((request: ModelRequest) => Answer | Promise<Answer>);

/** Answers each agent's calls in turn, by whose instructions the call carries. */
function lines(parts: { author?: Line[]; voice?: Line[] }): Script {
  const at = { author: 0, voice: 0 };
  return (request) => {
    const who = system(request).includes(VOICE) ? "voice" : "author";
    const line = parts[who]?.[at[who]++];
    if (line === undefined) throw new Error(`no line for the ${who}'s call ${at[who]}`);
    return typeof line === "function" ? line(request) : line;
  };
}

/** A follow-up to the agent whose handle the result of `callId` names, as a model copies it from there. */
const follow = (callId: string, text: string, id: string) => (request: ModelRequest): Answer => {
  const result = resultOf(request, callId);
  return { toolCalls: [call("agent_message", { handle: /handle (agent_[0-9a-f]{8})/.exec(result?.type === "tool_result" ? result.content : "")?.[1] ?? "", text }, id)] };
};

/** A chat an extension claims for its author, the extension hearing each release. */
function rig(script: Script, options: { claim?: ChatClaim | null; extension?: Partial<HarnessExtension>; change?: (s: Settings) => void } = {}) {
  const host = new MemoryHost();
  host.script = script;
  host.say(CHAT, "assistant", "The lamp room is cold.");
  host.say(CHAT, "user", "I ask Mara what she saw.");
  const stored = { values: defaultSettings(), texts: {} };
  options.change?.(stored.values);
  const released: ReplyRelease[] = [];
  const extension: HarnessExtension = {
    name: "Depth",
    definitions: async () => ({ agents: [author, voice] }),
    claim: async () => (options.claim === null ? null : { mainAgent: "author", ...options.claim }),
    released: async (release) => void released.push(structuredClone(release)),
    ...options.extension,
  };
  const harness = createHarness(host, { settings: async () => structuredClone(stored), extension });
  /** The calls one agent made, in order. */
  const callsOf = (instructions: string): ModelRequest[] => host.calls.filter((request) => system(request).includes(instructions));
  return { host, harness, released, callsOf, extension };
}

describe("the reply, released by the agents (§3.4)", () => {
  test("is released once: the first reply_write goes out, and every one after it is refused with nothing more reaching the stream; write_reply is refused after it too", async () => {
    const r = rig(
      lines({
        author: [
          // Two in one answer: the first goes out, and the second, asked about after it, is refused.
          { toolCalls: [call("reply_write", { text: "The lamp gutters. Mara looks up." }, "w1"), call("reply_write", { text: " She says nothing." }, "w2")] },
          { toolCalls: [call("reply_write", { text: ' "I saw the boat."' }, "w3")] },
          { toolCalls: [call("write_reply", { brief: "Mara saw the boat." }, "b1")] },
          "That is the moment.",
        ],
      }),
    );
    const { result, sink } = await runTurn(r.host, r.harness, CHAT);
    const reply = "The lamp gutters. Mara looks up.";
    expect(result).toMatchObject({ status: "done", reply });
    expect(sink.text).toBe(reply);
    expect(sink.order.filter((kind) => kind === "content")).toHaveLength(1);
    // The record holds the turn, and the main agent's last answer is no part of the reply.
    expect(result.record).not.toBeNull();
    // Each release after the first was refused in words that say the reply went out already, and no writer was called: the author's four calls are all there were.
    const again = { content: renderDefault(TEXT.answer.releaseAgain), isError: true };
    expect(resultOf(r.host.calls[1], "w2")).toMatchObject(again);
    expect(resultOf(r.host.calls[2], "w3")).toMatchObject(again);
    expect(r.host.calls).toHaveLength(4);
    expect(resultOf(r.host.calls[3], "b1")).toMatchObject({ content: renderDefault(TEXT.answer.replyReleased), isError: true });
    // The extension heard the one release, from the author.
    expect(r.released.map((release) => [release.agent.role, release.text, release.args])).toEqual([["author", reply, { text: reply }]]);
  });

  test("a hand-on after reply_write is refused before its agent starts, and a release after a handed-on answer is refused: the turn's reply is the first release alone", async () => {
    const refused = { content: renderDefault(TEXT.answer.releaseAgain), isError: true };
    const released = rig(lines({ author: [{ toolCalls: [call("reply_write", { text: "The lamp gutters." }, "w1")] }, { toolCalls: [call("delegate", { agent: "voice", task: "Answer the user as Mara.", to_reply: true }, "d1")] }, "Done."] }));
    const first = await runTurn(released.host, released.harness, CHAT);
    expect(first.result).toMatchObject({ status: "done", reply: "The lamp gutters." });
    expect(first.sink.text).toBe("The lamp gutters.");
    expect(resultOf(released.callsOf(AUTHOR)[2], "d1")).toMatchObject(refused);
    expect(released.callsOf(VOICE)).toHaveLength(0);

    const answer = "I saw the boat go out at dawn.";
    const handed = rig(
      lines({
        author: [
          { toolCalls: [call("delegate", { agent: "voice", task: "Answer the user as Mara.", to_reply: true }, "d1")] },
          { toolCalls: [call("reply_write", { text: "The lamp gutters." }, "w1"), call("delegate", { agent: "voice", task: "Say more.", to_reply: true }, "d2")] },
          "Done.",
        ],
        voice: [answer],
      }),
    );
    const second = await runTurn(handed.host, handed.harness, CHAT);
    expect(second.result).toMatchObject({ status: "done", reply: answer });
    expect(second.sink.text).toBe(answer);
    expect(resultOf(handed.callsOf(AUTHOR)[2], "w1")).toMatchObject(refused);
    expect(resultOf(handed.callsOf(AUTHOR)[2], "d2")).toMatchObject(refused);
    expect(handed.callsOf(VOICE)).toHaveLength(1);
    expect(handed.released.map((release) => [release.agent.role, release.text, release.args])).toEqual([["voice", answer, {}]]);
  });

  test("the extension's check: a refusal, a check that fails, and none in time each let nothing go and leave the turn's release to come; the release after them is the one, and one after that is refused", async () => {
    let hung = false;
    const r = rig(
      lines({
        author: [
          { toolCalls: [call("reply_write", { text: "The vault code is 4471." }, "w1")] },
          { toolCalls: [call("reply_write", { text: "boom" }, "w2")] },
          { toolCalls: [call("reply_write", { text: "Mara waits." }, "w3")] },
          { toolCalls: [call("reply_write", { text: "Mara shrugs." }, "w4")] },
          { toolCalls: [call("reply_write", { text: "Mara smiles." }, "w5")] },
          "Done.",
        ],
      }),
      {
        extension: {
          releasing: async (release) => {
            if (release.text === "boom") throw new Error("the checker broke");
            if (release.text === "Mara waits.") {
              hung = true;
              return new Promise<null>(() => undefined);
            }
            return release.text.includes("vault") ? { refused: "That names the vault's code: keep it hidden." } : null;
          },
        },
      },
    );
    const turn = runTurn(r.host, r.harness, CHAT);
    await until(() => hung);
    r.host.clock.advance(10_000);
    const { result } = await turn;
    expect(result).toMatchObject({ status: "done", reply: "Mara shrugs." });
    expect(resultOf(r.host.calls[1], "w1")).toMatchObject({ content: "That names the vault's code: keep it hidden.", isError: true });
    expect(resultOf(r.host.calls[2], "w2")).toMatchObject({ content: renderDefault(TEXT.answer.releaseFailed, { extension: "Depth", error: "the checker broke" }), isError: true });
    // No word within Wait for the extension: the words name the setting.
    const late = resultOf(r.host.calls[3], "w3");
    expect(late).toMatchObject({ isError: true });
    expect(late?.type === "tool_result" ? late.content : "").toContain("Wait for the extension");
    expect(resultOf(r.host.calls[5], "w5")).toMatchObject({ content: renderDefault(TEXT.answer.releaseAgain), isError: true });
    expect(r.released.map((release) => release.text)).toEqual(["Mara shrugs."]);
  });

  test("a claim whose reply is only what is released: a turn that released nothing fails, and no writer writes", async () => {
    const r = rig(lines({ author: ["Nothing to say."] }), { claim: { reply: "released" } });
    const { result, sink } = await runTurn(r.host, r.harness, CHAT);
    expect(result).toMatchObject({ status: "failed", reason: renderDefault(TEXT.progress.nothingReleased), reply: "" });
    expect(sink.text).toBe("");
    expect(sink.failed).not.toBeNull();
    expect(r.host.calls).toHaveLength(1);
    // write_reply isn't offered, and the author is asked to release the reply.
    expect(r.host.calls[0]?.tools?.map((tool) => tool.name)).not.toContain("write_reply");
    expect(seen(r.host.calls[0])).toContain(renderDefault(TEXT.main.askRelease));
  });
});

describe("a reply_write of the extension's own (§21: replyTool)", () => {
  const PIECES: Readonly<Record<number, string>> = { 1: "The lamp gutters. ", 2: "Mara looks up." };
  const replyTool: ReplyTool = { description: "Release the reply: the pieces you name, in order.", parameters: { type: "object", properties: { pieces: { type: "array", items: { type: "integer" }, description: "The pieces, in order." } }, required: ["pieces"] } };
  /** The extension's word: the pieces the call names, joined in order. */
  const joined = async (release: ReplyRelease) => {
    const { pieces } = release.args;
    return Array.isArray(pieces) ? { text: pieces.map((n) => PIECES[n as number] ?? "").join("") } : { refused: "Name the pieces." };
  };

  test("the lead is offered its description and arguments; releasing is asked with the call's arguments, and the text it gives is what streams and what released hears", async () => {
    const asked: ReplyRelease[] = [];
    const r = rig(lines({ author: [{ toolCalls: [call("reply_write", { pieces: [1, 2] }, "w1")] }, "Done."] }), {
      claim: { reply: "released", replyTool },
      extension: { releasing: async (release) => (asked.push(structuredClone(release)), joined(release)) },
    });
    const { result, sink } = await runTurn(r.host, r.harness, CHAT);
    expect(r.host.calls[0]?.tools?.find((tool) => tool.name === "reply_write")).toMatchObject({ description: replyTool.description, parameters: replyTool.parameters });
    expect(asked).toEqual([expect.objectContaining({ text: "", args: { pieces: [1, 2] }, agent: expect.objectContaining({ role: "author" }) })]);
    const whole = "The lamp gutters. Mara looks up.";
    expect(result).toMatchObject({ status: "done", reply: whole });
    expect(sink.text).toBe(whole);
    expect(r.released).toEqual([expect.objectContaining({ text: whole, args: { pieces: [1, 2] } })]);
  });

  test("no text in its answer, or no answer within Wait for the extension, lets nothing go; the release is still to come", async () => {
    let asked = 0;
    const r = rig(lines({ author: [{ toolCalls: [call("reply_write", { pieces: [1] }, "w1")] }, { toolCalls: [call("reply_write", { pieces: [1] }, "w2")] }, { toolCalls: [call("reply_write", { pieces: [2] }, "w3")] }, "Done."] }), {
      claim: { reply: "released", replyTool },
      extension: {
        releasing: (release) => {
          asked++;
          // Null lets the call's own text go, and this tool's calls carry none; then no answer at all.
          if (asked === 1) return Promise.resolve(null);
          if (asked === 2) return new Promise(() => undefined);
          return joined(release);
        },
      },
    });
    const turn = runTurn(r.host, r.harness, CHAT);
    await until(() => asked === 2);
    r.host.clock.advance(10_000);
    const { result, sink } = await turn;
    expect(resultOf(r.host.calls[1], "w1")).toMatchObject({ content: renderDefault(TEXT.answer.releaseUnchecked, { extension: "Depth" }), isError: true });
    const late = resultOf(r.host.calls[2], "w2");
    expect(late).toMatchObject({ isError: true });
    expect(late?.type === "tool_result" ? late.content : "").toContain("Wait for the extension");
    expect(result).toMatchObject({ status: "done", reply: "Mara looks up." });
    expect(sink.text).toBe("Mara looks up.");
    expect(r.released.map((release) => release.text)).toEqual(["Mara looks up."]);
  });

  test("its check left out by a later hello while the run goes on: a release is told no text came, and the reply is still the agent's to release", async () => {
    const r = rig(
      lines({
        author: [
          () => {
            // A later hello offers no check: from here on the member is gone.
            delete r.extension.releasing;
            return { toolCalls: [call("reply_write", { pieces: [1] }, "w1")] };
          },
          "Done.",
        ],
      }),
      { claim: { reply: "released", replyTool }, extension: { releasing: joined } },
    );
    await runTurn(r.host, r.harness, CHAT);
    expect(resultOf(r.host.calls[1], "w1")).toMatchObject({ content: renderDefault(TEXT.answer.releaseUnchecked, { extension: "Depth" }), isError: true });
  });

  test("one a model can't be offered, or without releasing to give the text, isn't: reply_write takes the reply's text, and the log says why", async () => {
    const malformed: ReplyTool = { description: "Release the reply.", parameters: { type: "object", properties: { pieces: "a list" }, required: ["pieces"] } };
    // The extension lets the call's own text go: only the tool it is offered as is in question here.
    const letGo: Partial<HarnessExtension> = { releasing: async () => null };
    for (const [claim, extension] of [
      [{ replyTool: malformed }, letGo],
      [{ replyTool: { ...replyTool, parameters: { type: "array" } } }, letGo],
      [{ replyTool }, {}],
    ] as [ChatClaim, Partial<HarnessExtension>][]) {
      const r = rig(lines({ author: [{ toolCalls: [call("reply_write", { text: "Mara looks up." }, "w1")] }, "Done."] }), { claim, extension });
      const { result } = await runTurn(r.host, r.harness, CHAT);
      const offered = r.host.calls[0]?.tools?.find((tool) => tool.name === "reply_write");
      expect(Object.keys((offered?.parameters.properties ?? {}) as object)).toEqual(["text"]);
      expect(r.host.logs.some((log) => log.level === "warn" && log.message.includes("reply_write"))).toBe(true);
      expect(result).toMatchObject({ status: "done", reply: "Mara looks up." });
    }
  });
});

describe("handing the reply on (§14: to_reply)", () => {
  test("the sub-agent's answer streams into the reply as it is written, and is the call's result; words before a tool call never go out", async () => {
    const r = rig(
      lines({
        author: [{ toolCalls: [call("delegate", { agent: "voice", task: "Answer the user as Mara.", as: "mara", to_reply: true })] }, "Done."],
        voice: [{ content: "Hmm. ", toolCalls: [call("job_list", {})] }, "I saw the boat go out at dawn."],
      }),
      { change: (s) => (s.delegation.replyHoldChars = 10) },
    );
    const { result, sink } = await runTurn(r.host, r.harness, CHAT);
    const answer = "I saw the boat go out at dawn.";
    expect(result).toMatchObject({ status: "done", reply: answer });
    expect(sink.text).toBe(answer);
    // It went out in pieces as the model wrote it, not whole at the end.
    expect(sink.order.filter((kind) => kind === "content").length).toBeGreaterThan(1);
    // The author's call came back with that answer.
    expect(seen(r.callsOf(AUTHOR)[1])).toContain(answer);
    expect(r.released).toEqual([expect.objectContaining({ text: answer, agent: expect.objectContaining({ role: "voice", as: "mara" }) })]);
    const started = r.host.traced.flatMap(({ event }) => (event.kind === "agent_started" && event.agent.role === "voice" ? [event.agent] : []));
    expect(started[0]?.as).toBe("mara");
  });

  test("an agent that doesn't write the reply can't hand it on; delegate offers as only where an extension builds LumiAH in", async () => {
    const r = rig(lines({ author: [{ toolCalls: [call("delegate", { agent: "voice", task: "Speak.", to_reply: true })] }, "Mara is quiet."] }), { claim: null, change: (s) => (s.reply.writer = "main") });
    const { result } = await runTurn(r.host, r.harness, CHAT);
    expect(result).toMatchObject({ status: "done", reply: "Mara is quiet." });
    expect(seen(r.host.calls[1])).toContain(renderDefault(TEXT.agents.noReply));
    const delegate = r.host.calls[0]?.tools?.find((tool) => tool.name === "delegate");
    expect(Object.keys((delegate?.parameters.properties ?? {}) as object)).toEqual(["agent", "task", "files", "as"]);
  });

  test("a chat that uses none of it is sent the tools as before", async () => {
    const host = new MemoryHost();
    host.script = ["Mara is quiet."];
    host.say(CHAT, "user", "Hello.");
    const stored = { values: defaultSettings(), texts: {} };
    stored.values.reply.writer = "main";
    const harness = createHarness(host, { settings: async () => structuredClone(stored) });
    await runTurn(host, harness, CHAT);
    const tools = host.calls[0]?.tools ?? [];
    expect(tools.map((tool) => tool.name)).not.toContain("reply_write");
    expect(Object.keys((tools.find((tool) => tool.name === "delegate")?.parameters.properties ?? {}) as object)).toEqual(["agent", "task", "files"]);
    expect(Object.keys((tools.find((tool) => tool.name === "job_start")?.parameters.properties ?? {}) as object)).toEqual(["agent", "task", "when", "again"]);
  });

  test("an agent that took the reply, messaged once its answer went out, answers the agent that asked: nothing it says then reaches the reply", async () => {
    const r = rig(
      lines({
        author: [{ toolCalls: [call("delegate", { agent: "voice", task: "Answer the user as Mara.", to_reply: true }, "d1")] }, follow("d1", "Who was aboard? (for me only)", "m1"), "Done."],
        voice: ["I saw the boat.", " SECRET: Okoro was aboard."],
      }),
    );
    const { result, sink } = await runTurn(r.host, r.harness, CHAT);
    expect(result).toMatchObject({ status: "done", reply: "I saw the boat." });
    expect(sink.text).toBe("I saw the boat.");
    // The author read the follow-up's answer; the extension heard the one release.
    expect(seen(r.callsOf(AUTHOR)[2])).toContain("SECRET: Okoro was aboard.");
    expect(r.released.map((release) => [release.agent.role, release.text])).toEqual([["voice", "I saw the boat."]]);
  });

  test("an agent that took the reply and sent none of it, messaged after, doesn't spend the turn's release: the author's own release is the reply", async () => {
    const r = rig(
      lines({
        author: [{ toolCalls: [call("delegate", { agent: "voice", task: "Answer the user as Mara.", to_reply: true }, "d1")] }, follow("d1", "Who was aboard?", "m1"), { toolCalls: [call("reply_write", { text: "Mara looks up." }, "w1")] }, "Done."],
        voice: ["", "Okoro was aboard."],
      }),
    );
    const { result, sink } = await runTurn(r.host, r.harness, CHAT);
    expect(result).toMatchObject({ status: "done", reply: "Mara looks up." });
    expect(sink.text).toBe("Mara looks up.");
    expect(seen(r.callsOf(AUTHOR)[2])).toContain("Okoro was aboard.");
    expect(r.released.map((release) => [release.agent.role, release.text])).toEqual([["author", "Mara looks up."]]);
  });

  test("an agent whose hand-on has ended is retried like any other: a follow-up's call that fails after streaming some of its text is made again", async () => {
    const r = rig(
      lines({
        author: [{ toolCalls: [call("delegate", { agent: "voice", task: "Answer the user as Mara.", to_reply: true }, "d1")] }, follow("d1", "Who was aboard?", "m1"), "Done."],
        voice: ["I saw the boat.", { deltas: ["Okoro was "], error: "503: overloaded" }, "Okoro was aboard."],
      }),
      { change: (s) => (s.loop.retryWaitMs = 0) },
    );
    const { result } = await runTurn(r.host, r.harness, CHAT);
    expect(r.callsOf(VOICE)).toHaveLength(3);
    expect(resultOf(r.callsOf(AUTHOR)[2], "m1")).toMatchObject({ content: expect.stringContaining("Okoro was aboard.") });
    expect(result).toMatchObject({ status: "done", reply: "I saw the boat." });
  });

  test("a release asked for while another agent's answer holds the reply, none of it out yet, is told to wait for it; that answer sending nothing, the release is still the author's", async () => {
    let voiceAsked = false;
    let checked = false;
    const r = rig(
      lines({
        author: [{ toolCalls: [call("reply_write", { text: "Mara looks up first." }, "w1"), call("delegate", { agent: "voice", task: "Answer the user as Mara.", to_reply: true }, "d1")] }, { toolCalls: [call("reply_write", { text: "Mara looks up." }, "w2")] }, "Done."],
        // Mara is asked while the author's first release waits on its check, and answers with nothing once that check is in.
        voice: [
          async () => {
            voiceAsked = true;
            await until(() => checked);
            return "";
          },
        ],
      }),
      {
        extension: {
          releasing: async (release) => {
            if (release.text === "Mara looks up first.") {
              await until(() => voiceAsked);
              checked = true;
            }
            return null;
          },
        },
      },
    );
    const { result, sink } = await runTurn(r.host, r.harness, CHAT);
    expect(resultOf(r.callsOf(AUTHOR)[1], "w1")).toMatchObject({ content: renderDefault(TEXT.answer.releaseWait), isError: true });
    expect(result).toMatchObject({ status: "done", reply: "Mara looks up." });
    expect(sink.text).toBe("Mara looks up.");
    expect(r.released.map((release) => [release.agent.role, release.text])).toEqual([["author", "Mara looks up."]]);
  });
});

describe("what the agents had ready, where the lead released none of the reply (§21: unreleased)", () => {
  const READY = "The lamp gutters. Mara looks up from the log.";
  /** The author, held to one round of tool calls. */
  const short = { ...author, budget: { ...author.budget, toolTurns: 1 } };
  const twoRounds: Line[] = [{ toolCalls: [call("job_list", {}, "j1")] }, { toolCalls: [call("job_list", {}, "j2")] }];

  test("a lead that stops at a limit with nothing released: the text the extension gives is the reply, once; released hears it; the turn is done, and says how the lead ended", async () => {
    const asked: ReplyUnreleased[] = [];
    const r = rig(lines({ author: [...twoRounds, "Nothing more."] }), {
      claim: { reply: "released" },
      extension: { definitions: async () => ({ agents: [short, voice] }), unreleased: async (turn) => (asked.push(structuredClone(turn)), { text: READY }) },
    });
    const { result, sink, request } = await runTurn(r.host, r.harness, CHAT);
    expect(asked).toEqual([{ userId: "user-1", chatId: CHAT, turn: request.generationId, ended: "limit" }]);
    expect(result).toMatchObject({ status: "done", reply: READY });
    expect(sink.text).toBe(READY);
    expect(sink.order.filter((kind) => kind === "content")).toHaveLength(1);
    expect(sink.failed).toBeNull();
    expect(r.released).toEqual([expect.objectContaining({ text: READY, args: {}, agent: expect.objectContaining({ role: "author" }) })]);
    // The live view and the reply's thinking block say how the lead ended, its limit named.
    const notices = r.host.traced.flatMap(({ event }) => (event.kind === "notice" ? [event.text] : []));
    expect(notices.some((text) => text.includes("Tool rounds per agent") && text.includes("Depth"))).toBe(true);
    expect(sink.progressLines.some((line) => line.includes("Depth"))).toBe(true);
    // So do the author's notes: the next turn's author reads how this one ended, and what went out in its place.
    r.host.say(CHAT, "user", "And then?");
    await runTurn(r.host, r.harness, CHAT);
    expect(seen(r.callsOf(AUTHOR)[2])).toContain("Depth released what its agents had ready as the reply");
  });

  test("asked once, with how the lead ended; with no text, or no answer in time, the turn fails as it did, a wait that ran out named", async () => {
    for (const [line, ended] of [
      ["Nothing to say.", "done"],
      [{ error: "401: the key was refused" }, "failed"],
    ] as [Line, ReplyUnreleased["ended"]][]) {
      const asked: ReplyUnreleased["ended"][] = [];
      const r = rig(lines({ author: [line] }), { claim: { reply: "released" }, extension: { unreleased: async (turn) => (asked.push(turn.ended), null) } });
      const { result, sink } = await runTurn(r.host, r.harness, CHAT);
      expect(asked).toEqual([ended]);
      expect(result).toMatchObject({ status: "failed", reason: renderDefault(TEXT.progress.nothingReleased), reply: "" });
      expect(sink.text).toBe("");
    }
    let waiting = false;
    const late = rig(lines({ author: ["Nothing to say."] }), { claim: { reply: "released" }, extension: { unreleased: () => ((waiting = true), new Promise(() => undefined)) } });
    const turn = runTurn(late.host, late.harness, CHAT);
    await until(() => waiting);
    late.host.clock.advance(10_000);
    const { result } = await turn;
    expect(result.status).toBe("failed");
    expect(result.reason).toStartWith(renderDefault(TEXT.progress.nothingReleased));
    expect(result.reason).toContain("Wait for the extension");
  });

  test("a lead stopped while a hand-on that sent nothing is still ending: the hand-on is let end, then the extension is asked, and what is ready is the reply", async () => {
    let asked = 0;
    let voiceCalled = false;
    const keeping = Promise.withResolvers<void>();
    const r = rig(
      lines({
        author: [{ toolCalls: [call("delegate", { agent: "voice", task: "Answer the user as Mara.", to_reply: true }, "d1")] }],
        voice: [() => ((voiceCalled = true), { hang: true })],
      }),
      { claim: { reply: "released" }, change: (s) => (s.turn.wallMs = 60_000), extension: { unreleased: async () => (asked++, { text: READY }) } },
    );
    // Keeping Mara's prompt takes a while: her call, stopped with the turn, ends only once it is kept.
    const put = r.host.blobs.put;
    r.host.blobs.put = async (hash, text) => {
      if (text.includes(VOICE)) await keeping.promise;
      return put(hash, text);
    };
    const turn = runTurn(r.host, r.harness, CHAT);
    await until(() => voiceCalled);
    r.host.clock.advance(60_000);
    await idle();
    keeping.resolve();
    const { result, sink } = await turn;
    expect(asked).toBe(1);
    expect(result).toMatchObject({ status: "done", reply: READY });
    expect(sink.text).toBe(READY);
  });

  test("a lead whose answer was cut at its length: the words say so, naming Answer per call and where it is changed", async () => {
    const r = rig(lines({ author: [{ content: "Mara looks", finishReason: "length" }] }), { claim: { reply: "released" }, extension: { unreleased: async () => ({ text: READY }) } });
    const { result } = await runTurn(r.host, r.harness, CHAT);
    expect(result).toMatchObject({ status: "done", reply: READY });
    const notices = r.host.traced.flatMap(({ event }) => (event.kind === "notice" ? [event.text] : []));
    expect(notices.some((text) => text.includes("Answer per call (Settings → Agents → author"))).toBe(true);
  });

  test("a hand-on that never ends holds the turn for no longer than Wait for the extension; what it held is then taken as nothing released", async () => {
    let asked = 0;
    let voiceCalled = false;
    const r = rig(
      lines({
        author: [{ toolCalls: [call("delegate", { agent: "voice", task: "Answer the user as Mara.", to_reply: true }, "d1")] }],
        voice: [() => ((voiceCalled = true), { hang: true })],
      }),
      { claim: { reply: "released" }, change: (s) => (s.turn.wallMs = 60_000), extension: { unreleased: async () => (asked++, { text: READY }) } },
    );
    // Mara's prompt is never kept: her call, stopped with the turn, never ends.
    const put = r.host.blobs.put;
    r.host.blobs.put = async (hash, text) => (text.includes(VOICE) ? new Promise<never>(() => {}) : put(hash, text));
    const turn = runTurn(r.host, r.harness, CHAT);
    await until(() => voiceCalled);
    r.host.clock.advance(60_000);
    await idle();
    r.host.clock.advance(10_000);
    const { result } = await turn;
    expect(asked).toBe(0);
    expect(result.status).toBe("failed");
  });

  test("isn't asked once the user stopped the turn, nor once the reply went out", async () => {
    let asked = 0;
    const unreleased = async () => (asked++, { text: READY });
    const stop = new AbortController();
    const stopped = rig(lines({ author: [{ hang: true }] }), { claim: { reply: "released" }, extension: { unreleased } });
    const turn = runTurn(stopped.host, stopped.harness, CHAT, { signal: stop.signal });
    await until(() => stopped.host.calls.length === 1);
    stop.abort();
    expect((await turn).result.status).toBe("stopped");

    const released = rig(lines({ author: [{ toolCalls: [call("reply_write", { text: "Mara looks up." }, "w1")] }, "Done."] }), { claim: { reply: "released" }, extension: { unreleased } });
    expect((await runTurn(released.host, released.harness, CHAT)).result).toMatchObject({ status: "done", reply: "Mara looks up." });
    expect(asked).toBe(0);
  });
});

describe("the extension's word on an agent's model (§21: agentModel)", () => {
  test("the model the hook answers is the one called, asked with the definition, as, and who started it; a long as is refused", async () => {
    const asked: AgentModelAsk[] = [];
    const r = rig(
      lines({
        author: [
          { toolCalls: [call("delegate", { agent: "voice", task: "Say what you saw.", as: "x".repeat(201) })] },
          { toolCalls: [call("delegate", { agent: "voice", task: "Say what you saw.", as: "mara" })] },
          { toolCalls: [call("reply_write", { text: "Mara saw the boat." })] },
          "Done.",
        ],
        voice: ["The boat, at dawn."],
      }),
      {
        extension: {
          agentModel: async (ask) => {
            asked.push(structuredClone(ask));
            return ask.definition === "voice" ? { connectionId: WRITER, model: "model-mara", effort: "high" } : null;
          },
        },
      },
    );
    await runTurn(r.host, r.harness, CHAT);
    expect(seen(r.callsOf(AUTHOR)[1])).toContain(renderDefault(TEXT.agents.asLong, { chars: "201", limit: "200" }));
    const [spoke] = r.callsOf(VOICE);
    expect([spoke?.connectionId, spoke?.model]).toEqual([WRITER, "model-mara"]);
    // The author runs on its definition's own: the hook said nothing for it.
    expect(r.callsOf(AUTHOR)[0]?.model).toBeNull();
    expect(asked.find((ask) => ask.definition === "author")).toMatchObject({ as: null, standing: "turn", by: null });
    expect(asked.find((ask) => ask.definition === "voice")).toMatchObject({ as: "mara", standing: "sub", by: { role: "author" } });
  });
});

describe("jobs in lanes and due by the next turn (§15)", () => {
  test("waiting jobs go soon before later, first come first through within each", async () => {
    const gate = new Gate(() => 1);
    const leave = await gate.enter(never);
    const went: string[] = [];
    const wait = (name: string, soon: boolean) => gate.enter(never, soon).then((free) => (went.push(name), free()));
    const all = Promise.all([wait("later-1", false), wait("later-2", false), wait("soon-1", true), wait("soon-2", true)]);
    leave();
    await all;
    expect(went).toEqual(["soon-1", "soon-2", "later-1", "later-2"]);
  });

  /** A turn whose author starts a job due by the next turn, its reply saved, and the user's next message. */
  async function dueRig() {
    const r = rig(
      lines({
        author: [
          { toolCalls: [call("job_start", { agent: "voice", task: "Digest the beat.", due: "next_turn", lane: "soon", as: "mara" }), call("reply_write", { text: "Mara nods." })] },
          "Done.",
          { toolCalls: [call("reply_write", { text: "Mara waits." })] },
          "Done.",
        ],
        voice: ["Digested: the boat went out at dawn."],
      }),
      { change: (s) => (s.jobs.dueWaitMs = 45_000) },
    );
    await runTurn(r.host, r.harness, CHAT);
    const [job] = r.host.queued;
    expect(job).toMatchObject({ due: "next_turn", lane: "soon", as: "mara" });
    r.host.say(CHAT, "user", "And then?");
    return { ...r, job: job?.id ?? "" };
  }

  test("a due job still running when the wait runs out is named to the main agent", async () => {
    const r = await dueRig();
    const next = runTurn(r.host, r.harness, CHAT);
    await until(() => r.host.clock.slept.includes(45_000));
    r.host.clock.advance(45_000);
    const { sink } = await next;
    expect(sink.progressLines).toContain(renderDefault(TEXT.progress.dueWait, { jobs: "1 job" }));
    const opening = seen(r.callsOf(AUTHOR)[2]);
    expect(opening).toContain("Jobs due by this turn that haven't ended yet");
    expect(opening).toContain(`${r.job} (voice for mara)`);
  });

  test("a due job is waited for: one that ends meanwhile is heard of as ended, not as running", async () => {
    const r = await dueRig();
    const next = runTurn(r.host, r.harness, CHAT);
    await until(() => r.host.clock.slept.includes(45_000));
    // Time passes while it works: the news a turn hears is of jobs that ended after its last look.
    r.host.clock.advance(1000);
    expect((await r.harness.jobs.run({ id: r.job }, never)).state).toBe("done");
    const { result } = await next;
    expect(result).toMatchObject({ status: "done", reply: "Mara waits." });
    const opening = seen(r.callsOf(AUTHOR)[2]);
    expect(opening).not.toContain("haven't ended yet");
    expect(opening).toContain(`${r.job} (voice): done.`);
  });
});

describe("what of the request the main agent is shown (§21)", () => {
  test("the main agent is shown only the user's newest message where the claim says so", async () => {
    const r = rig(lines({ author: [{ toolCalls: [call("reply_write", { text: "Mara frowns." })] }, "Done."] }), { claim: { request: "newest" } });
    await runTurn(r.host, r.harness, CHAT);
    const opening = r.callsOf(AUTHOR)[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(opening).toContain("The user's newest message:");
    expect(opening).toContain("I ask Mara what she saw.");
    expect(opening).not.toContain("The lamp room is cold.");
  });
});

describe("a job the user starts that writes the chat's own area (the prepared start)", () => {
  test("with area chat it writes the chat's own area and keeps its plan where it was told; without it, that write is refused", async () => {
    const KEEPER = "You keep the story's notes.";
    const keeper = def("keeper", KEEPER, ["workspace_write"]);
    const write = (path: string): Answer => ({ toolCalls: [call("workspace_write", { path, content: "Mara saw the boat.", base: "new" })] });
    const steps: Answer[] = [write("author/notebook.md"), "Done.", write("author/other.md"), "Done."];
    let at = 0;
    const r = rig(() => steps[at++] ?? "Done.", { extension: { definitions: async () => ({ agents: [author, voice, keeper] }) } });
    const { job: prepared } = await r.harness.jobs.start({ chatId: CHAT, agent: "keeper", task: "Prepare the story.", when: "now", area: "chat", plan: "author/prepare.md" });
    expect(prepared).toMatchObject({ area: "chat", plan: "author/prepare.md", basis: null });
    expect((await r.harness.jobs.run({ id: prepared.id }, never)).state).toBe("done");
    const { job: plain } = await r.harness.jobs.start({ chatId: CHAT, agent: "keeper", task: "Tidy the notes.", when: "now" });
    expect((await r.harness.jobs.run({ id: plain.id }, never)).state).toBe("done");
    const [first, second, third, fourth] = r.callsOf(KEEPER);
    expect(seen(first)).toContain("write your plan to author/prepare.md");
    expect(seen(first)).toContain("You may write the chat's own area");
    expect(seen(second)).not.toContain(renderDefault(TEXT.jobs.noChatArea));
    expect(seen(third)).toContain("learned/plans/");
    expect(seen(fourth)).toContain(renderDefault(TEXT.jobs.noChatArea));
  });

  test("a plan its starter keeps: its agent is told the starter's words of it as it begins, as it is carried on and as it is run again, and never asked to write the plan or to fit it to its allowance", async () => {
    const KEEPER = "You keep the story's notes.";
    const keeper = def("keeper", KEEPER, ["workspace_write"]);
    const WORDS = "This allowance is for this run only. author/prepare.md is the plan of the whole work, and the preparing tools keep it.";
    const note = (n: number): Answer => ({ content: `Note ${n} written.`, toolCalls: [call("workspace_write", { path: `author/note-${n}.md`, content: "Mara saw the boat.", base: "new" })] });
    // The first run uses its one round and stops at its allowance; granted more, it ends; a second job fails, and run again ends.
    const steps: Answer[] = [note(1), note(2), "Done.", { error: "401: the key was refused" }, "Done."];
    let at = 0;
    const r = rig(() => steps[at++] ?? "Done.", { extension: { definitions: async () => ({ agents: [author, voice, keeper] }) } });
    const start = { chatId: CHAT, agent: "keeper", task: "Prepare the story.", when: "now" as const, area: "chat" as const, plan: "author/prepare.md" };
    const { job } = await r.harness.jobs.start({ ...start, planWords: `  ${WORDS}\n`, allowance: { toolTurns: 1 } });
    expect(await r.harness.jobs.run({ id: job.id }, never)).toMatchObject({ state: "spent", stoppedAt: "allowance" });
    await r.harness.jobs.grant({ id: job.id, allowance: { toolTurns: 5 } });
    expect((await r.harness.jobs.run({ id: job.id }, never)).state).toBe("done");
    const { job: second } = await r.harness.jobs.start({ ...start, planWords: WORDS });
    expect(await r.harness.jobs.run({ id: second.id }, never)).toMatchObject({ state: "failed", lasting: true });
    const { job: again } = await r.harness.jobs.again({ id: second.id });
    expect(again).toMatchObject({ plan: "author/prepare.md", area: "chat" });
    expect((await r.harness.jobs.run({ id: again.id }, never)).state).toBe("done");

    const lastSaid = (request: ModelRequest | undefined): string => request?.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const [opening, , carried, failed, ranAgain] = r.callsOf(KEEPER);
    for (const told of [lastSaid(opening), lastSaid(failed), lastSaid(ranAgain)]) {
      expect(told).toContain(`What this job may still spend:`);
      expect(told).toContain(`never only in your head.\n\n${WORDS}\n\nYou may write the chat's own area (/)`);
      expect(told).not.toContain("write your plan");
      expect(told).not.toContain("narrower");
    }
    expect(lastSaid(ranAgain)).toContain("This is the same job run again.");
    expect(lastSaid(carried)).toStartWith("This job was stopped and is carried on now, from where you left it. What this job may still spend:");
    expect(lastSaid(carried)).toContain(` ${WORDS} Then go on.`);
    expect(lastSaid(carried)).not.toContain("Read your plan");

    // The words come with the plan file they are about, and are held to Task length as the task is.
    await expect(r.harness.jobs.start({ chatId: CHAT, agent: "keeper", task: "Prepare the story.", when: "now", planWords: WORDS })).rejects.toMatchObject({ code: "invalid" });
    await expect(r.harness.jobs.start({ ...start, planWords: "x ".repeat(2001) })).rejects.toMatchObject({ code: "invalid", message: "The plan's words are 4001 characters, and Task length (Settings → Jobs) lets them be 4000 at most." });
  });

  /** A chat whose main agent writes its replies, `replies` of them already played, and a job of the user's that writes two files to the chat's own area. Every model call is answered in turn from `script`. */
  async function prepared(replies: number, script: Answer[]) {
    const host = new MemoryHost();
    let at = 0;
    host.script = () => script[at++] ?? "Done.";
    host.say(CHAT, "assistant", "The lamp room is cold.");
    host.say(CHAT, "user", "I ask Mara what she saw.");
    const stored = { values: defaultSettings(), texts: {} };
    stored.values.reply.writer = "main";
    const harness = createHarness(host, { settings: async () => structuredClone(stored) });
    for (let n = 0; n < replies; n++) {
      if (n > 0) host.say(CHAT, "user", "And then?");
      await runTurn(host, harness, CHAT);
    }
    const { job } = await harness.jobs.start({ chatId: CHAT, agent: "main", task: "Prepare the story.", when: "now", area: "chat" });
    expect((await harness.jobs.run({ id: job.id }, never)).state).toBe("done");
    /** A file of the chat's own area as the page reads it in a chat; null where it isn't there. */
    const file = async (path: string, chatId = CHAT): Promise<string | null> => harness.workspace.read({ chatId, area: "chat", path }).then((read) => read.text, () => null);
    /** What a tool call was answered with, as the agent's next call carried it. */
    const result = (callId: string): string => {
      for (const request of host.calls) for (const m of request.messages) for (const part of m.parts ?? []) if (part.type === "tool_result" && part.toolUseId === callId) return part.content;
      return "";
    };
    return { host, harness, file, result };
  }
  const MIND = "Mara saw the boat leave at dawn.";
  const NOTEBOOK = "The story turns on the missing boat.";
  const writes: Answer = { toolCalls: [call("workspace_write", { path: "/minds/mara/core.md", content: MIND, base: "new" }), call("workspace_write", { path: "/author/notebook.md", content: NOTEBOOK, base: "new" })] };
  const reads = (id: string): Answer => ({ toolCalls: [call("workspace_read", { path: "/minds/mara/core.md" }, `${id}-mind`), call("workspace_read", { path: "/author/notebook.md" }, `${id}-notes`)] });

  test("what it wrote survives a swipe of the newest reply, every later turn on that path, and a branch cut before or after the swipe", async () => {
    const r = await prepared(2, ["Okoro opens the door.", "He lets Mara in.", writes, "Prepared.", reads("swipe"), "The lamp is lit.", "Mara waits.", reads("branch"), "The quay is empty."]);
    // A branch cut right after the job, before anything else is played.
    r.host.branch(CHAT, r.host.chats.get(CHAT)?.length ?? 0, "chat-early");
    // The newest reply is swiped: the turn that writes the new reply reads both files whole.
    await runTurn(r.host, r.harness, CHAT, { kind: "swipe" });
    expect([r.result("swipe-mind"), r.result("swipe-notes")].join("\n")).toContain(MIND);
    expect(r.result("swipe-notes")).toContain(NOTEBOOK);
    // A later turn on that path, and the page, still have them.
    r.host.say(CHAT, "user", "And then?");
    await runTurn(r.host, r.harness, CHAT);
    expect([await r.file("minds/mara/core.md"), await r.file("author/notebook.md")]).toEqual([MIND, NOTEBOOK]);
    // A branch cut after the swipe has them; so does the early one, where a swipe of the newest reply reads them too.
    r.host.branch(CHAT, r.host.chats.get(CHAT)?.length ?? 0, "chat-late");
    expect([await r.file("minds/mara/core.md", "chat-late"), await r.file("author/notebook.md", "chat-late")]).toEqual([MIND, NOTEBOOK]);
    expect([await r.file("minds/mara/core.md", "chat-early"), await r.file("author/notebook.md", "chat-early")]).toEqual([MIND, NOTEBOOK]);
    await runTurn(r.host, r.harness, "chat-early", { kind: "swipe" });
    expect(r.result("branch-mind")).toContain(MIND);
    expect(r.result("branch-notes")).toContain(NOTEBOOK);
  });

  test("in a chat with no reply of LumiAH's yet, what it wrote is there for the first turn, for a swipe of the newest message, and in a branch", async () => {
    const r = await prepared(0, [writes, "Prepared.", reads("first"), "Mara looks up."]);
    r.host.branch(CHAT, r.host.chats.get(CHAT)?.length ?? 0, "chat-fresh");
    expect([await r.file("minds/mara/core.md", "chat-fresh"), await r.file("author/notebook.md", "chat-fresh")]).toEqual([MIND, NOTEBOOK]);
    await runTurn(r.host, r.harness, "chat-fresh");
    expect(r.result("first-mind")).toContain(MIND);
    expect(r.result("first-notes")).toContain(NOTEBOOK);
  });
});

describe("a job run again, what a job is told, and an answer cut while it thought (§15, §22)", () => {
  test("run again from the page it is the same job for the same turn, told what it was told and why its last run stopped; refused once that reply is off the path", async () => {
    const r = rig(
      lines({
        author: [{ toolCalls: [call("job_start", { agent: "voice", task: "Digest the beat.", as: "mara", lane: "soon", due: "next_turn" }), call("reply_write", { text: "Mara nods." })] }, "Done.", { toolCalls: [call("reply_write", { text: "Mara shrugs." })] }, "Done."],
        // Cut while thinking twice: once, and once more on the second go with more room.
        voice: [{ content: "", reasoning: "Mara turns the morning over and over.", finishReason: "length" }, { content: "", reasoning: "And over again.", finishReason: "length" }, "Digested: the boat went out at dawn."],
      }),
    );
    const { request } = await runTurn(r.host, r.harness, CHAT);
    // Its answer ran out while it was still thinking: the failure says so.
    const failed = await r.harness.jobs.run({ id: r.host.queued[0]?.id ?? "" }, never);
    // It names the room as the job's own agent's setting, where it is changed.
    const CUT = renderDefault(TEXT.jobs.whyCutThinking, { setting: "Answer per call (Settings → Agents → voice → Budget)" });
    expect(failed).toMatchObject({ state: "failed", reason: CUT });
    const { job } = await r.harness.jobs.again({ id: failed.id });
    expect(job).toMatchObject({ again: failed.id, basis: request.generationId, by: { who: "agent", role: "author" }, as: "mara", lane: "soon", due: "next_turn", task: "Digest the beat." });
    expect((await r.harness.jobs.run({ id: job.id }, never)).state).toBe("done");
    const told = r.callsOf(VOICE)[2]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(told).toContain(renderDefault(TEXT.jobs.task, { task: "Digest the beat." }));
    expect(told).toContain(renderDefault(TEXT.jobs.againNote, { why: CUT }));
    expect(told).not.toContain("write your plan");
    // The reply it was started from is swiped away: it isn't run again, and not as anything else either.
    await runTurn(r.host, r.harness, CHAT, { kind: "swipe" });
    const refused = await r.harness.jobs.again({ id: failed.id }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HarnessRefusal);
    expect((refused as HarnessRefusal).message).toBe(renderDefault(TEXT.jobs.againOffPath, { id: failed.id }));
  });

  test("a job the user starts is told of a plan and of files only where its agent can write them", async () => {
    const r = rig(lines({ voice: ["Thought it over."] }));
    const { job } = await r.harness.jobs.start({ chatId: CHAT, agent: "voice", task: "Think over what Mara saw.", when: "now" });
    expect((await r.harness.jobs.run({ id: job.id }, never)).state).toBe("done");
    const told = r.callsOf(VOICE)[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(told).toContain("You are running as a job the user started");
    expect(told).toContain("Think over what Mara saw.");
    for (const promise of ["write your plan", "learned/", "in files"]) expect(told).not.toContain(promise);
  });

  /** A job of the user's whose agent can call job_list, answered from `voice` in turn; its calls and what became of it. */
  async function cutRun(voiceLines: Answer[]) {
    const r = rig(lines({ voice: voiceLines }));
    const { job } = await r.harness.jobs.start({ chatId: CHAT, agent: "voice", task: "Think over what Mara saw.", when: "now" });
    const ended = await r.harness.jobs.run({ id: job.id }, never);
    return { ended, calls: r.callsOf(VOICE) };
  }
  const thinking: Answer = { content: "", reasoning: "Mara turns the morning over and over.", finishReason: "length" };
  const notice = renderDefault(TEXT.runtime.cutThinking);

  test("a call its room cut while it was all thinking is made again once, with twice the room, and the model told to think briefly and act", async () => {
    const { ended, calls } = await cutRun([thinking, "She saw the boat leave at dawn."]);
    expect(ended).toMatchObject({ state: "done", opening: "She saw the boat leave at dawn.", usage: { calls: 2 } });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.maxTokens).toBe(Math.min((calls[0]?.maxTokens ?? 0) * 2, 64_000));
    expect(JSON.stringify(calls[1]?.messages.at(-1))).toContain(notice.slice(1, 40));
  });

  test("cut so again on the second go, the job fails in words that say so, with no third call", async () => {
    const { ended, calls } = await cutRun([thinking, thinking, "Never reached."]);
    expect(ended).toMatchObject({ state: "failed", reason: renderDefault(TEXT.jobs.whyCutThinking, { setting: "Answer per call (Settings → Agents → voice → Budget)" }), usage: { calls: 2 } });
    expect(calls).toHaveLength(2);
  });

  test("an answer cut after it made a whole tool call is handled as before: the call runs, with no second go and no more room", async () => {
    const { ended, calls } = await cutRun([{ toolCalls: [call("job_list", {})], finishReason: "length" }, "Nothing else is running."]);
    expect(ended.state).toBe("done");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.maxTokens).toBe(calls[0]?.maxTokens);
    expect(JSON.stringify(calls[1]?.messages)).not.toContain(notice.slice(1, 40));
    expect(calls[1]?.messages.at(-1)?.parts?.some((part) => part.type === "tool_result")).toBe(true);
  });
});
