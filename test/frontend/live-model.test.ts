// What the Live and Sessions pages make of a turn's trace: the agents and how each stands, the feed
// under a filter, what a search finds, the totals of tokens, time and cost, and the turn as a file.

import { describe, expect, test } from "bun:test";
import { failedTurn, finishedTurn, longTurn, Trace } from "../../dev/preview/fixtures";
import {
  type AgentFeed,
  ALL_KINDS,
  exportJson,
  exportName,
  type FeedItem,
  feedOf,
  type Filter,
  findMatches,
  markPieces,
  matchAt,
  matchCounts,
  matchTotal,
  NO_FILTER,
  promptHashes,
  stepWindow,
  streamingWords,
  toolsCalled,
  totalCostWords,
  totalsCsv,
  transcriptMarkdown,
  turnTotals,
  turnView,
} from "../../src/extension/frontend/live-model";
import type { LiveEnded, LivePartial, LiveView } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);

/** A trace as the page holds it: the view of its turn, with `upTo` events of it (all by default) and what its calls in flight have sent. */
function viewOf(trace: Trace, upTo = trace.events.length, partials: LivePartial[] = []): LiveView {
  const events = trace.events.slice(0, upTo);
  const last = events.at(-1)?.event;
  const ended: LiveEnded | null = last?.kind === "turn_ended" ? { state: last.status, at: last.at, ...(last.reason !== undefined ? { reason: last.reason } : {}) } : null;
  return { chatId: trace.chatId, turn: trace.turn, kind: "new", messageId: "msg-0043", startedAt: trace.startedAt, ended, events, partials };
}

const kindsOf = (feed: AgentFeed | undefined): FeedItem["kind"][] => (feed?.items ?? []).map((i) => i.kind);
const only = (over: Partial<Filter>): Filter => ({ ...NO_FILTER, ...over });

describe("a turn's events fold into its agents", () => {
  const done = finishedTurn("chat-mara", "turn-1", T0);

  test("agents show in the order they started, the writer under the main agent that started it", () => {
    const turn = turnView(viewOf(done));
    expect(turn.agents.map((a) => a.start.role)).toEqual(["main", "writer"]);
    expect(turn.roots.map((a) => a.start.id)).toEqual(["main-1"]);
    expect(turn.roots[0]?.children.map((a) => a.start.id)).toEqual(["writer-1"]);
    expect(turn.agents[1]?.depth).toBe(1);
    expect(turn.agents.map((a) => a.state)).toEqual(["done", "done"]);
    expect(turn.session?.turns).toBe(3);
    expect(turn.ended?.status).toBe("done");
  });

  test("an agent at work waits on its model, then on the tools it called, by name", () => {
    // Up to the main agent's first message: it has been told, and its model hasn't answered.
    const told = turnView(viewOf(done, 4));
    expect(told.agents[0]?.state).toBe("working");
    expect(told.agents[0]?.activity).toMatchObject({ waits: "model" });
    // Its first answer called three tools; one result is in.
    const one = turnView(viewOf(done, 7));
    expect(one.agents[0]?.activity).toEqual({ waits: "tools", since: expect.any(Number), names: ["lore_read", "preset_instructions"] });
    // Every result is in: it waits on its model again.
    const all = turnView(viewOf(done, 9));
    expect(all.agents[0]?.activity).toMatchObject({ waits: "model" });
    // Once the turn is over nothing waits.
    expect(turnView(viewOf(done)).agents.every((a) => a.activity === null)).toBe(true);
  });

  test("an agent that stopped short shows by its stop, and one the turn's end overtook shows stopped", () => {
    const failed = turnView(viewOf(failedTurn("chat-mara", "turn-2", T0)));
    expect(failed.agents[0]?.state).toBe("stopped");
    expect(failed.ended?.status).toBe("failed");
    // A turn lost with its runtime: the page is told it ended, though no agent finished.
    const lost = turnView({ ...viewOf(done, 6), ended: { state: "lost", at: T0 + 9000 } });
    expect(lost.agents[0]?.state).toBe("stopped");
    expect(lost.agents[0]?.activity).toBeNull();
  });

  test("a message sent to an agent that had finished sets it to work again", () => {
    const t = new Trace("chat-mara", "turn-3", T0);
    t.started("new", null).agent({ id: "main-1", role: "main", system: "Be brief." }).message("main-1", "First.");
    t.answer("main-1", { text: "Done.", in: 100, out: 5, ms: 300 }).idle("main-1");
    expect(turnView(viewOf(t)).agents[0]?.state).toBe("done");
    t.message("main-1", "Again, shorter.");
    const again = turnView(viewOf(t)).agents[0];
    expect(again?.state).toBe("working");
    expect(again?.activity).toMatchObject({ waits: "model" });
  });

  test("an agent's spending is the runtime's tally after its latest call", () => {
    const turn = turnView(viewOf(done));
    expect(turn.agents[0]?.spent).toMatchObject({ calls: 3, toolTurns: 3, in: 5120 + 5610 + 5890, out: 212 + 64 + 148 });
    expect(turn.spent).toMatchObject({ calls: 4, in: 5120 + 5610 + 5890 + 2210 });
  });
});

describe("the feed", () => {
  const turn = turnView(viewOf(finishedTurn("chat-mara", "turn-1", T0)));

  test("shows each agent's work in order: told, each call with its thinking, answer and tool calls, and its finish", () => {
    const [main, writer] = feedOf(turn, NO_FILTER);
    expect(kindsOf(main)).toEqual(["instructions", "history", "told", "call", "thinking", "tool", "tool", "tool", "call", "thinking", "tool", "call", "said", "tool", "finished"]);
    expect(kindsOf(writer)).toEqual(["instructions", "told", "call", "said", "finished"]);
  });

  test("a tool call carries its result, and says when it failed", () => {
    const tools = (feedOf(turn, NO_FILTER)[0]?.items ?? []).flatMap((i) => (i.kind === "tool" ? [i] : []));
    expect(tools.map((t) => [t.call.name, t.state])).toEqual([
      ["chat_search", "done"],
      ["lore_read", "error"],
      ["preset_instructions", "done"],
      ["lore_read", "done"],
      ["write_reply", "done"],
    ]);
    expect(tools[1]?.result?.text).toContain("No lore entry has the id");
    // A result the model got clipped names where the whole is kept.
    expect(tools[3]?.result?.scratch).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a tool call with no result yet is running while its agent works, and has none once it stopped", () => {
    const trace = finishedTurn("chat-mara", "turn-1", T0);
    const waiting = (view: LiveView) => (feedOf(turnView(view), NO_FILTER)[0]?.items ?? []).flatMap((i) => (i.kind === "tool" ? [i.state] : []));
    expect(waiting(viewOf(trace, 6))).toEqual(["running", "running", "running"]);
    expect(waiting({ ...viewOf(trace, 6), ended: { state: "stopped", at: T0 + 5000 } })).toEqual(["none", "none", "none"]);
  });

  test("a filter by agent shows that agent and the agents it started", () => {
    expect(feedOf(turn, only({ agent: "writer-1" })).map((f) => f.agent.start.id)).toEqual(["writer-1"]);
    expect(feedOf(turn, only({ agent: "main-1" })).map((f) => f.agent.start.id)).toEqual(["main-1", "writer-1"]);
  });

  test("a filter by kind shows only those steps, each still under its call", () => {
    expect(kindsOf(feedOf(turn, only({ kinds: ["tools"] }))[0])).toEqual(["call", "tool", "tool", "tool", "call", "tool", "call", "tool", "finished"]);
    expect(kindsOf(feedOf(turn, only({ kinds: ["thinking"] }))[0])).toEqual(["call", "thinking", "call", "thinking", "finished"]);
    expect(kindsOf(feedOf(turn, only({ kinds: ["told"] }))[0])).toEqual(["instructions", "history", "told", "finished"]);
  });

  test("a filter by tool shows only that tool's calls", () => {
    expect(toolsCalled(turn)).toEqual(["chat_search", "lore_read", "preset_instructions", "write_reply"]);
    const items = feedOf(turn, only({ kinds: ["tools"], tool: "lore_read" }))[0]?.items ?? [];
    expect(items.flatMap((i) => (i.kind === "tool" ? [i.call.name] : []))).toEqual(["lore_read", "lore_read"]);
  });

  test("only what went wrong: failed tool calls, refusals and stops, and nothing of an agent that had none", () => {
    const wrong = feedOf(turn, only({ problems: true }));
    expect(wrong.map((f) => f.agent.start.id)).toEqual(["main-1"]);
    expect(kindsOf(wrong[0])).toEqual(["call", "tool"]);
    const failed = turnView(viewOf(failedTurn("chat-mara", "turn-2", T0)));
    expect(kindsOf(feedOf(failed, only({ problems: true }))[0])).toEqual(["retry", "refused", "stop"]);
    // A call that ran out of room is something that went wrong, too.
    const t = new Trace("chat-mara", "turn-4", T0);
    t.started("new", null).agent({ id: "main-1", role: "main", system: "s" }).message("main-1", "m").answer("main-1", { text: "It trails off", in: 10, out: 4000, ms: 100, finishReason: "length" }).idle("main-1").ended("done");
    expect(kindsOf(feedOf(turnView(viewOf(t)), only({ problems: true }))[0])).toEqual(["call"]);
  });

  test("a long transcript shows its latest steps; the earlier ones are counted, not shown", () => {
    const long = turnView(viewOf(longTurn("chat-mara", "turn-5", T0, 40)));
    const window = stepWindow(long, 20);
    expect(window.hidden).toBe(82 - 20);
    const feed = feedOf(long, NO_FILTER, window.from)[0];
    expect(feed?.hidden).toBe(62);
    // The instructions stay at the head however far the window has moved on.
    expect(feed?.items[0]?.kind).toBe("instructions");
    // The window opens on a result whose call is before it: that result stands on its own, so none is lost.
    expect(feed?.items.filter((i) => i.kind === "tool").length).toBe(9);
    expect(feed?.items.filter((i) => i.kind === "result").length).toBe(1);
    expect(stepWindow(long, 500)).toEqual({ from: 0, hidden: 0 });
  });
});

describe("a call in flight", () => {
  const done = finishedTurn("chat-mara", "turn-1", T0);
  const partial = (over: Partial<LivePartial> = {}): LivePartial => ({ agentId: "main-1", call: 1, text: "", reasoning: "Mara asks who keeps the key.", at: T0 + 900, ...over });

  test("a view that holds what a call has sent so far shows it in place of waiting for the model", () => {
    // The main agent has been told, and its first call has sent some of its thinking.
    const feed = feedOf(turnView(viewOf(done, 4, [partial()])), NO_FILTER)[0];
    expect(kindsOf(feed)).toEqual(["instructions", "history", "told", "streaming", "thinking"]);
    expect(feed?.items.at(-1)).toMatchObject({ kind: "thinking", text: "Mara asks who keeps the key.", live: true });
    expect(feed?.items.at(-2)).toMatchObject({ kind: "streaming", call: 1, reasoning: 28, text: 0 });
    // Its answer's text shows beside its thinking once some of it arrives.
    const both = feedOf(turnView(viewOf(done, 4, [partial({ text: "I have what" })])), NO_FILTER)[0];
    expect(both?.items.slice(-2).map((i) => [i.kind, "text" in i && i.text, "live" in i && i.live])).toEqual([["thinking", "Mara asks who keeps the key.", true], ["said", "I have what", true]]);
    expect(streamingWords({ call: 2, text: 11, reasoning: 1280 })).toBe("Call 2 is answering · 1,280 characters of thinking, 11 of its answer so far");
    expect(streamingWords({ call: 1, text: 150, reasoning: 0 })).toBe("Call 1 is answering · 150 characters of its answer so far");
  });

  test("a call that has sent nothing yet still shows as waiting for its model", () => {
    expect(kindsOf(feedOf(turnView(viewOf(done, 4, [partial({ reasoning: "" })])), NO_FILTER)[0]).at(-1)).toBe("activity");
  });

  test("the call's answer takes the place of what it had sent", () => {
    // The answer has landed; a view that still named the call in flight would show it twice.
    const feed = feedOf(turnView(viewOf(done, 5, [partial({ text: "raw, with <tool_call> text the answer leaves out" })])), NO_FILTER)[0];
    expect(kindsOf(feed)).not.toContain("streaming");
    expect(feed?.items.filter((i) => i.kind === "thinking")).toMatchObject([{ key: "r:5" }]);
    expect(feed?.items.some((i) => "live" in i && i.live)).toBe(false);
  });

  test("an agent's later call shows under the calls before it", () => {
    // Its first answer and that answer's three results are in; its second call is answering.
    const feed = feedOf(turnView(viewOf(done, 9, [partial({ call: 2, reasoning: "The id was misspelled." })])), NO_FILTER)[0];
    expect(kindsOf(feed).slice(-5)).toEqual(["tool", "tool", "tool", "streaming", "thinking"]);
    expect(feed?.items.at(-1)).toMatchObject({ key: "lr:main-1:2", live: true });
  });

  test("an agent that no longer works shows no call in flight", () => {
    const stale = [partial({ call: 9 }), partial({ agentId: "writer-1", call: 9 })];
    expect(feedOf(turnView(viewOf(done, done.events.length, stale)), NO_FILTER).flatMap((f) => kindsOf(f))).not.toContain("streaming");
    // A turn lost with its runtime: the page is told it ended, though the agent never finished.
    const lost = turnView({ ...viewOf(done, 4, [partial()]), ended: { state: "lost", at: T0 + 5000 } });
    expect(kindsOf(feedOf(lost, NO_FILTER)[0])).not.toContain("streaming");
  });

  test("the filters hold for what is arriving as for what has arrived", () => {
    const turn = turnView(viewOf(done, 4, [partial({ text: "I have what" })]));
    expect(kindsOf(feedOf(turn, only({ kinds: ["answer"] }))[0])).toEqual(["streaming", "said"]);
    expect(kindsOf(feedOf(turn, only({ kinds: ["tools"] }))[0])).toEqual(["streaming"]);
    expect(feedOf(turn, only({ problems: true }))).toEqual([]);
  });

  test("a search finds what has arrived so far, and the Markdown says it is not the whole", () => {
    const turn = turnView(viewOf(done, 4, [partial({ text: "I have what" })]));
    const feeds = feedOf(turn, NO_FILTER);
    expect(findMatches(feeds, "keeps the key").map((g) => g.key)).toContain("lr:main-1:1");
    const md = transcriptMarkdown(turn);
    expect(md).toContain("Thinking (so far):");
    expect(md).toContain("Answer (so far):");
    expect(md).toContain("(Call 1 is answering · 28 characters of thinking, 11 of its answer so far…)");
  });

  test("what arrives is added without folding the turn's events again", () => {
    const first = turnView(viewOf(done, 9, [partial({ call: 2, reasoning: "The id" })]));
    // A delta leaves the events as they are: the same list, and the same way the turn stands.
    const next = turnView({ ...first.view, partials: [partial({ call: 2, reasoning: "The id was misspelled." })] }, first);
    expect(next.agents).toBe(first.agents);
    expect(next.partials.get("main-1")?.reasoning).toBe("The id was misspelled.");
    // New events are folded as ever.
    const later = turnView(viewOf(done, 10), next);
    expect(later.agents).not.toBe(first.agents);
    expect(later.partials.size).toBe(0);
  });
});

describe("search", () => {
  const turn = turnView(viewOf(finishedTurn("chat-mara", "turn-1", T0)));
  const feeds = feedOf(turn, NO_FILTER);

  test("finds every place a query stands, whatever its case, in the feed's order", () => {
    const groups = findMatches(feeds, "LEDGER");
    expect(matchTotal(groups)).toBeGreaterThan(5);
    // The first find is in what the main agent was told, the last in what the writer wrote.
    expect(groups[0]?.key.startsWith("m:")).toBe(true);
    expect(groups.at(-1)?.agentId).toBe("writer-1");
    expect(findMatches(feeds, "   ")).toEqual([]);
    expect(findMatches(feeds, "no such words anywhere")).toEqual([]);
  });

  test("finds a tool by its name, in its arguments and in its result", () => {
    const groups = findMatches(feeds, "lore-harbor-office");
    // The misspelled id is in one call's arguments and in that call's failure.
    expect(groups.map((g) => g.field)).toEqual([1, 2]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(1);
    expect(findMatches(feeds, "preset_instructions").some((g) => g.field === 0)).toBe(true);
  });

  test("steps from find to find and round again", () => {
    const groups = findMatches(feeds, "key");
    const total = matchTotal(groups);
    expect(matchAt(groups, 0)?.nth).toBe(0);
    expect(matchAt(groups, total)).toEqual(matchAt(groups, 0));
    expect(matchAt(groups, -1)).toEqual(matchAt(groups, total - 1));
    // Two finds in one text are the same text's first and second.
    const two = groups.find((g) => g.count >= 2);
    expect(two).toBeDefined();
    expect(matchAt([], 0)).toBeNull();
  });

  test("counts the finds in each block, and a filter narrows what is searched", () => {
    const counts = matchCounts(findMatches(feeds, "ledger"));
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(matchTotal(findMatches(feeds, "ledger")));
    const writerOnly = findMatches(feedOf(turn, only({ agent: "writer-1" })), "ledger");
    expect(writerOnly.every((g) => g.agentId === "writer-1")).toBe(true);
    expect(matchTotal(writerOnly)).toBeLessThan(matchTotal(findMatches(feeds, "ledger")));
    expect(findMatches(feedOf(turn, only({ kinds: ["stops"] })), "ledger")).toEqual([]);
  });

  test("marks what it found in a text", () => {
    expect(markPieces("The ledger, the Ledger.", "ledger")).toEqual([
      { text: "The ", hit: false },
      { text: "ledger", hit: true },
      { text: ", the ", hit: false },
      { text: "Ledger", hit: true },
      { text: ".", hit: false },
    ]);
    expect(markPieces("nothing here", "")).toEqual([{ text: "nothing here", hit: false }]);
  });
});

describe("totals of tokens, time and cost", () => {
  const trace = finishedTurn("chat-mara", "turn-1", T0);
  const turn = turnView(viewOf(trace));
  const totals = turnTotals(turn, T0 + 60_000);

  test("per call: its tokens, its time, its cost, and the tools it called", () => {
    expect(totals.calls.map((c) => [c.agentId, c.call, c.usage.in, c.usage.out, c.ms, c.tools])).toEqual([
      ["main-1", 1, 5120, 212, 2840, 3],
      ["main-1", 2, 5610, 64, 1320, 1],
      ["main-1", 3, 5890, 148, 1980, 1],
      ["writer-1", 1, 2210, 236, 4350, 0],
    ]);
    // A call's tools' time is their results' times added up.
    expect(totals.calls[0]?.toolMs).toBe(180 + 12 + 9);
    // A call was asked when its answer came less how long it took: here 40 ms into the turn.
    expect(totals.calls[0]?.startedAt).toBe(T0 + 40);
    expect(totals.calls.every((c) => c.prompt !== null)).toBe(true);
  });

  test("per agent: the sums of its calls, its tool calls and how many failed", () => {
    const [main, writer] = totals.agents;
    expect(main).toMatchObject({ calls: 3, in: 16_620, cachedIn: 14_630, out: 424, reasoningOut: 149, modelMs: 6140, toolCalls: 5, toolErrors: 1, toolMs: 180 + 12 + 9 + 14 + 4400, unpriced: 0 });
    expect(writer).toMatchObject({ calls: 1, in: 2210, out: 236, modelMs: 4350, toolCalls: 0, toolMs: 0 });
    expect(main?.cost).toBeCloseTo((16_620 * 0.14 + 424 * 0.28) / 1_000_000, 10);
  });

  test("for the turn: its agents' together, and the time from its start to its end", () => {
    expect(totals.turn).toMatchObject({ calls: 4, in: 18_830, cachedIn: 14_630, out: 660, reasoningOut: 149, modelMs: 10_490, toolCalls: 5, toolErrors: 1 });
    expect(totals.turn.cost).toBeCloseTo((totals.agents[0]?.cost ?? 0) + (totals.agents[1]?.cost ?? 0), 10);
    const ended = turn.view.ended?.at ?? 0;
    expect(totals.turn.wallMs).toBe(ended - T0);
    expect(totalCostWords(totals.turn)).toMatch(/^\$0\.00\d+$/);
  });

  test("a turn still running counts its time up to now", () => {
    const running = turnTotals(turnView(viewOf(trace, 9)), T0 + 30_000);
    expect(running.turn.wallMs).toBe(30_000);
    expect(running.turn.calls).toBe(1);
    expect(running.agents[0]?.wallMs).toBe(30_000 - 40);
  });

  test("a cost says when calls went unpriced, and when counts are the runtime's estimate", () => {
    const failed = turnTotals(turnView(viewOf(failedTurn("chat-mara", "turn-2", T0))), T0);
    // No provider cost and no price for the local model: the cost is unknown, and the counts are estimates.
    expect(failed.turn).toMatchObject({ calls: 3, unpriced: 3, cost: 0, estimated: true });
    expect(totalCostWords(failed.turn)).toBe("cost unknown");
    // The time of the call that failed and was made again, and of the one that was refused, counts as model time though no answer shows it.
    expect(failed.agents[0]?.modelMs).toBe(900 + 420 + 3 * 5200);
    const t = new Trace("chat-mara", "turn-6", T0);
    t.started("new", null).agent({ id: "main-1", role: "main", system: "s" }).message("main-1", "m");
    t.answer("main-1", { text: "a", in: 1000, out: 100, ms: 100, cost: 0.002, estimated: ["cost"] }).answer("main-1", { text: "b", in: 1000, out: 100, ms: 100, cost: null });
    const mixed = turnTotals(turnView(viewOf(t)), T0).turn;
    expect(mixed).toMatchObject({ calls: 2, unpriced: 1, costEstimated: true, estimated: false });
    expect(totalCostWords(mixed)).toBe("≈$0.0020 + 1 call unpriced");
  });
});

describe("copy and export", () => {
  const trace = finishedTurn("chat-mara", "turn-1", T0);
  const view = viewOf(trace);
  const turn = turnView(view);

  test("the transcript as Markdown holds what each agent was told, said and called, and how it went", () => {
    const md = transcriptMarkdown(turn);
    expect(md).toStartWith("# New reply · turn turn-1\n");
    expect(md).toContain("## Main agent · done");
    expect(md).toContain("## Writer · write the reply from the brief · done");
    expect(md).toContain("**Instructions**");
    expect(md).toContain('→ `chat_search` {"query":"ledger key harbour office"}');
    expect(md).toContain("← failed · 12 ms");
    expect(md).toContain("Joss was already reaching for the lamp.");
    expect(md).toContain("| Main agent | 3 | 16,620 | 14,630 | 424 | 149 |");
    expect(md).toContain("## Ended: done");
    expect(md).toContain("Session: Carries 3 earlier turns (≈4,180 tokens), after a summary of the ones before.");
  });

  test("Markdown of what a filter shows leaves the rest out", () => {
    const md = transcriptMarkdown(turn, feedOf(turn, only({ agent: "writer-1", kinds: ALL_KINDS })));
    expect(md).toContain("## Writer");
    expect(md).not.toContain("## Main agent");
    expect(md).not.toContain("chat_search");
  });

  test("a text that holds a code fence is fenced so it stays whole", () => {
    const t = new Trace("chat-mara", "turn-7", T0);
    t.started("new", null).agent({ id: "main-1", role: "main", system: "s" }).message("main-1", "Use this:\n```\ncode\n```").ended("stopped");
    expect(transcriptMarkdown(turnView(viewOf(t)))).toContain("~~~~\nUse this:\n```\ncode\n```\n~~~~");
  });

  test("the turn as JSON holds every event as traced, and each call's exact prompt where they were read", () => {
    const hashes = promptHashes(view);
    expect(hashes.length).toBe(4);
    const prompts = Object.fromEntries(hashes.map((h) => [h, trace.prompts.get(h)]).filter((x) => x[1] !== undefined));
    const file = JSON.parse(exportJson(view, prompts, T0)) as { lumiah: string; version: number; exportedAt: string; view: LiveView; prompts: Record<string, unknown> };
    expect(file.lumiah).toBe("turn");
    expect(file.exportedAt).toBe("2026-11-10T09:00:00.000Z");
    expect(file.view.events.length).toBe(view.events.length);
    expect(file.view.events[0]?.seq).toBe(1);
    expect(Object.keys(file.prompts)).toEqual(hashes);
    expect(exportJson(view, null, T0)).not.toContain('"prompts"');
  });

  test("a call that kept no prompt names none", () => {
    const failed = viewOf(failedTurn("chat-mara", "turn-2", T0));
    // Two of its three answers kept their prompt, and so did the call that failed and was made again.
    expect(promptHashes(failed).length).toBe(3);
  });

  test("a call that failed in passing and was made again shows as a step of its own, in the feed, the search and the Markdown", () => {
    const failed = turnView(viewOf(failedTurn("chat-mara", "turn-2", T0)));
    const feeds = feedOf(failed, NO_FILTER);
    const retry = feeds[0]?.items.find((i) => i.kind === "retry");
    expect(retry).toMatchObject({ text: "Its call failed after 900 ms and is made again after 2.0 s, try 1 of 2: The connection closed before the model answered." });
    // It stands between what the agent was told and the call that then went through.
    expect(kindsOf(feeds[0]).slice(0, 5)).toEqual(["instructions", "told", "retry", "refused", "call"]);
    expect(findMatches(feeds, "connection closed").map((g) => g.key)).toEqual([retry?.key ?? ""]);
    expect(transcriptMarkdown(failed)).toContain("Its call failed after 900 ms and is made again after 2.0 s, try 1 of 2");
    // Hidden with the stops it is a kind of.
    expect(kindsOf(feedOf(failed, only({ kinds: ["told", "thinking", "answer", "tools"] }))[0])).not.toContain("retry");
  });

  test("tokens, time and cost per call as CSV, a call a row", () => {
    const lines = totalsCsv(turnTotals(turn, T0)).trimEnd().split("\n");
    expect(lines[0]).toBe("agent,role,call,model,started,ms,in,cached_in,cache_write,out,reasoning_out,estimated,cost_usd,finish,tool_calls,tool_ms,prompt");
    expect(lines.length).toBe(5);
    expect(lines[1]).toStartWith("main-1,main,1,deepseek-v4-flash,2026-11-10T09:00:00.040Z,2840,5120,3900,0,212,96,,");
    expect(lines[4]).toStartWith("writer-1,writer,1,");
  });

  test("an export's file name is safe for any file system, and tells two files of one kind apart", () => {
    expect(exportName(view, "md")).toBe("lumiah-new-turn-1.md");
    expect(exportName(view, "csv")).toBe("lumiah-new-turn-1.csv");
    expect(exportName(view, "json", "with-prompts")).toBe("lumiah-new-turn-1-with-prompts.json");
    expect(exportName({ ...view, turn: "a/b:c d" }, "json")).toBe("lumiah-new-a-b-c-d.json");
  });

  test("a cost in the CSV carries no noise from its arithmetic", () => {
    const t = new Trace("chat-mara", "turn-8", T0);
    t.started("new", null).agent({ id: "main-1", role: "main", system: "s" }).message("main-1", "m").answer("main-1", { text: "a", in: 5120, out: 212, ms: 100, cost: 0.0007761600000000001 }).idle("main-1").ended("done");
    expect(totalsCsv(turnTotals(turnView(viewOf(t)), T0)).split("\n")[1]).toContain(",0.00077616,stop,");
  });
});
