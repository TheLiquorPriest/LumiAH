// What leaves the runtime with a call goes where its connection says, and nowhere else: no variable
// of the environment signs it, steers it or adds to it; no redirect takes its key or its headers to
// another address; and a stream that goes silent once its answer has begun is ended in words that
// say so, while a model slow to begin is left to begin.

import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { isTransient } from "../../../src/core/provider";
import { SILENT_MS } from "../../../src/runtime/models/call";
import type { Rig, Sent } from "./support";
import { anthropicStream, anthropicTurn, failed, forever, request, rig, scriptedFetch } from "./support";

const KEY = "sk-ant-api03-Ilse0123456789abcdefWXYZ";
const SERVER_KEY = "sk-proxy-0123456789abcdefghijklmnop";
const GOOGLE_KEY = "gemini-fake-key-0123456789abcdef";
const GATEWAY = "gw-token-Okoro0123456789abcdef";

let r: Rig | undefined;
const after: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of after.splice(0).reverse()) await undo();
  await r?.done();
  r = undefined;
});

/** Sets variables in the process's own environment, as a shell that exported them would, until the test ends. */
function exported(values: Record<string, string>): void {
  const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  after.push(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

/** Answers the requests that go out through the process's own fetch (Google's client takes no other), until the test ends. */
function globalFetch(answer: (sent: Sent) => Response): Sent[] {
  const { fetch, sent } = scriptedFetch(answer);
  const real = globalThis.fetch;
  globalThis.fetch = fetch;
  after.push(() => {
    globalThis.fetch = real;
  });
  return sent;
}

/** A response whose body the test writes as it goes: each `send` resolves once the reader has taken everything sent so far. */
function heldStream(): { response: Response; send(text: string): Promise<void>; end(): void } {
  let control: ReadableStreamDefaultController<Uint8Array> | undefined;
  let taken: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        control = c;
      },
      pull() {
        taken?.();
        taken = undefined;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    send(text) {
      const { promise, resolve } = Promise.withResolvers<void>();
      taken = resolve;
      control?.enqueue(new TextEncoder().encode(text));
      return promise;
    },
    end() {
      control?.close();
    },
  };
}

/** A whole Anthropic answer of `text`, as its events: [start, block start, first piece, …the rest]. */
const ANSWER = anthropicTurn({ text: "The mill is closed." });
const event = (...events: Record<string, unknown>[]): string => anthropicStream(events);
/** A keep-alive Anthropic sends while a call is open, which pi-ai passes on as nothing. */
const PING = event({ type: "ping" });

describe("the environment", () => {
  test("what the SDKs would read in it for themselves is taken out as the layer is made, in one line of the log that names it and never its value", () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_CUSTOM_HEADERS: "x-api-key: sk-ant-env-0123456789abcdef", OPENAI_ORG_ID: "org-env-0123456789", PI_OAUTH_CALLBACK_HOST: "0.0.0.0", PATH: "/usr/bin", LANG: "en_GB.UTF-8" };
    r = rig({ env });
    expect(env).toEqual({ PATH: "/usr/bin", LANG: "en_GB.UTF-8" });
    expect(r.logs).toEqual(["took out of the runtime's environment what would sign or steer its model calls and sign-ins: ANTHROPIC_CUSTOM_HEADERS, OPENAI_ORG_ID, PI_OAUTH_CALLBACK_HOST"]);
  });

  test("a runtime started from a shell that exports them makes its calls as its connections say: no header, organization or project of the environment's, and Gemini's API, not Vertex", async () => {
    exported({
      ANTHROPIC_CUSTOM_HEADERS: "x-api-key: sk-ant-env-stolen-0123456789\nx-gateway-token: env-gateway-0123456789",
      OPENAI_CUSTOM_HEADERS: "x-team: env-team",
      OPENAI_ORG_ID: "org-env-0123456789",
      OPENAI_PROJECT_ID: "proj_env_0123456789",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_GEMINI_BASE_URL: "https://gemini-env.example",
    });
    const made = rig({ script: (sent) => (sent.url.includes("/v1/messages") ? new Response(event(...ANSWER), { status: 200, headers: { "content-type": "text/event-stream" } }) : failed(400, { error: { message: "scripted", type: "invalid_request_error" } })) });
    r = made;
    expect(process.env.OPENAI_ORG_ID).toBeUndefined();
    const claude = await made.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const proxy = await made.layer.book.save({ name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://proxy.example.com/v1", model: "served-model" }, SERVER_KEY);
    const gemini = await made.layer.book.save({ name: "Gemini", provider: "google", auth: "key", model: "gemini-2.5-flash" }, GOOGLE_KEY);
    const ask = (connectionId: string) => made.layer.models.call(request({ messages: [{ role: "user", content: "Where is Ilse?" }], connectionId }), forever());

    await ask(claude.id);
    await expect(ask(proxy.id)).rejects.toThrow("400: scripted");
    const google = globalFetch(() => failed(400, { error: { code: 400, message: "scripted", status: "INVALID_ARGUMENT" } }));
    await expect(ask(gemini.id)).rejects.toThrow("scripted");

    const [anthropic, compatible] = made.sent;
    expect(anthropic?.headers["x-api-key"]).toBe(KEY);
    expect(anthropic?.headers["x-gateway-token"]).toBeUndefined();
    expect(Object.keys(compatible?.headers ?? {}).filter((name) => /^(?:openai-organization|openai-project|x-team)$/.test(name))).toEqual([]);
    expect(compatible?.headers.authorization).toBe(`Bearer ${SERVER_KEY}`);
    expect(google.map((s) => [new URL(s.url).host, new URL(s.url).pathname, Object.values(s.headers).filter((value) => value === GOOGLE_KEY).length])).toEqual([["generativelanguage.googleapis.com", "/v1beta/models/gemini-2.5-flash:streamGenerateContent", 1]]);
  });
});

describe("redirects", () => {
  test("neither a call nor a list of models follows one: the key and the headers stay with the address they were given for", async () => {
    const reached: string[] = [];
    const away = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (reached.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("authorization") ?? ""} ${req.headers.get("x-gateway-token") ?? ""}`), new Response("{}")) });
    const mover = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${away.port}${new URL(req.url).pathname}` } }) });
    after.push(() => {
      away.stop(true);
      mover.stop(true);
    });
    const made = rig({ fetch: globalThis.fetch });
    r = made;
    const saved = await made.layer.book.save({ name: "Moved", provider: "openai-compatible", auth: "key", baseUrl: `http://127.0.0.1:${mover.port}/v1`, model: "served-model", headers: { "x-gateway-token": GATEWAY } }, SERVER_KEY);
    const redirected = "the server answered with a redirect to another address, which the runtime doesn't follow, so that the connection's key and headers never go with it: give the connection the address it moved to.";
    await expect(made.layer.modelsOf(saved.id)).rejects.toThrow(`The server didn't list its models: ${redirected}`);
    await expect(made.layer.models.call(request({ messages: [{ role: "user", content: "Where is Ilse?" }], connectionId: saved.id }), forever())).rejects.toThrow(`The call wasn't made: ${redirected}`);
    expect(reached).toEqual([]);
  });
});

describe("a stream that goes silent", () => {
  test("is ended once its answer has begun and nothing more comes for the wait, in words the loop makes again", async () => {
    const held = heldStream();
    const made = rig({ script: () => held.response });
    r = made;
    await made.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const began = Promise.withResolvers<void>();
    const call = made.layer.models.call(request({ messages: [{ role: "user", content: "Is the mill open?" }], stream: true }), forever(), () => began.resolve()).then(
      () => new Error("the call answered"),
      (error: unknown) => error as Error,
    );
    await held.send(event(...ANSWER.slice(0, 3)));
    await began.promise;
    made.advance(SILENT_MS);
    made.timers.fireAll();
    const error = await call;
    expect(error.message).toBe("The model went silent: nothing came from its server for 5 minutes after its answer began, so the stream was ended. Silent answer ends after (LumiAH's Settings → Timeouts → A model call) says how long an answer may go silent.");
    expect(isTransient(error)).toBe(true);
  });

  test("a model slow to begin is left to begin, a keep-alive counts as life, and the wait is the one the layer is given", async () => {
    const held = heldStream();
    const made = rig({ script: () => held.response, silentMs: 30_000 });
    r = made;
    await made.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const began = Promise.withResolvers<void>();
    const call = made.layer.models.call(request({ messages: [{ role: "user", content: "Is the mill open?" }], stream: true }), forever(), () => began.resolve());
    // The call is open and the model still reads its prompt: nothing waits on it yet, however long that takes.
    await held.send(event(...ANSWER.slice(0, 1)) + PING);
    made.advance(10 * 30_000);
    expect(made.timers.pending.size).toBe(0);
    await held.send(event(...ANSWER.slice(1, 3)));
    await began.promise;
    // Twenty seconds in a keep-alive comes, and twenty seconds after it the wait looks again: the stream is alive.
    made.advance(20_000);
    await held.send(PING);
    made.advance(20_000);
    made.timers.fireAll();
    expect(made.timers.pending.size).toBe(1);
    await held.send(event(...ANSWER.slice(3)));
    held.end();
    expect((await call).content).toBe("The mill is closed.");
    // The call's end lets its wait go.
    expect(made.timers.pending.size).toBe(0);
  });
});

describe("the wait for a silent stream", () => {
  test("a wait of none, or of what isn't a length, sets no limit at all", async () => {
    for (const silentMs of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const faux = fauxProvider({ provider: "groq", models: [{ id: "faux-1" }], tokenSize: { min: 1, max: 1 } });
      faux.setResponses([fauxAssistantMessage("The mill is closed.")]);
      const made = rig({ providers: [faux.provider], silentMs });
      await made.layer.book.save({ name: "Groq", provider: "groq", auth: "key", model: "faux-1" }, "gsk_0123456789abcdefghij");
      // What waits while the answer streams.
      const waiting: number[] = [];
      await made.layer.models.call(request({ messages: [{ role: "user", content: "Is the mill open?" }], stream: true }), forever(), () => waiting.push(made.timers.pending.size));
      await made.done();
      expect({ wait: String(silentMs), timers: Math.max(...waiting) }).toEqual({ wait: String(silentMs), timers: 0 });
    }
  });
});
