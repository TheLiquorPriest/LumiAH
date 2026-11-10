// The provider session's parts that stand alone: recovering the tool calls a model writes as text,
// telling a refusal of native tools and a failure that passes from any other failure, a connection's
// calls at once, reading each provider's usage, and ranking a search.

import { describe, expect, test } from "bun:test";
import { excerptOf, LexicalIndex, tokenize } from "../../src/core/lexical";
import { AgentAccounts, assemble, isToolRefusal, isTransient, ownBreakpoints, recoverToolCalls } from "../../src/core/provider";
import type { Settings } from "../../src/core/settings";
import { addCall, addUsage, emptyUsage, parseUsage, priced } from "../../src/core/usage";
import { MemoryHost, settle } from "./support/host";

const NAMES = new Set(["lookup", "chat_read"]);
const ESTIMATE = { in: 100, out: 20, reasoningOut: 5 };

describe("calls written as text", () => {
  test("are recovered in the forms models write them, and taken out of the text", () => {
    expect(recoverToolCalls('I will look.\n<tool_call>{"name": "lookup", "arguments": {"q": "tide"}}</tool_call>', NAMES)).toEqual({ calls: [{ name: "lookup", args: { q: "tide" } }], rest: "I will look." });
    expect(recoverToolCalls('<function_calls><invoke name="chat_read"><parameter name="from">12</parameter><parameter name="note">the quay</parameter></invoke></function_calls>', NAMES)).toEqual({ calls: [{ name: "chat_read", args: { from: 12, note: "the quay" } }], rest: "" });
    expect(recoverToolCalls('<function=lookup>{"q": "mill"}</function>', NAMES).calls).toEqual([{ name: "lookup", args: { q: "mill" } }]);
    expect(recoverToolCalls('[TOOL_CALLS] [{"name": "lookup", "arguments": {"q": "a"}}, {"name": "chat_read", "arguments": {"from": 3}}]', NAMES).calls).toHaveLength(2);
    expect(recoverToolCalls('```json\n{"tool": "lookup", "input": {"q": "nets"}}\n```', NAMES).calls).toEqual([{ name: "lookup", args: { q: "nets" } }]);
    expect(recoverToolCalls('{"name": "lookup", "arguments": "{\\"q\\": \\"floats\\"}"}', NAMES)).toEqual({ calls: [{ name: "lookup", args: { q: "floats" } }], rest: "" });
    expect(recoverToolCalls("<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>lookup\n```json\n{\"q\": \"lamp\"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>", NAMES)).toEqual({ calls: [{ name: "lookup", args: { q: "lamp" } }], rest: "" });
  });

  test("a block that names another tool, or isn't a call, stays in the text", () => {
    const other = '<tool_call>{"name": "format_disk", "arguments": {}}</tool_call>';
    expect(recoverToolCalls(other, NAMES)).toEqual({ calls: [], rest: other });
    const data = '```json\n{"name": "lookup", "description": "A tool, described."}\n```';
    expect(recoverToolCalls(data, NAMES)).toEqual({ calls: [], rest: data });
    expect(recoverToolCalls("Ilse said: look it up.", NAMES)).toEqual({ calls: [], rest: "Ilse said: look it up." });
  });
});

describe("a refusal of native tools", () => {
  test("is read from the provider's own words, in the error or its cause", () => {
    for (const words of ["400: this model does not support tools", "No endpoints found that support tool use", "Function calling is not enabled for this model", "tools param requires --jinja flag", "Unsupported parameter: 'tools'", '"auto" tool choice requires --enable-auto-tool-choice']) expect({ words, refusal: isToolRefusal(new Error(words)) }).toEqual({ words, refusal: true });
    expect(isToolRefusal(new Error("the call failed", { cause: new Error("tool use is not supported") }))).toBe(true);
    for (const words of ["503: overloaded", "rate limit reached", "the tool lookup failed: no shelf", "context length exceeded"]) expect({ words, refusal: isToolRefusal(new Error(words)) }).toEqual({ words, refusal: false });
  });
});

describe("a failure that passes", () => {
  test("is read from the words of whoever reports it, in the error or its cause", () => {
    const passing = [
      "503: overloaded",
      "HTTP 502 Bad Gateway",
      "Request failed with status code 500",
      "Error: 429 Too Many Requests",
      "error code: 524",
      "rate_limit_exceeded: slow down",
      "overloaded_error",
      "The request timed out",
      "Gateway Timeout",
      "ETIMEDOUT",
      "read ECONNRESET",
      "socket hang up",
      "fetch failed",
      "terminated",
      "the stream was cut",
      "Stream ended unexpectedly",
      "RESOURCE_EXHAUSTED: quota exceeded for requests per minute",
      "The socket connection was closed unexpectedly",
      "Unable to connect. Is the computer able to access the url?",
      "ConnectionRefused",
      "Connection error.",
      "The operation timed out",
    ];
    for (const words of passing) expect({ words, passes: isTransient(new Error(words)) }).toEqual({ words, passes: true });
    expect(isTransient(new Error("the call failed", { cause: new Error("other side closed") }))).toBe(true);
  });

  test("a failure that would fail the same way again isn't one, whatever number it carries", () => {
    const lasting = [
      "401: the key was refused",
      "400: this model does not support tools",
      "400: max_tokens 512 is more than this model allows",
      "This model's maximum context length is 8192 tokens, and you asked for 8500",
      "429: You exceeded your current quota, please check your plan and billing details",
      "insufficient_quota",
      "402: payment required",
      "content policy: the request was refused",
      "the connection conn-gone no longer exists: give this agent another in LumiAH's Settings",
    ];
    for (const words of lasting) expect({ words, passes: isTransient(new Error(words)) }).toEqual({ words, passes: false });
  });
});

describe("a connection's calls at once", () => {
  const CONN = "conn-a";
  const limits = (every: number | null, own?: number): Settings["connections"] => ({ atOnce: every, throttles: own === undefined ? {} : { [CONN]: { requestsPerMinute: null, tokensPerMinute: null, atOnce: own } } });
  const open = new AbortController().signal;

  /** Accounts whose calls say when each got its place. */
  function line() {
    const accounts = new AgentAccounts(new MemoryHost());
    const got: string[] = [];
    const take = async (name: string, settings: Settings["connections"], signal: AbortSignal = open): Promise<() => void> => {
      const release = await accounts.atOnce(CONN, settings, signal);
      got.push(name);
      return release;
    };
    return { got, take };
  }

  test("never more than the limit hold a place, and a place freed goes to the call that waited longest", async () => {
    const { got, take } = line();
    const two = limits(2);
    const a = await take("a", two);
    const b = await take("b", two);
    const c = take("c", two);
    const d = take("d", two);
    await settle();
    expect(got).toEqual(["a", "b"]);
    a();
    // A call that comes just as a place frees never takes it ahead of the line.
    const e = take("e", two);
    await settle();
    expect(got).toEqual(["a", "b", "c"]);
    // A release frees its place once, however often it is called.
    a();
    await settle();
    expect(got).toEqual(["a", "b", "c"]);
    b();
    await settle();
    expect(got).toEqual(["a", "b", "c", "d"]);
    (await c)();
    (await d)();
    await settle();
    expect(got).toEqual(["a", "b", "c", "d", "e"]);
    (await e)();
  });

  test("a call whose signal aborts while it waits leaves the line and takes no place", async () => {
    const { got, take } = line();
    const one = limits(1);
    const a = await take("a", one);
    const gone = new AbortController();
    const b = take("b", one, gone.signal);
    const c = take("c", one);
    await settle();
    gone.abort(new Error("stopped while waiting"));
    await expect(b).rejects.toThrow("stopped while waiting");
    a();
    await settle();
    expect(got).toEqual(["a", "c"]);
    (await c)();
  });

  test("a connection's own limit stands in for every connection's; with none, nothing waits; and a limit raised lets the line through", async () => {
    const { got, take } = line();
    const a = await take("a", limits(5, 1));
    const b = take("b", limits(5, 1));
    await settle();
    expect(got).toEqual(["a"]);
    // Settings changed while b waits: the next call to come reads the new limit, and b goes first.
    const c = take("c", limits(5, 3));
    await settle();
    expect(got).toEqual(["a", "b", "c"]);
    for (const release of [a, await b, await c]) release();
    const free = line();
    for (const name of ["x", "y", "z"]) await free.take(name, limits(null));
    expect(free.got).toEqual(["x", "y", "z"]);
  });
});

describe("a prompt's order and its breakpoints", () => {
  test("the opening goes first as one system message; with no opening the conversation goes as it came", () => {
    const conversation = [{ role: "user" as const, content: "Hello?" }];
    expect(assemble({ nonce: null, prefix: ["Guidance."], system: "Instructions.", tools: null }, conversation, 0)).toEqual([{ role: "system", content: "Guidance.\n\nInstructions." }, ...conversation]);
    expect(assemble({ nonce: null, prefix: [], system: "", tools: null }, conversation, 4)).toEqual(conversation);
  });

  test("a connection's own caching counts against the provider's limit", () => {
    expect(ownBreakpoints({ limit: 4, system: true, lastMessage: true, tools: true, automatic: false }, 3)).toBe(3);
    expect(ownBreakpoints({ limit: 4, system: true, lastMessage: false, tools: true, automatic: false }, 0)).toBe(1);
  });
});

describe("usage", () => {
  test("is read per provider, each count the provider doesn't report an estimate flagged as one", () => {
    expect(parseUsage({ prompt_tokens: 1200, completion_tokens: 300, provider_raw: { input_tokens: 200, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 300 } }, "anthropic", ESTIMATE)).toEqual({ in: 1200, cachedIn: 900, cacheWrite: 100, out: 300, reasoningOut: 5, estimated: ["reasoningOut"] });
    expect(parseUsage({ prompt_tokens: 500, completion_tokens: 80, total_tokens: 640 }, "google", ESTIMATE)).toEqual({ in: 500, cachedIn: 0, out: 140, reasoningOut: 60, estimated: ["cachedIn"] });
    expect(parseUsage({ prompt_tokens: 500, completion_tokens: 80, cost: 0.0042, provider_raw: { prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 30 } } }, "openrouter", ESTIMATE)).toEqual({ in: 500, cachedIn: 100, out: 80, reasoningOut: 30, estimated: [], cost: 0.0042 });
    expect(parseUsage(undefined, "openai", ESTIMATE)).toEqual({ in: 100, cachedIn: 0, out: 25, reasoningOut: 5, estimated: ["in", "cachedIn", "out", "reasoningOut"] });
  });

  test("cost is the provider's where it says, else the user's price for the model, and a tally's is known only while every call's is", () => {
    const reported = parseUsage({ prompt_tokens: 10, completion_tokens: 10, cost: 0.5 }, "openrouter", ESTIMATE);
    expect(priced(reported, "model-a", { "model-a": { in: 1, cachedIn: 1, out: 1 } }).cost).toBe(0.5);
    const unpriced = parseUsage({ prompt_tokens: 1_000_000, completion_tokens: 100_000 }, "openai", ESTIMATE);
    expect(priced(unpriced, "model-b", {})).toEqual(unpriced);
    expect(priced(unpriced, "model-a", { "model-a": { in: 2, cachedIn: 1, out: 10 } })).toMatchObject({ cost: 3, estimated: ["cachedIn", "reasoningOut", "cost"] });
    const tally = emptyUsage();
    addCall(reported, 100, tally);
    expect(tally).toMatchObject({ calls: 1, cost: 0.5, ms: 100 });
    addCall(unpriced, 50, tally);
    expect(tally.cost).toBeUndefined();
    const turn = emptyUsage();
    addUsage(turn, tally);
    expect(turn).toMatchObject({ calls: 2, in: 1_000_010 });
    expect(turn.cost).toBeUndefined();
  });
});

describe("the lexical index", () => {
  test("ranks what says the query's rarest words first, whatever their endings", () => {
    const index = new LexicalIndex<string>(600);
    index.add("a", "The boats came back at dusk with empty nets.");
    index.add("b", "Okoro counted the lamps and trimmed each wick.");
    index.add("c", "A boat without nets is only a hull.");
    expect(tokenize("The boats' nets")).toEqual(["boat", "net"]);
    expect(index.search("lamp wick").map((h) => h.key)).toEqual(["b"]);
    expect(new Set(index.search("boat nets").map((h) => h.key))).toEqual(new Set(["a", "c"]));
    expect(index.search("the and of")).toEqual([]);
  });

  test("a long text is indexed in pieces, and a hit shows the piece that matched", () => {
    const text = `${"The tide runs out over the flats. ".repeat(40)}\nBrann found the anchor under the third pier.\n${"The gulls wheel above the sheds. ".repeat(40)}`;
    const index = new LexicalIndex<number>(300);
    index.add(0, text);
    expect(index.count).toBeGreaterThan(5);
    const [hit] = index.search("anchor pier");
    expect(excerptOf(text, hit!.piece, 400)).toContain("Brann found the anchor under the third pier.");
    expect(excerptOf(text, hit!.piece, 30).length).toBeLessThanOrEqual(31);
  });
});
