// The loopback endpoint against the extension backend (DESIGN §2, §6): a request without a tag is
// passed through to the writer's connection; a tag admits one request; a chunk lost on the way is
// asked for again; a turn stops from either side, Lumiverse's or the live view's; a turn that never
// ends is let go for the chat's next reply; a reply asked while the link is refused is told why and
// what LumiAH does meanwhile; a request's key is checked before its body is read; and `/healthz`
// says little on an address other machines reach.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentUsage, JsonObject } from "../../src/core/ports";
import { isRecord } from "../../src/core/ports";
import type { HostGenerationType } from "../../src/extension/backend/spindle";
import { KEY_FORM, LINK, LINK_VERSION, versionWords } from "../../src/link/contract";
import { healthProof } from "../../src/runtime/relay";
import type { Runtime } from "../../src/runtime/runtime";
import { FakeLumiverse, type Generated } from "../support/fake-lumiverse";
import { FakeHost, toolCall } from "../support/fake-host";
import { FAST, PORT, type Rig, type RigOptions, rig, runtimeFor, runtimeFrom, until, USER } from "../support/rig";

let r: Rig | null = null;
let alone: Runtime | null = null;
afterEach(() => {
  r?.close();
  r = null;
  alone?.close();
  alone = null;
});

const BRIEFED = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." })] }, "Okoro keeps it now. Ilse handed him the keys last spring, before the storms."];

/** A harness for a test that runs no turn: what it checks is the endpoint's own, so it loads nothing of the core. */
const noTurns: NonNullable<RigOptions["harness"]> = () => ({
  answer: async () => {
    throw new Error("no turn runs in this test");
  },
});

describe("a request with no tag", () => {
  test("is passed through to the writer's connection as it came, and answered as a stream", async () => {
    const it = (r = await rig({ harness: noTurns }));
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
    const it = (r = await rig({ harness: noTurns }));
    await it.setUp();
    it.host.script = ["Mara met Joss at the quay."];
    const out = await it.lumiverse.post(it.runtime.fetch, { model: "lumiah", messages: [{ role: "user", content: "Where?" }] }, { key: it.key, port: PORT });
    expect(out).toMatchObject({ status: 200, error: null, content: "Mara met Joss at the quay.", finish: "stop" });
  });

  test("is refused without the user's loopback key", async () => {
    const it = (r = await rig({ harness: noTurns }));
    await it.setUp();
    // A key of the form the extension mints, which isn't this user's: the extension says so.
    const out = await it.lumiverse.post(it.runtime.fetch, { model: "lumiah", messages: [{ role: "user", content: "Where?" }] }, { key: `lah_${"0".repeat(64)}`, port: PORT });
    expect(out.error?.message).toContain("isn't this account's loopback key");
    expect(it.host.calls).toHaveLength(0);
  });

  test("carries a message's name, its prefix mark, its media and its tool calls across the link as they came", async () => {
    const it = (r = await rig({ harness: noTurns }));
    await it.setUp();
    it.host.script = ["the light now."];
    const body: JsonObject = {
      model: "lumiah",
      stream: true,
      max_tokens: 48,
      messages: [
        { role: "user", name: "Mara", content: [{ type: "text", text: "Who is in this picture?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "call_faces", type: "function", function: { name: "faces", arguments: '{"of":"the keeper"}' } }] },
        { role: "tool", tool_call_id: "call_faces", content: "Okoro, at the lamp." },
        { role: "assistant", name: "Joss", content: "Okoro keeps", prefix: true },
      ],
      tools: [{ type: "function", function: { name: "faces", description: "Names the faces in a picture.", parameters: { type: "object", properties: { of: { type: "string" } } }, strict: true } }],
    };

    const out = await it.lumiverse.post(it.runtime.fetch, body, { key: it.key, port: PORT });

    expect(out).toMatchObject({ status: 200, error: null, content: "the light now.", finish: "stop" });
    const passed = it.host.calls[0];
    if (passed?.kind !== "pass") throw new Error("a passed-through request was expected");
    expect(passed.request.messages).toEqual([
      { role: "user", name: "Mara", content: [{ type: "text", text: "Who is in this picture?" }, { type: "media", media: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_faces", name: "faces", input: { of: "the keeper" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "call_faces", content: "Okoro, at the lamp." }] },
      { role: "assistant", name: "Joss", content: "Okoro keeps", prefix: true },
    ]);
    expect(passed.request.tools).toEqual([{ name: "faces", description: "Names the faces in a picture.", parameters: { type: "object", properties: { of: { type: "string" } } }, strict: true }]);
    expect(passed.request.parameters).toEqual({ max_tokens: 48 });
  });

  test("is refused whole when something in it can't be carried: nothing of it reaches the writer's connection", async () => {
    const it = (r = await rig({ harness: noTurns }));
    await it.setUp();
    const body: JsonObject = { model: "lumiah", stream: true, messages: [{ role: "user", content: [{ type: "text", text: "Whose boat is this?" }, { type: "image_url", image_url: { url: "https://harbour.example/boats/brann.png" } }] }] };

    const out = await it.lumiverse.post(it.runtime.fetch, body, { key: it.key, port: PORT });

    // Sent on without the picture, the question would have been answered about nothing.
    expect(out).toMatchObject({ status: 400, content: "", error: { code: "invalid_request" } });
    expect(out.error?.message).toContain("message 1's part 2 is given by its address (https://harbour.example/boats/brann.png)");
    expect(it.host.calls).toHaveLength(0);
    expect(it.runtime.relay.count).toBe(0);
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

/** How Lumiverse's generations came out from here on, as its events say: `stopped`, `ended`, or `failed` with its error. */
function outcomes(it: Rig): string[] {
  const seen: string[] = [];
  it.host.events.onGenerationStopped(() => void seen.push("stopped"));
  it.host.events.onGenerationEnded((event) => void seen.push(event.error === null ? "ended" : `failed: ${event.error}`));
  return seen;
}

/** A chat as the user sees it: each message's text, how many swipes it has, and whether a turn's record is anchored on it. */
const chatOf = (it: Rig, chatId: string): { role: string; text: string; swipes: number; record: boolean }[] => (it.host.chatList.get(chatId)?.messages ?? []).map((m) => ({ role: m.role, text: m.swipes[m.swipeId] ?? "", swipes: m.swipes.length, record: m.own !== null }));

const ASKED = { role: "user", text: "Who keeps the harbour light now?", swipes: 1, record: false };

/** A reply under way whose main agent never answers, and its turn's id. */
async function hanging(it: Rig, chatId: string, type: HostGenerationType = "normal"): Promise<{ turn: string; generating: Promise<Generated> }> {
  const before = it.host.calls.length;
  let turn = "";
  const generating = it.generate(chatId, { type, onStarted: (id) => (turn = id) });
  await until(() => it.host.calls.length === before + 1 && it.backend.live.runningOf(USER).length === 1, "the turn to be running");
  return { turn, generating };
}

/** How the live view shows the chat's latest turn ended, once it has. */
async function endOf(it: Rig, chatId: string): Promise<{ state: string; reason?: string } | null> {
  await until(() => it.runtime.turns.count === 0, "the turn to end");
  await until(() => it.backend.live.runningOf(USER).length === 0, "the live view to show the turn ended");
  return (await it.page.request("lah.live.open", { stream: chatId })).live?.ended ?? null;
}

describe("stopping a turn", () => {
  test("in Lumiverse: closing the request ends the turn and the model call under way, and the live view says where it was stopped", async () => {
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
    const ended = await endOf(it, chatId);
    expect(ended?.state).toBe("stopped");
    expect(ended?.reason).toContain("stopped in Lumiverse");
    // Lumiverse knew of its own Stop: it wasn't asked to stop anything.
    expect(it.lumiverse.stops).toEqual([]);
  });

  test("from the live view: Lumiverse is asked to stop the generation as its own Stop does, so nothing is shown as failed and nothing is left behind", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = [{ hang: true }];
    const seen = outcomes(it);
    const { turn, generating } = await hanging(it, chatId);

    const stopped = await it.page.request("lah.turn.stop", { stream: chatId, turn });
    const out = await generating;

    expect(stopped).toEqual({ stopped: true });
    // The runtime asked Lumiverse, which stopped its own generation: no error reached it, and it says the reply was stopped.
    expect(it.lumiverse.stops).toEqual([{ generationId: turn, chatId }]);
    expect(out).toMatchObject({ error: null, content: "", messageId: null });
    expect(seen).toEqual(["stopped"]);
    await until(() => it.host.cancelled === 1, "the model call to be cancelled");
    expect(await endOf(it, chatId)).toMatchObject({ state: "stopped", reason: "You stopped the reply from LumiAH's live view." });
    // No empty reply stays in the chat, and no record is anchored anywhere.
    await until(() => chatOf(it, chatId).length === 1, "the empty reply to be gone");
    expect(chatOf(it, chatId)).toEqual([ASKED]);
    expect(it.logs.filter((line) => line.includes("wasn't made to stop"))).toEqual([]);
    // A turn that has ended can't be stopped again.
    expect(await it.page.request("lah.turn.stop", { stream: chatId, turn })).toEqual({ stopped: false });
  });

  test("from the live view, when Lumiverse can't be made to stop it: the reply ends as a finished one, and the empty message it leaves is deleted", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = [{ hang: true }];
    it.lumiverse.stopFails = true;
    const seen = outcomes(it);
    const { turn, generating } = await hanging(it, chatId);

    await it.page.request("lah.turn.stop", { stream: chatId, turn });
    const out = await generating;

    // The stream ended as any reply's does: a finish, no error. Lumiverse took it for a finished reply and saved it, empty.
    expect(it.lumiverse.stops).toEqual([{ generationId: turn, chatId }]);
    expect(out).toMatchObject({ status: 200, error: null, content: "", finish: "stop" });
    expect(seen).toEqual(["ended"]);
    expect(await endOf(it, chatId)).toMatchObject({ state: "stopped", reason: "You stopped the reply from LumiAH's live view." });
    await until(() => chatOf(it, chatId).length === 1, "the empty reply to be deleted");
    expect(chatOf(it, chatId)).toEqual([ASKED]);
    expect(it.logs.filter((line) => line.includes("Lumiverse wasn't made to stop the reply"))).toHaveLength(1);
  });

  test("from the live view with the runtime's session ended: the reply still ends without an error", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = [{ hang: true }];
    const { turn, generating } = await hanging(it, chatId);
    // Lumiverse no longer takes the runtime's session; the link's socket, opened before, stays.
    it.lumiverse.token = "session-token-renewed";

    await it.page.request("lah.turn.stop", { stream: chatId, turn });
    const out = await generating;

    expect(out).toMatchObject({ status: 200, error: null, content: "", finish: "stop" });
    await until(() => chatOf(it, chatId).length === 1, "the empty reply to be deleted");
    expect(chatOf(it, chatId)).toEqual([ASKED]);
  });

  test("from the live view, a regenerated reply keeps its message: only a new reply's empty message is deleted", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = [...BRIEFED, { hang: true }];
    const first = await it.generate(chatId);
    expect(first.error).toBeNull();
    await until(() => chatOf(it, chatId)[1]?.record === true, "the first reply's record to be anchored");
    it.lumiverse.stopFails = true;
    const { turn, generating } = await hanging(it, chatId, "regenerate");

    await it.page.request("lah.turn.stop", { stream: chatId, turn });
    const out = await generating;

    expect(out).toMatchObject({ error: null, content: "", finish: "stop" });
    expect((await endOf(it, chatId))?.state).toBe("stopped");
    // The message stays, with the reply it had before as its first swipe and that reply's record.
    const reply = it.host.message(chatId, first.messageId ?? "");
    expect(reply.swipes).toEqual([first.content, ""]);
    expect(chatOf(it, chatId)).toEqual([ASKED, { role: "assistant", text: "", swipes: 2, record: true }]);
  });

  test("in Lumiverse, heard as its stop event while the request stays open: the turn ends, and its end names Lumiverse", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = [{ hang: true }];
    const { turn, generating } = await hanging(it, chatId);

    it.host.emit.stopped({ generationId: turn, chatId, userId: USER });
    const out = await generating;

    expect(out).toMatchObject({ error: null, content: "", finish: "stop" });
    await until(() => it.host.cancelled === 1, "the model call to be cancelled");
    expect(await endOf(it, chatId)).toMatchObject({ state: "stopped", reason: "You stopped the reply in Lumiverse." });
    expect(it.lumiverse.stops).toEqual([]);
  });
});

/** A completion request whose body says when it is first read. */
function unread(body: JsonObject, authorization: string | null): { request: Request; read(): boolean } {
  let read = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        read = true;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        controller.close();
      },
    },
    // Nothing is asked of the stream until something reads the request's body.
    { highWaterMark: 0 },
  );
  const headers: Record<string, string> = { "content-type": "application/json", host: `127.0.0.1:${PORT}`, ...(authorization !== null ? { authorization } : {}) };
  return { request: new Request(`http://127.0.0.1:${PORT}/v1/chat/completions`, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit), read: () => read };
}

describe("a request's key", () => {
  test("is checked before any of the body is read: with no key, or one of another form, the request is refused unread", async () => {
    const it = (r = await rig({ harness: noTurns }));
    await it.setUp();
    it.host.script = ["Mara met Joss at the quay."];
    const body: JsonObject = { model: "lumiah", messages: [{ role: "user", content: "Where did Mara meet Joss?" }] };
    // The key the extension mints is of the form the runtime checks.
    expect(it.key).toMatch(KEY_FORM);

    for (const authorization of [null, "Bearer sk-a-key-of-another-provider", `Bearer ${it.key.slice(0, -1)}`, `Bearer ${it.key}0`]) {
      const sent = unread(body, authorization);
      const response = await it.runtime.fetch(sent.request);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_api_key" } });
      expect(sent.read()).toBe(false);
    }

    // Whether a key of the right form is the user's own is the extension's to say, and it says so once the request reaches it.
    const forged = unread(body, `Bearer lah_${"0".repeat(64)}`);
    const refused: unknown = await (await it.runtime.fetch(forged.request)).json();
    expect(forged.read()).toBe(true);
    expect(refused).toMatchObject({ error: { message: expect.stringContaining("isn't this account's loopback key") } });
    expect(it.host.calls).toHaveLength(0);

    // With the user's key, the same request is read and answered.
    const sent = unread(body, `Bearer ${it.key}`);
    const answered = await it.runtime.fetch(sent.request);
    expect(answered.status).toBe(200);
    expect(sent.read()).toBe(true);
    expect(await answered.json()).toMatchObject({ choices: [{ message: { content: "Mara met Joss at the quay." } }] });
  });
});

describe("GET /healthz", () => {
  const ask = async (fetch: (request: Request) => Promise<Response>, host: string, authorization?: string): Promise<unknown> => (await fetch(new Request(`http://${host}/healthz`, { headers: { host, ...(authorization !== undefined ? { authorization } : {}) } }))).json();

  test("on an address other machines reach says only that the runtime is up, unless the holder of its config asks", async () => {
    const it = (r = await rig({ harness: noTurns }));
    await it.setUp();
    // The same runtime as `--listen 0.0.0.0` serves it: reached under whatever name the machine has.
    const elsewhere = runtimeFrom({ name: "mara", base: it.lumiverse.base, extension: it.lumiverse.host.identifier, listen: "0.0.0.0", port: PORT, relay: it.registration.relay, secret: it.registration.secret, session: { username: "mara", token: it.lumiverse.token, savedAt: 0 }, tuning: FAST }, it.lumiverse, [], { harness: noTurns });
    const there = `192.0.2.7:${PORT}`;

    expect(await ask(elsewhere.fetch, there)).toEqual({ up: true });
    // The loopback key is no proof: it says who may send a request, not who may watch the runtime.
    expect(await ask(elsewhere.fetch, there, `Bearer ${it.key}`)).toEqual({ up: true });
    // `lumiah status` and `up` show a hash of the secret in the runtime's config, and are told how it is.
    expect(await ask(elsewhere.fetch, there, `Bearer ${await healthProof(it.registration.secret)}`)).toEqual({ ok: true, link: "down", backend: "LumiAH", turns: 0, requests: 0 });
    elsewhere.close();

    // On the machine's own loopback address, which only that machine reaches, whoever asks is told.
    expect(await ask(it.runtime.fetch, `127.0.0.1:${PORT}`)).toEqual({ ok: true, link: "up", backend: "LumiAH", turns: 0, requests: 0 });
  });
});

const USAGE: AgentUsage = { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0 };

describe("a turn that never ends", () => {
  test("doesn't cost its chat the next reply: once that one has waited its time the stuck turn is let go, and the reply is answered", async () => {
    let turns = 0;
    const it = (r = await rig({
      harness: () => ({
        answer: async (_turn, sink) => {
          // The chat's first turn hangs for good and doesn't heed its signal; the ones after it answer.
          if (++turns === 1) return Promise.withResolvers<never>().promise;
          sink.content("Okoro keeps it now.");
          sink.done("stop", USAGE);
          return { status: "done", record: null, reply: "Okoro keeps it now.", usage: USAGE };
        },
      }),
    }));
    const chatId = await it.setUp();
    // The shortest the user may set "Wait for the earlier reply" to: the runtime takes its timings from their settings.
    await it.page.request("lah.settings.set", { set: [{ path: ["transport", "runtime", "turnWaitMs"], value: 1_000 }], reset: [] });
    const stuck = it.generate(chatId);
    await until(() => turns === 1, "the first turn to be under way");

    const asked = Date.now();
    const next = await it.generate(chatId);

    expect(next.error).toBeNull();
    expect(next.content).toBe("Okoro keeps it now.");
    // No longer than the wait (a second here), with room for a slow machine.
    expect(Date.now() - asked).toBeLessThan(4_000);
    // The stuck turn's own reply ended in words that say what became of it, and it is no turn of the runtime's any more.
    expect((await stuck).error?.message).toBe("LumiAH let this reply go: another reply was asked for in its chat, and this one hadn't stopped a second later.");
    expect(it.runtime.turns.count).toBe(0);
    expect(it.logs.some((line) => line.includes("it was let go, so the next reply could start"))).toBe(true);

    // And the chat goes on: the reply after that one waits for nothing.
    const third = await it.generate(chatId);
    expect(third.content).toBe("Okoro keeps it now.");
  }, 15_000);
});

describe("a reply asked of a runtime whose link is refused", () => {
  const NO_FALLBACK = "Nothing answers this chat in the runtime's place: once the runtime links again, send your message again.";
  const KEY = `lah_${"0".repeat(64)}`;
  const reply: JsonObject = { model: "lumiah", stream: true, messages: [{ role: "user", content: "Who keeps the harbour light now?" }], lumiah_turn: "0".repeat(32) };
  const other: JsonObject = { model: "lumiah", stream: true, messages: [{ role: "user", content: "Who keeps the harbour light now?" }] };

  /** A runtime whose hello the extension answers with `frame` (an error frame's fields, or a result's), and what each kind of request is then told. */
  async function refusedWith(frame: JsonObject): Promise<{ reply: Generated["error"]; other: Generated["error"]; status: number }> {
    const host = new FakeHost();
    const lumiverse = new FakeLumiverse(host, USER);
    host.frontend.onMessage((payload, userId, session) => {
      if (!isRecord(payload) || payload.link !== LINK || payload.type !== "hello" || typeof payload.id !== "string") return;
      host.frontend.send({ link: LINK, id: payload.id, ...frame }, userId, session);
    });
    const runtime = (alone = runtimeFor(lumiverse, { relay: "relay-1", secret: "a".repeat(64) }, [], { harness: noTurns }));
    await runtime.link.connect().catch(() => undefined);
    expect(runtime.link.refused).not.toBeNull();
    const told = await lumiverse.post(runtime.fetch, reply, { key: KEY, port: PORT });
    return { reply: told.error, other: (await lumiverse.post(runtime.fetch, other, { key: KEY, port: PORT })).error, status: told.status };
  }

  test("by LumiAH, for its link version: fails in words that say why and what the user can do about the chat, and promises nothing in the runtime's place", async () => {
    const why = versionWords(LINK_VERSION, LINK_VERSION + 1);
    const told = await refusedWith({ type: "error", code: "version", message: why });
    expect(told.status).toBe(503);
    expect(told.reply).toEqual({ message: `${why} ${NO_FALLBACK}`, code: "revoked" });
    // A request that is no chat's reply has no chat to say anything of: it is told why, and no more.
    expect(told.other).toEqual({ message: why, code: "revoked" });
  });

  test("by LumiAH, which no longer knows the runtime: says the same of the chat, after how to register the runtime again", async () => {
    const told = await refusedWith({ type: "error", code: "forbidden", message: "LumiAH doesn't know this runtime." });
    expect(told.reply?.message).toBe(`LumiAH refused this runtime (LumiAH doesn't know this runtime.) Register it again with its start line on LumiAH's Runtime page. ${NO_FALLBACK}`);
  });

  test("by the runtime itself, where LumiAH answered another link version and took the runtime as linked: says why and promises nothing", async () => {
    const told = await refusedWith({ type: "result", body: { relay: "relay-1", version: LINK_VERSION + 1, build: "newer-build", lost: [], settings: 0 } });
    expect(told.reply).toEqual({ message: versionWords(LINK_VERSION, LINK_VERSION + 1), code: "revoked" });
  });
});
