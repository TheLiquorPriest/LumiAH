// What a model call spent (DESIGN §20): each provider's usage read, a count it doesn't report an
// estimate flagged as one, the cost the user's Prices give it and which price that was, on the call's
// own record too, and how calls add up to an agent's tally and a turn's.

import { describe, expect, test } from "bun:test";
import { createHarness } from "../../src/core/harness";
import type { CallUsage, ModelResult } from "../../src/core/ports";
import { AgentAccounts, type CallSpec, ProviderSession, requestOf } from "../../src/core/provider";
import { defaultSettings, type ModelPrice, type Settings } from "../../src/core/settings";
import { Texts } from "../../src/core/texts";
import { addCall, addUsage, emptyUsage, parseUsage, priced } from "../../src/core/usage";
import { call, MAIN, MemoryHost, runTurn, WRITER } from "./support/host";

const ESTIMATE = { in: 100, out: 20, reasoningOut: 5 };

describe("usage", () => {
  test("is read per provider, each count the provider doesn't report an estimate flagged as one", () => {
    expect(parseUsage({ prompt_tokens: 1200, completion_tokens: 300, provider_raw: { input_tokens: 200, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 300 } }, "anthropic", ESTIMATE)).toEqual({ in: 1200, cachedIn: 900, cacheWrite: 100, out: 300, reasoningOut: 5, estimated: ["reasoningOut"] });
    expect(parseUsage({ prompt_tokens: 500, completion_tokens: 80, total_tokens: 640 }, "google", ESTIMATE)).toEqual({ in: 500, cachedIn: 0, out: 140, reasoningOut: 60, estimated: ["cachedIn"] });
    expect(parseUsage({ prompt_tokens: 500, completion_tokens: 80, cost: 0.0042, provider_raw: { prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 30 } } }, "openrouter", ESTIMATE)).toEqual({ in: 500, cachedIn: 100, out: 80, reasoningOut: 30, estimated: [], cost: 0.0042 });
    expect(parseUsage(undefined, "openai", ESTIMATE)).toEqual({ in: 100, cachedIn: 0, out: 25, reasoningOut: 5, estimated: ["in", "cachedIn", "out", "reasoningOut"] });
  });

  test("cost is the provider's where it says, else the user's price for the model, and a tally's is known only while every call's is", () => {
    const reported = parseUsage({ prompt_tokens: 10, completion_tokens: 10, cost: 0.5 }, "openrouter", ESTIMATE);
    expect(priced(reported, ["model-a"], { "model-a": { in: 1, cachedIn: 1, out: 1 } }).cost).toBe(0.5);
    const unpriced = parseUsage({ prompt_tokens: 1_000_000, completion_tokens: 100_000 }, "openai", ESTIMATE);
    expect(priced(unpriced, ["model-b"], {})).toEqual(unpriced);
    expect(priced(unpriced, ["model-a"], { "model-a": { in: 2, cachedIn: 1, out: 10 } })).toMatchObject({ cost: 3, estimated: ["cachedIn", "reasoningOut", "cost"] });
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

describe("the price a call's cost comes from", () => {
  /** A call that sent a million tokens, its provider reporting no cost: under a price of `at(n)` it costs `n` dollars. */
  const CALL: CallUsage = { in: 1_000_000, cachedIn: 0, out: 0, reasoningOut: 0, estimated: [] };
  const at = (dollars: number): ModelPrice => ({ in: dollars, cachedIn: 0, out: 0 });

  test("is the one under the name the provider reported, else the one under the model the call asked for", () => {
    const prices = { "model-reported": at(1), "model-asked": at(2) };
    expect(priced(CALL, ["model-reported", "model-asked"], prices)).toStrictEqual({ ...CALL, cost: 1, estimated: ["cost"], pricedAs: "model-reported" });
    // The provider reported a name the user priced nothing under.
    expect(priced(CALL, ["model-elsewhere", "model-asked"], prices)).toStrictEqual({ ...CALL, cost: 2, estimated: ["cost"], pricedAs: "model-asked" });
    // The host said no name: the model the call asked for is all there is to go by.
    expect(priced(CALL, ["model-asked"], prices)).toStrictEqual({ ...CALL, cost: 2, estimated: ["cost"], pricedAs: "model-asked" });
  });

  test("a name priced as it stands comes before one that only starts with a priced name", () => {
    // The provider reported a dated name, which starts with a priced one; the call asked for a model that is priced by its whole name.
    expect(priced(CALL, ["gpt-x-2024-08-06", "harbour-relay"], { "gpt-x": at(1), "harbour-relay": at(2) })).toMatchObject({ cost: 2, pricedAs: "harbour-relay" });
  });

  test("with no name priced as it stands, is the longest priced name the reported name starts with, else the longest the asked-for name starts with", () => {
    expect(priced(CALL, ["gpt-x-2024-08-06", "harbour-relay"], { "gpt-x": at(1) })).toStrictEqual({ ...CALL, cost: 1, estimated: ["cost"], pricedAs: "gpt-x" });
    // Each starts with a priced name: the reported name's comes first, though the other's is the longer.
    expect(priced(CALL, ["gpt-x-2024-08-06", "harbour-relay-2"], { gpt: at(1), "harbour-relay": at(2) })).toMatchObject({ cost: 1, pricedAs: "gpt" });
    // Only the model the call asked for starts with a priced name.
    expect(priced(CALL, ["scripted", "harbour-relay-2"], { "harbour-relay": at(2) })).toMatchObject({ cost: 2, pricedAs: "harbour-relay" });
  });

  test("of several priced names a model's name starts with, the longest wins, in whatever order Prices holds them", () => {
    for (const names of [
      ["gpt", "gpt-x", "gpt-x-mini"],
      ["gpt-x-mini", "gpt-x", "gpt"],
      ["gpt-x", "gpt-x-mini", "gpt"],
    ]) {
      // Each priced at its name's length, so the cost says which price it was.
      const prices = Object.fromEntries(names.map((name) => [name, at(name.length)]));
      expect(priced(CALL, ["gpt-x-mini-2024-07-18"], prices)).toMatchObject({ cost: "gpt-x-mini".length, pricedAs: "gpt-x-mini" });
      expect(priced(CALL, ["gpt-x-2024-08-06"], prices)).toMatchObject({ cost: "gpt-x".length, pricedAs: "gpt-x" });
      expect(priced(CALL, ["gpt-y"], prices)).toMatchObject({ cost: "gpt".length, pricedAs: "gpt" });
    }
  });

  test("a cost the provider reported is kept, and names no price", () => {
    const reported: CallUsage = { ...CALL, cost: 0.5 };
    expect(priced(reported, ["model-a", "model-main"], { "model-a": at(9), "model-main": at(9), model: at(9) })).toStrictEqual({ ...CALL, cost: 0.5 });
  });

  test("a model the user priced nothing for stays unpriced: a longer name, a name inside it, and a price with no name are no match", () => {
    const tables: Record<string, ModelPrice>[] = [{}, { "model-b": at(1) }, { "model-a-mini": at(1) }, { "odel-a": at(1) }, { "": at(1) }];
    for (const prices of tables) expect({ prices, call: priced(CALL, ["model-a", "model-main"], prices) }).toStrictEqual({ prices, call: CALL });
  });
});

describe("the price a call's cost comes from, as a session asks for it", () => {
  const open = new AbortController().signal;

  /** The usage of one call on the main connection (its own model: `model-main`): the agent on `model` (null: the connection's), its answer reported under `reported` (undefined: the host names no model). */
  async function spent(model: string | null, reported: string | undefined, prices: Record<string, ModelPrice>): Promise<CallUsage> {
    const host = new MemoryHost();
    host.script = [{ content: "High water at six.", usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }];
    const settings = { ...defaultSettings(), prices };
    const models = {
      call: async (...sent: Parameters<MemoryHost["models"]["call"]>): Promise<ModelResult> => {
        const { model: _named, ...result } = await host.models.call(...sent);
        return reported === undefined ? result : { ...result, model: reported };
      },
    };
    const spec: CallSpec = { connectionId: MAIN, model, effort: "medium", system: "You read tide tables.", prefix: [], cache: { ...settings.cache, session: "agent_test" } };
    const session = new ProviderSession({ host: { models, connections: host.connections, clock: host.clock }, settings, texts: new Texts(), accounts: new AgentAccounts(host) }, spec);
    const p = await session.prepare([{ role: "user", content: "When is high water?" }], []);
    return (await session.send(p, requestOf(spec, p, 500, settings), open)).usage;
  }

  test("the reported name first, then the agent's model, else its connection's, then what each starts with", async () => {
    const prices = { "gpt-x": { in: 1, cachedIn: 0, out: 0 }, "relay-a": { in: 2, cachedIn: 0, out: 0 }, "model-main": { in: 3, cachedIn: 0, out: 0 } };
    // The provider's own name for the model is priced.
    expect(await spent("relay-a", "gpt-x", prices)).toMatchObject({ cost: 1, pricedAs: "gpt-x" });
    // It reports a dated name: the agent's model is priced as it stands, and comes before what the dated name starts with.
    expect(await spent("relay-a", "gpt-x-2024-08-06", prices)).toMatchObject({ cost: 2, pricedAs: "relay-a" });
    // The agent names no model, so the call asked for its connection's.
    expect(await spent(null, "scripted", prices)).toMatchObject({ cost: 3, pricedAs: "model-main" });
    // Neither name is priced as it stands: the priced name the reported one starts with.
    expect(await spent("relay-b", "gpt-x-2024-08-06", prices)).toMatchObject({ cost: 1, pricedAs: "gpt-x" });
    // The host names no model at all: the agent's own, by what it starts with.
    expect(await spent("relay-a-eu", undefined, prices)).toMatchObject({ cost: 2, pricedAs: "relay-a" });
    const unpriced = await spent("relay-b", "scripted", prices);
    expect({ cost: unpriced.cost, pricedAs: unpriced.pricedAs, estimated: unpriced.estimated }).toStrictEqual({ cost: undefined, pricedAs: undefined, estimated: ["cachedIn", "reasoningOut"] });
  });
});

describe("the price a call's cost comes from, on the turn's record", () => {
  test("the trace's usage event and the transcript's answer say which price it was, and name none for a call no price matched", async () => {
    const host = new MemoryHost();
    // The main agent's provider reports a dated name for the connection's model; the writer's model has no price.
    host.script = [{ toolCalls: [call("write_reply", { brief: "Okoro opens the door a hand's width." }, "c1")], model: "model-main-2026-01-15" }, "The door opens a hand's width."];
    host.say("chat-1", "user", "I knock at the lighthouse door.");
    const stored: { values: Settings; texts: Record<string, string> } = { values: defaultSettings(), texts: {} };
    stored.values.agents.writer!.connectionId = WRITER;
    stored.values.prices = { "model-main": { in: 2, cachedIn: 0, out: 10 } };
    const harness = createHarness(host, { settings: async () => structuredClone(stored) });
    expect((await runTurn(host, harness, "chat-1")).result.status).toBe("done");
    const events = host.traced.map((record) => record.event);
    expect(events.flatMap((e) => (e.kind === "usage" ? [{ model: e.model, pricedAs: e.call.pricedAs, priced: e.call.cost !== undefined }] : []))).toStrictEqual([
      { model: "model-main-2026-01-15", pricedAs: "model-main", priced: true },
      { model: "scripted", pricedAs: undefined, priced: false },
    ]);
    expect(events.flatMap((e) => (e.kind === "agent_entry" && e.entry.kind === "answer" ? [{ model: e.entry.model, pricedAs: e.entry.usage.pricedAs, priced: e.entry.usage.cost !== undefined }] : []))).toStrictEqual([
      { model: "model-main-2026-01-15", pricedAs: "model-main", priced: true },
      { model: "scripted", pricedAs: undefined, priced: false },
    ]);
  });
});
