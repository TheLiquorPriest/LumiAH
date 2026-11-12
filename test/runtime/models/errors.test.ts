// A failed call rejects with the provider's own words, its HTTP status first, so the loop's reading
// of a failure (core/provider.ts) tells one that passes (a rate limit, an overloaded provider, a
// stream that dropped) from one that lasts (a refused key, an account out of credit) and from a
// refusal of native tools, as it did when Lumiverse relayed them. pi-ai never tries again on its
// own, and no key, token or header's value the runtime holds is ever in the words, whole or in part.

import { afterEach, describe, expect, test } from "bun:test";
import { isLasting, isToolRefusal, isTransient } from "../../../src/core/provider";
import type { ModelMessage, ModelTool } from "../../../src/core/ports";
import { redact } from "../../../src/runtime/models/words";
import type { Rig, Script } from "./support";
import { anthropicStream, anthropicTurn, eventStream, failed, forever, request, rig } from "./support";

const ANTHROPIC_KEY = "sk-ant-api03-Ilse0123456789abcdefOkoro";
const SERVER_KEY = "sk-proxy-0123456789abcdefghijklmnop";
const LOOKUP: ModelTool = { name: "lookup", description: "Looks a thing up.", parameters: { type: "object", properties: {} } };

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

/** The words a call fails with on an Anthropic connection whose API answers as `script` does. */
async function anthropicFailure(script: Script): Promise<Error> {
  r = rig({ script });
  await r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, ANTHROPIC_KEY);
  return r.layer.models.call(request({ messages: [{ role: "user", content: "Where is the mill?" }], stream: true }), forever()).then(
    () => {
      throw new Error("the call answered");
    },
    (error: unknown) => error as Error,
  );
}

/** The words a call with a tool fails with on an OpenAI-compatible server, sent with `headers`, that answers as `script` does. */
async function serverFailure(script: Script, headers?: Record<string, string>): Promise<Error> {
  r = rig({ script });
  await r.layer.book.save({ name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://proxy.example.com/v1", model: "served-model", ...(headers ? { headers } : {}) }, SERVER_KEY);
  return r.layer.models.call(request({ messages: [{ role: "user", content: "Look it up." }], tools: [LOOKUP] }), forever()).then(
    () => {
      throw new Error("the call answered");
    },
    (error: unknown) => error as Error,
  );
}

/** A stream that sends `head` and then breaks as a socket closing does. */
function brokenStream(head: string, why: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
      controller.error(new Error(why));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const STARTED = anthropicStream(anthropicTurn({ text: "The mill" }).slice(0, 3));

describe("a failure the loop makes again", () => {
  test("an overloaded provider (529) leads with its status and passes", async () => {
    const error = await anthropicFailure(() => failed(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    expect(error.message).toBe("529: Overloaded (overloaded_error)");
    expect([isTransient(error), isLasting(error)]).toEqual([true, false]);
  });

  test("a rate limit (429) leads with its status and passes", async () => {
    const error = await anthropicFailure(() => failed(429, { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } }));
    expect(error.message).toBe("429: Number of request tokens has exceeded your per-minute rate limit (rate_limit_error)");
    expect([isTransient(error), isLasting(error)]).toEqual([true, false]);
  });

  test("an overloaded provider that says so in the middle of its stream passes", async () => {
    const error = await anthropicFailure(() => eventStream(`${STARTED}event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`));
    expect(error.message).toBe("Overloaded (overloaded_error)");
    expect(isTransient(error)).toBe(true);
  });

  test("a stream that ends before its answer does passes", async () => {
    const error = await anthropicFailure(() => eventStream(STARTED));
    expect(error.message).toContain("stream ended");
    expect(isTransient(error)).toBe(true);
  });

  test("a connection that drops in the middle of the stream passes", async () => {
    const error = await anthropicFailure(() => brokenStream(STARTED, "The socket connection was closed unexpectedly."));
    expect(error.message).toContain("socket connection was closed");
    expect(isTransient(error)).toBe(true);
  });

  test("is asked of the provider once: pi-ai doesn't make it again on its own", async () => {
    await anthropicFailure(() => failed(503, { type: "error", error: { type: "api_error", message: "Service Unavailable" } }));
    expect(r?.sent.length).toBe(1);
  });
});

describe("a failure that lasts", () => {
  test("an account out of credit answers 429 and still lasts", async () => {
    const error = await serverFailure(() => failed(429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } }));
    expect(error.message).toBe("429: You exceeded your current quota, please check your plan and billing details. (insufficient_quota)");
    expect([isTransient(error), isLasting(error)]).toEqual([false, true]);
  });

  test("a refused key lasts, and the words never hold the key, even when the provider repeats it", async () => {
    const error = await serverFailure(() => failed(401, { error: { message: `Incorrect API key provided: ${SERVER_KEY}.`, type: "invalid_request_error", code: "invalid_api_key" } }));
    expect(error.message.startsWith("401: Incorrect API key provided: ")).toBe(true);
    expect(error.message).not.toContain(SERVER_KEY);
    expect(isLasting(error)).toBe(true);
    // The key went with the call, as the server asked.
    expect(r?.sent[0]?.headers.authorization).toBe(`Bearer ${SERVER_KEY}`);
  });
});

describe("a refusal of native tools", () => {
  test("reads as one, so the session asks again with its tools as text", async () => {
    const error = await serverFailure(() => failed(400, { error: { message: "This model does not support tools", type: "invalid_request_error" } }));
    expect(error.message).toBe("400: This model does not support tools (invalid_request_error)");
    expect(isToolRefusal(error)).toBe(true);
  });
});

describe("a call its connection can't make", () => {
  test("says what to do, and sends nothing", async () => {
    const made = rig();
    r = made;
    const keyless = await made.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" });
    const unnamed = await made.layer.book.save({ name: "No model", provider: "anthropic", auth: "key" }, ANTHROPIC_KEY);
    const ask = (connectionId: string | null) => made.layer.models.call(request({ messages: [{ role: "user", content: "Hello?" }], connectionId }), forever());
    await expect(ask(keyless.id)).rejects.toThrow('The connection "Claude" has no key: add one on the Connections page.');
    await expect(ask(unnamed.id)).rejects.toThrow('The connection "No model" names no model');
    await expect(ask("gone")).rejects.toThrow("This call's connection is no longer there");
    await made.layer.book.setDefault(null);
    await expect(ask(null)).rejects.toThrow("There is no default connection");
    expect(made.sent).toEqual([]);
  });

  test("holding what no message of its kind carries to the model is refused in words that say so, and sends nothing: media in a system message or in the model's own turn, audio or a video anywhere", async () => {
    const made = rig();
    r = made;
    await made.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, ANTHROPIC_KEY);
    const image = { type: "media", media: "image", data: "iVBORw0KGgo=", mimeType: "image/png" } as const;
    const ask = (messages: ModelMessage[]) => made.layer.models.call(request({ messages }), forever());
    const chart = "The harbour's chart.";
    // In the system prompt, and in a system message further on.
    await expect(ask([{ role: "system", content: chart, parts: [{ type: "text", text: chart }, image] }, { role: "user", content: "Where is the reef?" }])).rejects.toThrow("A system message in this call holds an image, and the runtime's model calls carry a system message's text only.");
    await expect(ask([{ role: "user", content: "Where is the reef?" }, { role: "system", content: "", parts: [{ ...image, media: "audio", mimeType: "audio/wav" }] }])).rejects.toThrow("A system message in this call holds audio");
    await expect(ask([{ role: "user", content: "Show me the reef." }, { role: "assistant", content: "", parts: [image] }, { role: "user", content: "Again." }])).rejects.toThrow("One of the model's own turns in this call holds an image, and the runtime's model calls carry only the text, reasoning and tool calls of one.");
    await expect(ask([{ role: "user", content: "", parts: [{ ...image, media: "video", mimeType: "video/mp4" }] }])).rejects.toThrow("This call holds a video, and the runtime's model calls carry text and images only.");
    expect(made.sent).toEqual([]);
  });
});

describe("words that leave the layer", () => {
  test("a header's value the provider repeats is never in them: a header may carry a gateway's credential", async () => {
    const gateway = "gw-token-Okoro0123456789abcdef";
    const error = await serverFailure(() => failed(401, { error: { message: `Unknown gateway token ${gateway}.`, type: "invalid_request_error" } }), { "x-gateway-token": gateway });
    expect(error.message).toBe("401: Unknown gateway token [secret]. (invalid_request_error)");
    expect(r?.sent[0]?.headers["x-gateway-token"]).toBe(gateway);
  });

  test("a secret that holds another is taken out whole, never half shown around the other", () => {
    const key = "sk-proxy-0123456789abcdefghijklmnop";
    const header = `Bearer ${key}-gateway-Okoro`;
    expect(redact(`401: token ${header} refused`, [key, header])).toBe("401: token [secret] refused");
  });

  test("a secret a text was cut through leaves none of its first characters behind: before pi-ai's mark of the cut, or at the text's end", () => {
    const key = "sk-proxy-0123456789abcdefghijklmnop";
    expect(redact(`401: {"message":"bad key ${key.slice(0, 20)}... [truncated 812 chars]`, [key])).toBe(`401: {"message":"bad key [secret]... [truncated 812 chars]`);
    expect(redact(`401: bad key ${key.slice(0, 14)}`, [key])).toBe("401: bad key [secret]");
    // Its first few characters alone are any key's of its kind, and stay.
    expect(redact(`401: bad key ${key.slice(0, 7)}`, [key])).toBe(`401: bad key ${key.slice(0, 7)}`);
  });
});
