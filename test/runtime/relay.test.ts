// The loopback endpoint against the extension backend (DESIGN §2, §6): a request without a tag is
// passed through to the writer's connection; a tag admits one request; a chunk lost on the way is
// asked for again; and a turn stops from either side, Lumiverse's or the live view's.

import { afterEach, describe, expect, test } from "bun:test";
import type { JsonObject } from "../../src/core/ports";
import { toolCall } from "../support/fake-host";
import { PORT, type Rig, rig, until, USER } from "../support/rig";

let r: Rig | null = null;
afterEach(() => {
  r?.close();
  r = null;
});

const BRIEFED = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." })] }, "Okoro keeps it now. Ilse handed him the keys last spring, before the storms."];

describe("a request with no tag", () => {
  test("is passed through to the writer's connection as it came, and answered as a stream", async () => {
    const it = (r = await rig());
    await it.setUp();
    it.host.script = ["Mara met Joss at the quay."];
    const body: JsonObject = { model: "lumiah", stream: true, messages: [{ role: "user", content: "Say where Mara met Joss, in one line." }], temperature: 0.2, top_p: 0.9, max_tokens: 64 };

    const out = await it.lumiverse.post(it.runtime.fetch, body, { key: it.key, port: PORT });

    expect(out).toMatchObject({ status: 200, error: null, content: "Mara met Joss at the quay.", finish: "stop" });
    // The provider's own usage comes back untouched.
    expect(out.usage).toMatchObject({ prompt_tokens: 120, completion_tokens: 30 });
    expect(it.host.calls).toHaveLength(1);
    const passed = it.host.calls[0];
    if (passed?.kind !== "pass") throw new Error("a passed-through request was expected");
    // No turn: no agent ran, and the request went as it came, on the writer's connection (the user's default).
    expect(passed.request.connectionId).toBeNull();
    expect(passed.request.messages).toEqual([{ role: "user", content: "Say where Mara met Joss, in one line." }]);
    expect(passed.request.parameters).toMatchObject({ temperature: 0.2, top_p: 0.9, max_tokens: 64 });
    expect(it.backend.live.chatsOf(USER)).toEqual([]);
  });

  test("is answered whole when it didn't ask for a stream", async () => {
    const it = (r = await rig());
    await it.setUp();
    it.host.script = ["Mara met Joss at the quay."];
    const out = await it.lumiverse.post(it.runtime.fetch, { model: "lumiah", messages: [{ role: "user", content: "Where?" }] }, { key: it.key, port: PORT });
    expect(out).toMatchObject({ status: 200, error: null, content: "Mara met Joss at the quay.", finish: "stop" });
  });

  test("is refused without the user's loopback key", async () => {
    const it = (r = await rig());
    await it.setUp();
    const out = await it.lumiverse.post(it.runtime.fetch, { model: "lumiah", messages: [{ role: "user", content: "Where?" }] }, { key: "lah_not-the-key", port: PORT });
    expect(out.error?.message).toContain("isn't this account's loopback key");
    expect(it.host.calls).toHaveLength(0);
  });
});

describe("a turn's tag", () => {
  test("admits one request: the same tag sent again is refused in plain words, and no model is called for it", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = BRIEFED;
    const first = await it.generate(chatId);
    expect(first.error).toBeNull();
    const calls = it.host.calls.length;

    const again = await it.lumiverse.post(it.runtime.fetch, first.body, { key: it.key, port: PORT });

    expect(again.content).toBe("");
    expect(again.error?.code).toBe("conflict");
    expect(again.error?.message).toContain("This reply's tag was already used");
    expect(it.host.calls).toHaveLength(calls);
  });

  test("of no generation is refused", async () => {
    const it = (r = await rig());
    await it.setUp();
    const out = await it.lumiverse.post(it.runtime.fetch, { model: "lumiah", stream: true, messages: [{ role: "user", content: "Hello?" }], lumiah_turn: "0".repeat(32) }, { key: it.key, port: PORT });
    expect(out.error?.message).toContain("LumiAH doesn't know this reply's tag");
    expect(it.host.calls).toHaveLength(0);
  });
});

describe("a stream with a gap", () => {
  test("is asked for again from the missing chunk, and the reply arrives whole and in order", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = BRIEFED;
    // The third chunk of the writer's answer is lost on its way to the runtime, once.
    let lost: { stream: unknown; seq: unknown } | null = null;
    it.lumiverse.filter = (frame) => {
      if (lost !== null || frame.type !== "chunk" || frame.seq !== 3) return true;
      lost = { stream: frame.stream, seq: frame.seq };
      return false;
    };

    const out = await it.generate(chatId);

    expect(lost).not.toBeNull();
    expect(out.error).toBeNull();
    expect(out.content).toBe("Okoro keeps it now. Ilse handed him the keys last spring, before the storms.");
    // The extension sent the lost chunk a second time, because the runtime asked for it.
    const sentAgain = it.host.sent.filter((s) => {
      const frame = s.message as { type?: unknown; stream?: unknown; seq?: unknown };
      return frame.type === "chunk" && frame.stream === lost?.stream && frame.seq === 3;
    });
    expect(sentAgain.length).toBeGreaterThanOrEqual(2);
    // Once acknowledged to its end, the stream is forgotten.
    await until(() => it.backend.streams.size === 0, "the streams to be acknowledged");
  });
});

describe("stopping a turn", () => {
  test("from Lumiverse: closing the request ends the turn and the model call under way", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = [{ hang: true }];
    const stop = new AbortController();
    const generating = it.generate(chatId, { signal: stop.signal });
    await until(() => it.host.calls.length === 1, "the main agent's call");

    stop.abort();
    const out = await generating;

    expect(out.content).toBe("");
    await until(() => it.host.cancelled === 1, "the model call to be cancelled");
    await until(() => it.runtime.turns.count === 0, "the turn to end");
    await until(() => it.backend.live.runningOf(USER).length === 0, "the live view to show the turn ended");
    const live = await it.page.request("lah.live.open", { chatId });
    expect(live.live?.ended?.state).toBe("stopped");
  });

  test("from the live view: the runtime is told, the turn ends, and the chat gets its words", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = [{ hang: true }];
    let turn = "";
    const generating = it.generate(chatId, { onStarted: (id) => (turn = id) });
    await until(() => it.host.calls.length === 1 && it.backend.live.runningOf(USER).length === 1, "the turn to be running");

    const stopped = await it.page.request("lah.turn.stop", { chatId, turn });
    const out = await generating;

    expect(stopped).toEqual({ stopped: true });
    expect(out.content).toBe("");
    expect(out.error?.message).toContain("You stopped the reply from LumiAH's live view.");
    await until(() => it.host.cancelled === 1, "the model call to be cancelled");
    await until(() => it.runtime.turns.count === 0, "the turn to end");
    // A turn that has ended can't be stopped again.
    await until(() => it.backend.live.runningOf(USER).length === 0, "the live view to show the turn ended");
    expect(await it.page.request("lah.turn.stop", { chatId, turn })).toEqual({ stopped: false });
  });

  test("from Lumiverse's own stop event, when the request stays open", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = [{ hang: true }];
    let turn = "";
    const generating = it.generate(chatId, { onStarted: (id) => (turn = id) });
    await until(() => it.host.calls.length === 1 && it.backend.live.runningOf(USER).length === 1, "the turn to be running");

    it.host.emit.stopped({ generationId: turn, chatId, userId: USER });
    const out = await generating;

    expect(out.error?.message).toContain("You stopped the reply in Lumiverse.");
    await until(() => it.host.cancelled === 1, "the model call to be cancelled");
  });
});
