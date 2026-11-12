// What an agent's model writes is seen as it is written (PI-BUILD-PLAN §0.5: the live session views
// and the reply's thinking block keep streaming): the runtime calls its providers itself, and each
// piece of an answer goes on as it comes. Each test holds a scripted answer open between its pieces
// on a promise the test keeps, and looks at what has arrived before it lets the answer go on: what is
// seen then was seen before the call ended.

import { afterEach, describe, expect, test } from "bun:test";
import { toolCall } from "../support/fake-host";
import { type Rig, rig, until } from "../support/rig";

let r: Rig | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
});

/** Asks again, a millisecond apart, until `read` gives what `done` takes; fails with `what` when it never does. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 2_000; i++) {
    const value = await read();
    if (done(value)) return value;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("an answer as it is written", () => {
  test("an agent's reasoning and text reach the live view while its call is still under way", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    // The live view is sent what arrived at most once a millisecond: each piece below goes out on its own.
    await it.page.request("lah.settings.set", { set: [{ path: ["core", "trace", "deltaMs"], value: 1 }], reset: [] });
    const reasoned = Promise.withResolvers<void>();
    const wrote = Promise.withResolvers<void>();
    it.host.script = [
      { reasoning: "Who holds the keys now? ", deltas: ["Reading ", "the lamp log."], content: "Reading the lamp log.", toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." })], waits: [reasoned.promise, wrote.promise] },
      "Okoro keeps it now.",
    ];
    const generating = it.generate(chatId);
    /** The main agent's answer under way, as the live view holds it. */
    const partial = async () => {
      const live = (await it.page.request("lah.live.open", { stream: chatId })).live;
      const main = live?.events.flatMap((e) => (e.event.kind === "agent_started" && e.event.agent.role === "main" ? [e.event.agent.id] : []))[0];
      return live?.partials.find((p) => p.agentId === main) ?? null;
    };

    // Its reasoning, while the provider holds the rest of the answer back.
    const thought = await eventually(partial, (p) => p !== null && p.reasoning !== "", "the main agent's reasoning in the live view");
    expect(thought).toMatchObject({ call: 1, reasoning: "Who holds the keys now? ", text: "" });
    // Then the first piece of its text, the call still under way. The live view's interval runs on the runtime's clock, the real one here: the piece is let go once a millisecond has passed since the reasoning went.
    await until(() => Date.now() >= (thought?.at ?? 0) + 2, "the live view's interval to pass");
    reasoned.resolve();
    expect(await eventually(partial, (p) => p !== null && p.text !== "", "the main agent's text in the live view")).toMatchObject({ call: 1, reasoning: "Who holds the keys now? ", text: "Reading " });
    expect(it.host.calls).toHaveLength(1);

    wrote.resolve();
    const out = await generating;
    expect(out).toMatchObject({ error: null, content: "Okoro keeps it now." });
  });

  test("the writer's reasoning and text reach Lumiverse's reply as separate pieces while its call is still under way", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    const reasoned = Promise.withResolvers<void>();
    const wrote = Promise.withResolvers<void>();
    it.host.script = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." })] }, { reasoning: "Plain, and short.", deltas: ["Okoro ", "keeps it now."], content: "Okoro keeps it now.", waits: [reasoned.promise, wrote.promise] }];
    const pieces: { kind: "reasoning" | "content"; text: string }[] = [];
    const generating = it.generate(chatId, { onReasoning: (text) => void pieces.push({ kind: "reasoning", text }), onPiece: (text) => void pieces.push({ kind: "content", text }) });

    // The thinking block's piece, while the provider holds the rest of the writer's answer back.
    await until(() => pieces.some((p) => p.kind === "reasoning" && p.text.includes("Plain, and short.")), "the writer's reasoning in the reply");
    expect(pieces.filter((p) => p.kind === "content")).toEqual([]);
    // Then the reply's first words, apart from the reasoning, the call still under way.
    reasoned.resolve();
    await until(() => pieces.some((p) => p.kind === "content"), "the writer's text in the reply");
    expect(pieces.filter((p) => p.kind === "content")).toEqual([{ kind: "content", text: "Okoro " }]);
    expect(it.host.providerCalls).toHaveLength(2);

    wrote.resolve();
    const out = await generating;
    expect(out).toMatchObject({ error: null, content: "Okoro keeps it now." });
    expect(out.reasoning).toContain("Plain, and short.");
    expect(pieces.filter((p) => p.kind === "content").map((p) => p.text).join("")).toBe("Okoro keeps it now.");
  });
});
