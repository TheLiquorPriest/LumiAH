// A model call through pi-ai keeps the core's contract (core/ports.ts `ModelsPort`): deltas of text
// and of reasoning as they come, the whole answer as the result, the signal's own reason when it
// ends the call; native tool calls both ways; and a tool loop that thinks sends each turn's signed
// thinking back exactly, as the core's own session (core/provider.ts) runs it. A turn written
// before this build, in Lumiverse's shapes, still goes, with what maps to the call's API.

import { afterEach, describe, expect, test } from "bun:test";
import type { FauxContentBlock, FauxProviderHandle, StopReason, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { ModelDelta, ModelMessage, ModelTool } from "../../../src/core/ports";
import type { CallSpec, ModelReply, ProviderDeps } from "../../../src/core/provider";
import { AgentAccounts, NATIVE_TURNS, ProviderSession, requestOf } from "../../../src/core/provider";
import { defaultSettings } from "../../../src/core/settings";
import { Texts } from "../../../src/core/texts";
import type { Rig } from "./support";
import { anthropicStream, anthropicTurn, bodyOf, chatStream, chunk, eventStream, forever, request, rig } from "./support";

const KEY = "gsk_live_0123456789abcdefWXYZ";
const LOOKUP: ModelTool = { name: "lookup", description: "Looks a thing up.", parameters: { type: "object", properties: { what: { type: "string" } } } };

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

/** A layer whose Groq connection answers from pi-ai's faux provider, a reasoning model, its answers in small pieces. */
async function onFaux(provider = "groq", model = "faux-1"): Promise<{ r: Rig; faux: FauxProviderHandle; id: string }> {
  const faux = fauxProvider({ provider, models: [{ id: model, reasoning: true }], tokenSize: { min: 1, max: 1 } });
  const made = rig({ providers: [faux.provider], caching: () => ({ sessionId: "session-1", retention: "short" }) });
  r = made;
  const saved = await made.layer.book.save({ name: `${provider} connection`, provider, auth: "key", model }, KEY);
  return { r: made, faux, id: saved.id };
}

/** A faux answer that keeps the context it was asked with. */
function answer(contexts: TranscriptContext[], content: FauxContentBlock[], stopReason: StopReason = "stop") {
  return (context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    return fauxAssistantMessage(content, { stopReason });
  };
}

describe("a call through pi-ai", () => {
  test("streams its text and its reasoning as they come, each delta one or the other, and answers with the whole of each", async () => {
    const { r, faux } = await onFaux();
    faux.setResponses([fauxAssistantMessage([fauxThinking("Ilse weighs the keys."), fauxText("Okoro takes them.")])]);
    const deltas: ModelDelta[] = [];
    const result = await r.layer.models.call(request({ messages: [{ role: "user", content: "Who takes the keys?" }], stream: true }), forever(), (d) => deltas.push(d));
    expect(deltas.map((d) => d.reasoning ?? "").join("")).toBe("Ilse weighs the keys.");
    expect(deltas.map((d) => d.content ?? "").join("")).toBe("Okoro takes them.");
    expect(deltas.length).toBeGreaterThan(4);
    expect(deltas.every((d) => (d.content === undefined) !== (d.reasoning === undefined))).toBe(true);
    expect(result).toMatchObject({ content: "Okoro takes them.", reasoning: "Ilse weighs the keys.", finishReason: "stop", model: "faux-1" });
  });

  test("a call that doesn't stream hands nothing on, and answers the same", async () => {
    const { r, faux } = await onFaux();
    faux.setResponses([fauxAssistantMessage("The mill is closed.")]);
    const deltas: ModelDelta[] = [];
    const result = await r.layer.models.call(request({ messages: [{ role: "user", content: "Is the mill open?" }] }), forever(), (d) => deltas.push(d));
    expect(deltas).toEqual([]);
    expect(result.content).toBe("The mill is closed.");
  });

  test("the signal ends a call mid-stream with its own reason, and no delta comes after it", async () => {
    const { r, faux } = await onFaux();
    faux.setResponses([fauxAssistantMessage("The tide came in over the causeway and the carts turned back one by one.")]);
    const stop = new AbortController();
    const reason = new Error("The reply was stopped in Lumiverse.");
    let afterwards = 0;
    const call = r.layer.models.call(request({ messages: [{ role: "user", content: "Tell me about the tide." }], stream: true }), stop.signal, () => {
      if (stop.signal.aborted) afterwards += 1;
      else stop.abort(reason);
    });
    await expect(call).rejects.toBe(reason);
    expect(afterwards).toBe(0);
  });

  test("a signal that has already ended ends the call before anything is sent", async () => {
    const { r, faux } = await onFaux();
    faux.setResponses([fauxAssistantMessage("never")]);
    const stop = new AbortController();
    const reason = new Error("cancelled before it began");
    stop.abort(reason);
    await expect(r.layer.models.call(request({ messages: [{ role: "user", content: "Hello?" }] }), stop.signal)).rejects.toBe(reason);
    expect(faux.state.callCount).toBe(0);
  });

  test("two connections on different models answer at the same moment, each with its own words", async () => {
    const groq = fauxProvider({ provider: "groq", models: [{ id: "fast-1" }], tokenSize: { min: 1, max: 1 } });
    const deep = fauxProvider({ provider: "deepseek", models: [{ id: "deep-1", reasoning: true }], tokenSize: { min: 1, max: 1 } });
    r = rig({ providers: [groq.provider, deep.provider] });
    const one = await r.layer.book.save({ name: "Quick", provider: "groq", auth: "key", model: "fast-1" }, KEY);
    const two = await r.layer.book.save({ name: "Deep", provider: "deepseek", auth: "key", model: "deep-1" }, "sk-deepseek-0123456789abcdef");
    groq.setResponses([fauxAssistantMessage("Okoro rides to the mill at dawn.")]);
    deep.setResponses([fauxAssistantMessage([fauxThinking("The ledger shows two debts."), fauxText("Ilse owes the miller twice.")])]);
    const fast: ModelDelta[] = [];
    const slow: ModelDelta[] = [];
    const [a, b] = await Promise.all([
      r.layer.models.call(request({ messages: [{ role: "user", content: "Where does Okoro go?" }], connectionId: one.id, stream: true }), forever(), (d) => fast.push(d)),
      r.layer.models.call(request({ messages: [{ role: "user", content: "What does Ilse owe?" }], connectionId: two.id, effort: "high", stream: true }), forever(), (d) => slow.push(d)),
    ]);
    expect(a).toMatchObject({ content: "Okoro rides to the mill at dawn.", model: "fast-1" });
    expect(b).toMatchObject({ content: "Ilse owes the miller twice.", reasoning: "The ledger shows two debts.", model: "deep-1" });
    expect(fast.map((d) => d.content ?? "").join("")).toBe("Okoro rides to the mill at dawn.");
    expect(fast.some((d) => d.reasoning !== undefined)).toBe(false);
    expect(slow.map((d) => d.content ?? "").join("")).toBe("Ilse owes the miller twice.");
    expect(slow.map((d) => d.reasoning ?? "").join("")).toBe("The ledger shows two debts.");
  });
});

describe("a tool loop, as the core's own session runs it", () => {
  test("three calls with thinking: calls come back under the tools' names, and each turn goes back with its own signed thinking, in order", async () => {
    const { r, faux, id } = await onFaux();
    const contexts: TranscriptContext[] = [];
    faux.setResponses([
      answer(contexts, [{ type: "thinking", thinking: "Look for the keys first.", thinkingSignature: "sig-1" }, fauxToolCall("lookup", { what: "keys" }, { id: "call_1" })], "toolUse"),
      answer(contexts, [{ type: "thinking", thinking: "Now the door they open.", thinkingSignature: "sig-2" }, fauxToolCall("lookup", { what: "door" }, { id: "call_2" })], "toolUse"),
      answer(contexts, [{ type: "thinking", thinking: "That is enough to answer.", thinkingSignature: "sig-3" }, fauxText("The keys under the mat open the cellar door.")]),
    ]);
    const settings = defaultSettings();
    const clock = { now: () => 0, sleep: async () => undefined };
    const host = { models: r.layer.models, connections: r.layer.connections, clock, log: () => undefined };
    const deps: ProviderDeps = { host, settings, texts: new Texts(), accounts: new AgentAccounts(host) };
    const reasoning: string[] = [];
    const spec: CallSpec = { connectionId: id, model: null, effort: "high", system: "You find things in the house.", prefix: [], cache: { session: "agent_keys", retention: "short", key: "" }, onDelta: (d) => d.reasoning !== undefined && reasoning.push(d.reasoning) };
    const session = new ProviderSession(deps, spec);
    let conversation: ModelMessage[] = [{ role: "user", content: "Which door do the keys open?" }];
    const replies: ModelReply[] = [];
    for (let round = 0; round < 3; round += 1) {
      const prepared = await session.prepare(conversation, [LOOKUP]);
      const reply = await session.send(prepared, requestOf(spec, prepared, 2000, settings), forever());
      replies.push(reply);
      if (reply.calls.length === 0) break;
      conversation = [...conversation, NATIVE_TURNS.assistant(reply), NATIVE_TURNS.results(reply.calls.map((call) => ({ call, text: `found the ${String(call.args.what)}`, error: false })), new Texts())];
    }
    expect(replies.map((x) => x.calls.map((c) => [c.id, c.name, c.args]))).toEqual([[["call_1", "lookup", { what: "keys" }]], [["call_2", "lookup", { what: "door" }]], []]);
    expect(replies[2]?.text).toBe("The keys under the mat open the cellar door.");
    expect(reasoning.join("")).toBe("Look for the keys first.Now the door they open.That is enough to answer.");

    // The third call was sent both earlier turns as the model wrote them: thinking with its signature, then the call, then the call's result under its tool's name.
    const third = contexts[2]?.messages ?? [];
    const turns = third.filter((m) => m.role === "assistant");
    expect(turns.map((t) => t.content)).toEqual([
      [{ type: "thinking", thinking: "Look for the keys first.", thinkingSignature: "sig-1" }, { type: "toolCall", id: "call_1", name: "lookup", arguments: { what: "keys" } }],
      [{ type: "thinking", thinking: "Now the door they open.", thinkingSignature: "sig-2" }, { type: "toolCall", id: "call_2", name: "lookup", arguments: { what: "door" } }],
    ]);
    // Each turn names the model that wrote it, which pi-ai checks before it sends a signature back.
    const model = faux.getModel();
    expect(turns.every((t) => t.role === "assistant" && t.provider === model.provider && t.api === model.api && t.model === model.id)).toBe(true);
    expect(third.filter((m) => m.role === "toolResult").map((m) => (m.role === "toolResult" ? [m.toolCallId, m.toolName, m.content] : null))).toEqual([
      ["call_1", "lookup", [{ type: "text", text: "found the keys" }]],
      ["call_2", "lookup", [{ type: "text", text: "found the door" }]],
    ]);
    // The tools went with every call, and the session's cache was read again after the first.
    expect(contexts.every((c) => c.messages[0]?.role === "system" && (c.messages[0].toolsAdded ?? []).map((t) => t.name).join() === "lookup")).toBe(true);
    expect(replies[1]?.usage.cachedIn).toBeGreaterThan(0);
  });
});

describe("a turn written before this build, in Lumiverse's shapes", () => {
  const earlier: ModelMessage = {
    role: "assistant",
    content: 'lookup {"what":"keys"}',
    parts: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { what: "keys" }, thoughtSignature: "gemini-thought-signature" }],
    reasoning: "Find the keys.",
    thinkingBlocks: [{ type: "thinking", thinking: "Find the keys.", signature: "anthropic-signature" }, { type: "redacted_thinking", data: "redacted-data" }, { type: "thinking", thinking: "never signed" }],
  };
  const loop: ModelMessage[] = [{ role: "user", content: "Where are the keys?" }, earlier, { role: "user", content: "under the mat", parts: [{ type: "tool_result", toolUseId: "toolu_1", content: "under the mat" }] }];

  test("goes to an Anthropic call with its signed and redacted thinking, and without what Anthropic can't take", async () => {
    r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: "The keys are under the mat." }))) });
    await r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, "sk-ant-api03-0123456789abcdef");
    const result = await r.layer.models.call(request({ messages: loop, tools: [LOOKUP], effort: "high" }), forever());
    expect(result.content).toBe("The keys are under the mat.");
    const messages = bodyOf(r.sent[0]).messages as Record<string, unknown>[];
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Find the keys.", signature: "anthropic-signature" },
        { type: "redacted_thinking", data: "redacted-data" },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { what: "keys" } },
      ],
    });
    expect(messages[2]).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1" }] });
  });

  test("goes to a chat-completions call with its reasoning as `reasoning_content`, and without Anthropic's blocks", async () => {
    r = rig({ script: () => eventStream(chatStream([chunk({ role: "assistant", content: "Under the mat." }), chunk({}, "stop")])) });
    await r.layer.book.save({ name: "DeepSeek", provider: "deepseek", auth: "key", model: "deepseek-flash" }, "sk-deepseek-0123456789abcdef");
    const result = await r.layer.models.call(request({ messages: loop, tools: [LOOKUP], effort: "high" }), forever());
    expect(result.content).toBe("Under the mat.");
    const messages = bodyOf(r.sent[0]).messages as Record<string, unknown>[];
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toMatchObject({ reasoning_content: "Find the keys.", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "lookup", arguments: '{"what":"keys"}' } }] });
    expect(JSON.stringify(messages)).not.toContain("anthropic-signature");
    expect(JSON.stringify(messages)).not.toContain("gemini-thought-signature");
  });
});
