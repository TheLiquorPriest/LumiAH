// Spend where the calls are made (DESIGN §20), on an in-memory host and a scripted model: every
// model call that reached its connection is on the spend record, those that brought no answer
// among them; a cap on a day's spend is asked about the call about to be made, with what the calls
// under way hold; and a cap stops agents' work, never the writer's call of the user's reply.

import { describe, expect, test } from "bun:test";
import { createHarness } from "../../src/core/harness";
import { type AgentDeps, type AgentSpec, AgentTurn, startAgent } from "../../src/core/loop";
import type { ModelRequest } from "../../src/core/ports";
import { AgentAccounts, AgentStop } from "../../src/core/provider";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { Spend } from "../../src/core/spend";
import { TEXT, Texts } from "../../src/core/texts";
import { call, MAIN, MemoryHost, runTurn, type Script, until } from "./support/host";

const CHAT = "chat-1";
const reply = call("write_reply", { brief: "Okoro opens the door." }, "w1");
/** The writer is the one caller that is sent no tools. */
const isWriter = (request: ModelRequest): boolean => !request.tools;

/** A host with a short chat and a harness over it, whose settings the test changes. */
function rig(script: Script, change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  host.script = script;
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I walk down to the lighthouse and knock.");
  const stored = { values: defaultSettings(), texts: {} };
  change(stored.values);
  const harness = createHarness(host, { settings: async () => structuredClone(stored) });
  return { host, harness };
}

describe("every model call made is on the spend record", () => {
  test("a call the user stopped while it was under way is there, beside the one that answered", async () => {
    const r = rig((request) => (isWriter(request) ? { hang: true } : { toolCalls: [reply], usage: { prompt_tokens: 800, completion_tokens: 30 } }));
    const stop = new AbortController();
    const turn = runTurn(r.host, r.harness, CHAT, { signal: stop.signal });
    await until(() => r.host.calls.some(isWriter));
    stop.abort(new Error("stopped by the user"));
    expect((await turn).result.status).toBe("stopped");
    const spent = await r.harness.spend.get({ days: 1 });
    expect(r.host.calls).toHaveLength(2);
    expect(spent.agents.map((row) => [row.key, row.calls]).sort()).toEqual([["main", 1], ["writer", 1]]);
    // What the stopped call spent is the runtime's own estimate of the prompt it sent: its provider reported nothing.
    expect(spent.agents.find((row) => row.key === "writer")?.in).toBeGreaterThan(0);
    expect(spent.total.calls).toBe(2);
  });

  test("each try of a call that is made again is there, and so is a call that failed for good; the turn's own usage counts the calls that answered", async () => {
    let main = 0;
    const again = rig(
      (request) => (isWriter(request) ? "The door opens." : main++ === 0 ? { error: "503: overloaded" } : { toolCalls: [reply], usage: { prompt_tokens: 800, completion_tokens: 30 } }),
      (s) => (s.loop.retryWaitMs = 0),
    );
    const { result } = await runTurn(again.host, again.harness, CHAT);
    expect(result).toMatchObject({ status: "done", reply: "The door opens." });
    expect(again.host.calls).toHaveLength(3);
    const spent = await again.harness.spend.get({ days: 1 });
    expect(spent.agents.map((row) => [row.key, row.calls]).sort()).toEqual([["main", 2], ["writer", 1]]);
    // The try that failed counts its prompt as estimated, over the 800 tokens the try that answered reported.
    expect(spent.agents.find((row) => row.key === "main")?.in).toBeGreaterThan(800);
    expect(result.usage.calls).toBe(2);

    const failed = rig(
      (request) => (isWriter(request) ? "The door opens." : { error: "400: no such model" }),
      (s) => (s.loop.retries = 0),
    );
    await runTurn(failed.host, failed.harness, CHAT);
    expect((await failed.harness.spend.get({ days: 1 })).total.calls).toBe(failed.host.calls.length);
    expect(failed.host.calls.filter((request) => !isWriter(request))).toHaveLength(1);
  });

  test("a call that never reached its connection spent nothing, and is on no record", async () => {
    // The connection takes fewer tokens a minute than a prompt holds: each call is refused before it is sent.
    const r = rig(
      () => "The door opens.",
      (s) => (s.connections.throttles[MAIN] = { requestsPerMinute: null, tokensPerMinute: 50, atOnce: null }),
    );
    await runTurn(r.host, r.harness, CHAT);
    expect(r.host.calls).toHaveLength(0);
    expect((await r.harness.spend.get({ days: 1 })).total.calls).toBe(0);
  });
});

describe("a cap is asked about the call about to be made", () => {
  test("a call whose own prompt would take the day past Tokens per day isn't made; the writer's call of the reply is, and is recorded", async () => {
    const r = rig(
      (request) => (isWriter(request) ? { content: "The door opens.", usage: { prompt_tokens: 600, completion_tokens: 20 } } : { toolCalls: [reply] }),
      (s) => (s.spend.tokensPerDay = 50),
    );
    const first = await runTurn(r.host, r.harness, CHAT);
    // The main agent's first prompt alone is far past 50 tokens: it is stopped before anything is sent, in words that say the call would pass the cap.
    expect(r.host.calls.filter((request) => !isWriter(request))).toHaveLength(0);
    expect(JSON.stringify(r.host.traced)).toContain("the call would take what every agent's calls sent and wrote in the last 24 hours past Tokens per day (Settings → Spend): counted as ");
    // A cap stops agents' work, never the reply: the writer writes from the request alone, and its call is on the record.
    expect(first.result).toMatchObject({ status: "done", reply: "The door opens." });
    expect(r.host.calls.filter(isWriter)).toHaveLength(1);
    expect((await r.harness.spend.get({ days: 1 })).agents.map((row) => [row.key, row.calls, row.in])).toEqual([["writer", 1, 600]]);

    // The day is past its cap now, and the user still gets the next reply.
    r.host.say(CHAT, "user", "I knock again.");
    const second = await runTurn(r.host, r.harness, CHAT);
    expect(second.result).toMatchObject({ status: "done", reply: "The door opens." });
    expect(r.host.calls.every(isWriter)).toBe(true);
    expect(JSON.stringify(r.host.traced)).toContain("is counted as 620 tokens of the 50 Tokens per day (Settings → Spend) allows");
    expect((await r.harness.spend.get({ days: 1 })).total).toMatchObject({ calls: 2, in: 1200 });
  });

  test("with the calls under way: each holds its estimate against the caps until it is let go, in tokens, in cost and for the jobs' own cap", () => {
    const host = new MemoryHost();
    const settings = defaultSettings();
    settings.spend.tokensPerDay = 1000;
    settings.spend.costPerDay = 0.5;
    settings.jobs.tokensPerDay = 800;
    const spend = new Spend(host, () => settings);
    const texts = new Texts();
    // One call alone is under every cap, to the last token; one token more is not.
    expect(spend.refusal({ job: false, texts, tokens: 1000, cost: 0.2 })).toBeNull();
    expect(spend.refusal({ job: false, texts, tokens: 1001, cost: 0.2 })?.code).toBe("spend");
    // A second agent asking while the first's call is under way is told what the two would come to.
    const letGo = spend.hold({ job: false, tokens: 600, cost: 0.2 });
    expect(spend.refusal({ job: false, texts, tokens: 600, cost: 0.2 })?.message).toBe("the call would take what every agent's calls sent and wrote in the last 24 hours past Tokens per day (Settings → Spend): counted as 1200 tokens with it, of the 1000 allowed (a cached re-read counts as 0.1 of a token)");
    expect(spend.refusal({ job: false, texts, tokens: 300, cost: 0.4 })?.message).toBe("the call would take what every agent's calls cost in the last 24 hours past Cost per day (Settings → Spend): about $0.60 with it, and it allows $0.50");
    expect(spend.refusal({ job: false, texts, tokens: 300, cost: 0.2 })).toBeNull();
    // Let go, once or twice over, it holds nothing.
    letGo();
    letGo();
    expect(spend.refusal({ job: false, texts, tokens: 600, cost: 0.2 })).toBeNull();
    // The jobs' own cap is asked about a job's call, and only a job's.
    expect(spend.refusal({ job: true, texts, tokens: 900 })?.message).toBe("the call would take what jobs sent and wrote in the last 24 hours past Job tokens per day (Settings → Jobs): counted as 900 tokens with it, of the 800 allowed (a cached re-read counts as 0.1 of a token)");
    expect(spend.refusal({ job: false, texts, tokens: 900 })).toBeNull();
    const jobs = spend.hold({ job: true, tokens: 500, cost: 0 });
    expect(spend.refusal({ job: true, texts, tokens: 400 })?.code).toBe("spend");
    expect(spend.refusal({ job: false, texts, tokens: 400 })).toBeNull();
    jobs();
    expect(spend.refusal({ job: true, texts, tokens: 400 })).toBeNull();
  });

  test("the loop asks about each call with its prompt's estimate and its model, holds while the call is under way, and lets go when it answered and when it failed; a call that is always made is said to be", async () => {
    const host = new MemoryHost();
    host.script = [{ toolCalls: [call("lookup", {}, "c1")] }, { error: "400: no such model" }];
    const settings = defaultSettings();
    settings.loop.retries = 0;
    const turn = new AgentTurn(settings.turn, host.clock.now());
    const asked: { estimate: number; model: string; always: boolean }[] = [];
    /** How many calls hold the cap now, and the most that did at once. */
    const held = { now: 0, most: 0, atCall: [] as number[] };
    turn.limits = (about) => {
      asked.push(about);
      held.now += 1;
      held.most = Math.max(held.most, held.now);
      let let_go = false;
      return () => {
        if (!let_go) held.now -= 1;
        let_go = true;
      };
    };
    const deps: AgentDeps = { host, settings, texts: new Texts({}), accounts: new AgentAccounts(host), turn };
    const lookup = { name: "lookup", description: "Looks a thing up.", parameters: { type: "object", properties: {} }, run: async () => ({ text: `held while the tool ran: ${held.now}` }) };
    const spec: AgentSpec = { role: "main", connectionId: MAIN, model: null, effort: "medium", system: "You look things up.", prefix: [], tools: [lookup], budget: { ...settings.agents.main!.budget } };
    const first = await startAgent(spec, deps).send("go");
    expect(first).toMatchObject({ status: "failed" });
    expect(asked).toHaveLength(2);
    expect(asked.map((about) => [about.always, typeof about.model, about.estimate > 0])).toEqual([[false, "string", true], [false, "string", true]]);
    // Let go once the first call was on the record (nothing was held while its tool ran), and after the call that failed.
    expect(JSON.stringify(host.calls[1]?.messages)).toContain("held while the tool ran: 0");
    expect(held).toMatchObject({ now: 0, most: 1 });

    // An agent whose calls are made whatever the cap says is asked as such: a cap that answers it with a stop anyway shows the question, not this agent's exemption, which is the run's to honour.
    const always: boolean[] = [];
    turn.limits = (about) => {
      always.push(about.always);
      return about.always ? null : new AgentStop("spend", { id: TEXT.spend.stopTokens, vars: { tokens: "60 tokens", limit: "50", weight: "0.1" } });
    };
    host.script = () => "The door opens.";
    expect(await startAgent({ ...spec, tools: [], uncapped: true }, deps).send("write")).toMatchObject({ status: "answered", text: "The door opens." });
    expect(await startAgent({ ...spec, tools: [] }, deps).send("work")).toMatchObject({ status: "refused", code: "spend" });
    expect(always).toEqual([true, false]);
  });
});
