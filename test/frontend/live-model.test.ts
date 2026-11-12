// What the Live and Sessions pages make of a turn's trace: the agents and how each stands, the feed
// under a filter, what a search finds, the totals of tokens, time and cost, and the turn as a file.

import { describe, expect, test } from "bun:test";
import { briefedTurn, failedTurn, finishedTurn, longTurn, PROMPT_HELD, Trace, workedTurn } from "../../dev/preview/fixtures";
import {
  type AgentFeed,
  addsTo,
  ALL_KINDS,
  endReason,
  endSentence,
  exportJson,
  exportName,
  fileChangeWord,
  filePath,
  type FeedItem,
  feedOf,
  heldLine,
  historyWords,
  indexWords,
  briefOpening,
  loreChangeLine,
  loreChangeText,
  loreNamesWords,
  mendOf,
  rangeCount,
  rangesWords,
  tookWords,
  withoutPhrase,
  type Filter,
  findMatches,
  markPieces,
  matchAt,
  matchCounts,
  matchTotal,
  NO_FILTER,
  promptHashes,
  sessionWords,
  stepWindow,
  stopWords,
  streamingWords,
  toolsCalled,
  totalCostWords,
  totalsCsv,
  transcriptMarkdown,
  turnTotals,
  turnView,
} from "../../src/extension/frontend/live-model";
import { agentLabel } from "../../src/extension/frontend/live-model";
import type { LiveEnded, LivePartial, LiveView } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);

/** A trace as the page holds it: the view of its turn, with `upTo` events of it (all by default) and what its calls in flight have sent. */
function viewOf(trace: Trace, upTo = trace.events.length, partials: LivePartial[] = []): LiveView {
  const events = trace.events.slice(0, upTo);
  const last = events.at(-1)?.event;
  const ended: LiveEnded | null = last?.kind === "turn_ended" ? { state: last.status, at: last.at, ...(last.reason !== undefined ? { reason: last.reason } : {}) } : null;
  return { stream: trace.chatId, chatId: trace.chatId, turn: trace.turn, kind: "new", messageId: "msg-0043", startedAt: trace.startedAt, ended, events, partials };
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
    expect(lines[0]).toBe("agent,role,as,call,model,started,ms,in,cached_in,cache_write,out,reasoning_out,estimated,cost_usd,finish,tool_calls,tool_ms,prompt");
    expect(lines.length).toBe(5);
    expect(lines[1]).toStartWith("main-1,main,,1,deepseek-v4-flash,2026-11-10T09:00:00.040Z,2840,5120,3900,0,212,96,,");
    expect(lines[4]).toStartWith("writer-1,writer,,1,");
  });

  test("an agent is named with which instance it is, where whoever started it said", () => {
    expect(agentLabel({ role: "character", as: "okoro" })).toBe("Character (okoro)");
    expect(agentLabel({ role: "character" })).toBe("Character");
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

describe("what the user does to a run, and what its agents do beyond their calls", () => {
  const worked = turnView(viewOf(workedTurn("chat-mara", "turn-45", T0)));
  const feedOfAgent = (id: string, filter: Filter = NO_FILTER): AgentFeed | undefined => feedOf(worked, filter).find((f) => f.agent.start.id === id);

  test("a sub-agent stands right under the agent that started it, however late it started", () => {
    const t = new Trace("chat-mara", "turn-9", T0);
    t.started("new", null);
    t.agent({ id: "main-1", role: "main", system: "s" });
    t.agent({ id: "a-1", role: "archivist", system: "s", parent: "main-1" });
    t.agent({ id: "b-1", role: "reader", system: "s", parent: "main-1" });
    // Started after b-1, by a-1: in the order they started it would stand under b-1.
    t.agent({ id: "a1-1", role: "reader", system: "s", parent: "a-1" });
    const turn = turnView(viewOf(t));
    expect(turn.nested.map((a) => [a.start.id, a.depth])).toEqual([
      ["main-1", 0],
      ["a-1", 1],
      ["a1-1", 2],
      ["b-1", 1],
    ]);
    expect(feedOf(turn, NO_FILTER).map((f) => f.agent.start.id)).toEqual(["main-1", "a-1", "a1-1", "b-1"]);
    expect(feedOf(turn, only({ agent: "a-1" })).map((f) => f.agent.start.id)).toEqual(["a-1", "a1-1"]);
  });

  test("the made-up turn nests three deep: the main agent, its archivist, the archivist's reader", () => {
    expect(worked.nested.map((a) => [a.start.role, a.depth])).toEqual([
      ["main", 0],
      ["archivist", 1],
      ["reader", 2],
      ["writer", 1],
    ]);
  });

  test("a tool call that was held says so, with the user's word on it", () => {
    const tools = (feedOfAgent("archivist-1")?.items ?? []).flatMap((i) => (i.kind === "tool" ? [i] : []));
    const held = tools.find((t) => t.word !== null);
    expect(held?.call.name).toBe("workspace_write");
    expect(held?.word?.ended?.decision).toBe("chat");
    expect(held?.state).toBe("done");
    // The ask and its answer are the card's: they are no items of their own.
    expect(kindsOf(feedOfAgent("archivist-1"))).not.toContain("word");
  });

  test("while a call waits for the user's word its agent is said to wait for it, and the call is held, not running", () => {
    const t = new Trace("chat-mara", "turn-10", T0);
    const write = { id: "call_w", name: "workspace_write", args: { path: "notes/ledger.md", text: "x" } };
    t.started("new", null).agent({ id: "main-1", role: "main", system: "s" }).message("main-1", "m").answer("main-1", { calls: [write], in: 10, out: 5, ms: 100 });
    t.asked("main-1", write, "write", T0 + 300_000);
    const waiting = turnView(viewOf(t));
    expect(waiting.agents[0]?.activity).toEqual({ waits: "word", since: t.now, tool: "workspace_write" });
    expect((feedOf(waiting, NO_FILTER)[0]?.items ?? []).flatMap((i) => (i.kind === "tool" ? [i.state] : []))).toEqual(["held"]);
    t.approval("main-1", write, { decision: "refused", reason: "Not that file." }, 4000);
    t.result("main-1", write, "The user refused this call: Not that file.", 0, { error: true });
    const refused = turnView(viewOf(t));
    expect(refused.agents[0]?.activity).toEqual({ waits: "model", since: t.now });
    const [card] = (feedOf(refused, NO_FILTER)[0]?.items ?? []).flatMap((i) => (i.kind === "tool" ? [i] : []));
    expect(card?.state).toBe("error");
    expect(card?.word?.ended).toMatchObject({ decision: "refused", reason: "Not that file." });
  });

  test("a held call whose call isn't shown stands on its own, in a sentence", () => {
    const t = new Trace("chat-mara", "turn-11", T0);
    const write = { id: "call_w", name: "workspace_write", args: {} };
    t.started("new", null).agent({ id: "main-1", role: "main", system: "s" }).message("main-1", "m").answer("main-1", { calls: [write], in: 10, out: 5, ms: 100 });
    t.asked("main-1", write, "write", null);
    t.approval("main-1", write, { decision: "timed_out" }, 60_000);
    const turn = turnView(viewOf(t));
    const asked = turn.agents[0]?.steps.find((s) => s.entry.kind === "approval_asked");
    // The window starts at the ask: its call's answer lies before it.
    const items = feedOf(turn, NO_FILTER, asked?.seq ?? 0)[0]?.items ?? [];
    const own = items.find((i) => i.kind === "word");
    expect(own?.kind === "word" ? own.text : "").toBe("workspace_write: Held for your word (it writes): no answer came in 1 min 0 s, so it was refused.");
  });

  test("a result names the workspace files its call changed, each as its path is written", () => {
    const tools = (feedOfAgent("archivist-1")?.items ?? []).flatMap((i) => (i.kind === "tool" ? [i] : []));
    const changed = tools.flatMap((t) => t.files.map((f) => `${filePath(f)} ${fileChangeWord(f)}`));
    expect(changed).toEqual(["notes/ledger.md changed", "learned/people/okoro.md made"]);
    expect(filePath({ area: "user", path: "GUIDANCE.md" })).toBe("~/GUIDANCE.md");
    expect(fileChangeWord({ area: "chat", path: "a.md", before: "a".repeat(64), after: null })).toBe("deleted");
  });

  test("what the user said while it worked shows where the main agent received it", () => {
    const note = (feedOfAgent("main-1")?.items ?? []).find((i) => i.kind === "note");
    expect(note?.kind === "note" ? note.text : "").toBe("Keep Okoro's note short: one paragraph.");
    // It is something the agent was told: the filter that hides what agents were told hides it too.
    expect(kindsOf(feedOfAgent("main-1", only({ kinds: ["tools"] })))).not.toContain("note");
  });

  test("a job an agent started shows in that agent's feed, and the jobs it was told have ended are said with its session", () => {
    const job = (feedOfAgent("main-1")?.items ?? []).find((i) => i.kind === "job");
    expect(job?.kind === "job" ? job.text : "").toBe("Started a job as Archivist, to run once this reply is written: Bring notes/timeline.md up to date with the last ten replies, one line a reply.");
    expect(kindsOf(feedOfAgent("archivist-1"))).not.toContain("job");
    expect(worked.session ? sessionWords(worked.session).at(-1) : "").toBe("Told of 1 job that ended since its last turn: Archivist (done).");
  });

  test("the user holding a run and letting it go on are marked in place, and the run is paused between the two", () => {
    const t = new Trace("chat-mara", "turn-12", T0);
    t.started("new", null).agent({ id: "main-1", role: "main", system: "s" }).message("main-1", "m");
    t.wait(1000).paused();
    expect(turnView(viewOf(t)).paused).toBe(true);
    t.wait(5000).resumed();
    t.answer("main-1", { text: "a", in: 10, out: 5, ms: 100 }).idle("main-1");
    const turn = turnView(viewOf(t));
    expect(turn.paused).toBe(false);
    expect(kindsOf(feedOf(turn, NO_FILTER)[0])).toEqual(["instructions", "told", "hold", "hold", "call", "said", "finished"]);
    // A run that ended while held is no longer paused: nothing waits.
    const ended = new Trace("chat-mara", "turn-13", T0);
    ended.started("new", null).agent({ id: "main-1", role: "main", system: "s" }).paused().ended("stopped");
    expect(turnView(viewOf(ended)).paused).toBe(false);
  });

  test("what the runtime tells an agent shows among what it was told; what it says of the run shows as something that went wrong", () => {
    const t = new Trace("chat-mara", "turn-14", T0);
    t.started("new", null).agent({ id: "main-1", role: "main", system: "s" }).message("main-1", "m");
    t.answer("main-1", { text: "a", in: 10, out: 5, ms: 100 });
    t.runtimeNotice("main-1", "You have 2 rounds of tool calls left.");
    t.idle("main-1");
    t.runNotice("This turn's notes couldn't be stored: the next turn starts without them.");
    t.ended("done");
    const turn = turnView(viewOf(t));
    const texts = (filter: Filter): string[] => (feedOf(turn, filter)[0]?.items ?? []).flatMap((i) => (i.kind === "notice" ? [`${i.of}: ${i.text}`] : []));
    expect(texts(NO_FILTER)).toEqual(["agent: The runtime told it: You have 2 rounds of tool calls left.", "run: This turn's notes couldn't be stored: the next turn starts without them."]);
    // Only what went wrong: the run's notice stays, what the agent was told goes.
    expect(texts(only({ problems: true }))).toEqual(["run: This turn's notes couldn't be stored: the next turn starts without them."]);
    expect(findMatches(feedOf(turn, only({ query: "couldn't be stored" })), "couldn't be stored")).toHaveLength(1);
    expect(transcriptMarkdown(turn)).toContain("The runtime told it: You have 2 rounds of tool calls left.");
  });

  test("the transcript as Markdown says the note, the held call and the files", () => {
    const md = transcriptMarkdown(worked);
    expect(md).toContain("**The user said**");
    expect(md).toContain("Held for your word (it writes): you approved this tool for this chat from now on after 8.2 s.");
    expect(md).toContain("learned/people/okoro.md made");
    expect(md).toContain("Started a job as Archivist");
  });
});

describe("a stop is said once", () => {
  test("a reason that only repeats the state it explains is dropped", () => {
    expect(addsTo("the turn was stopped", "Stopped after 6.0 s")).toBe(false);
    expect(addsTo("You stopped it from the live view.", "The turn was stopped")).toBe(true);
    expect(addsTo("cancelled", "Cancelled")).toBe(false);
  });

  test("an agent's stop names its status, its code where that says more, and its reason where that says more", () => {
    expect(stopWords({ kind: "stop", status: "cancelled", code: "cancelled", reason: "the agent was cancelled", at: T0 })).toBe("Cancelled.");
    expect(stopWords({ kind: "stop", status: "refused", code: "tool_turns", reason: "It used its 24 tool rounds without calling write_reply.", at: T0 })).toBe("Refused (tool turns): It used its 24 tool rounds without calling write_reply.");
    expect(stopWords({ kind: "stop", status: "failed", code: "failed", reason: "HTTP 500 from the provider", at: T0 })).toBe("Failed: HTTP 500 from the provider");
  });

  test("a turn's end is one sentence, with why only where that says more", () => {
    expect(endSentence({ state: "stopped", at: T0, reason: "the turn was stopped" })).toBe("The turn was stopped.");
    expect(endSentence({ state: "stopped", at: T0, reason: "You stopped it from the live view." })).toBe("The turn was stopped: You stopped it from the live view.");
    expect(endSentence({ state: "done", at: T0 })).toBe("The turn finished.");
    expect(endReason({ state: "stopped", at: T0, reason: "the turn was stopped" }, "Stopped after 6.0 s")).toBeNull();
    expect(endReason({ state: "failed", at: T0, reason: "The main agent ran out of tool rounds." }, "Failed after 12.0 s")).toBe("The main agent ran out of tool rounds.");
  });
});

describe("a reply that failed names its cause and the step that mends it (ux B2)", () => {
  const FAILED = "The main agent stopped before it wrote a brief.";
  const ended = (over: Partial<LiveEnded> = {}): LiveEnded => ({ state: "failed", at: T0, reason: FAILED, ...over });

  test("a turn that finished, and one the user stopped, need neither", () => {
    expect(mendOf({ state: "done", at: T0 }, null, false)).toBeNull();
    expect(mendOf({ state: "stopped", at: T0, reason: "You stopped it from the live view." }, null, false)).toBeNull();
  });

  test("the backend's cause decides where it sends one: another model, a permission, the limit's own setting", () => {
    expect(mendOf(ended({ cause: "no_tools" }), null, false)).toEqual({ title: "The agents' model can't call tools", text: FAILED, tone: "neg", action: { label: "Choose another model for the agents", step: { go: "setting", link: "agentsModel" } } });
    expect(mendOf(ended({ cause: "permission" }), null, false)).toMatchObject({ title: "LumiAH is missing a permission it needs", action: { label: "Allow it", step: { go: "grant" } } });
    const stop = (code: "tool_turns" | "turn_tokens_in" | "spend") => ({ stop: { code, reason: "It reached a limit." } });
    expect(mendOf(ended({ cause: "limit" }), stop("tool_turns"), false)?.action).toEqual({ label: "Raise the main agent's limits", step: { go: "setting", link: "agentLimits" } });
    expect(mendOf(ended({ cause: "limit" }), stop("turn_tokens_in"), false)?.action).toEqual({ label: "Raise the limits of a reply", step: { go: "setting", link: "turnLimits" } });
    expect(mendOf(ended({ cause: "limit" }), stop("spend"), false)?.action).toEqual({ label: "See the day's limits", step: { go: "page", page: "spend" } });
    // The code alone, with the stop not at hand, still says it was a limit and leads to the step that shows which.
    expect(mendOf(ended({ cause: "limit" }), null, false)).toMatchObject({ title: "A limit was reached", action: { step: { go: "problems" } } });
  });

  test("without a cause from the backend, the page tells what it can: a missing permission, a limit the main agent stopped at, a connection it can't use", () => {
    expect(mendOf(ended(), null, true)?.title).toBe("LumiAH is missing a permission it needs");
    expect(mendOf(ended(), { stop: { code: "tokens_out", reason: "It wrote its 4,000 tokens." } }, false)?.title).toBe("The main agent reached one of its limits");
    expect(mendOf(ended(), { stop: { code: "connection", reason: "No connection." } }, false)?.action?.step).toEqual({ go: "setting", link: "agentsModel" });
    expect(mendOf({ state: "lost", at: T0 }, null, false)).toMatchObject({ title: "The turn was lost with its runtime", action: { label: "Open Runtime" } });
    // Else it failed for a reason only its steps say: the way is to them.
    expect(mendOf(ended(), null, false)).toEqual({ title: "The turn failed", text: FAILED, tone: "neg", action: { label: "Show what went wrong", step: { go: "problems" } } });
    expect(mendOf({ state: "failed", at: T0, reason: "The main agent ran out of tool rounds." }, null, false)).toMatchObject({ title: "The turn failed", text: "The main agent ran out of tool rounds.", tone: "neg" });
  });

  test("the backend's words stand under the heading without saying it twice", () => {
    expect(mendOf(ended({ reason: "The turn failed: the provider answered 503." }), null, false)?.text).toBe("The provider answered 503.");
    expect(withoutPhrase("The turn failed. The provider answered 503.", "The turn failed")).toBe("The provider answered 503.");
    expect(withoutPhrase("The provider answered 503.", "The turn failed")).toBe("The provider answered 503.");
    expect(withoutPhrase("The turn failed.", "The turn failed")).toBe("");
  });
});

describe("what a reply's turn came to, in words (ux B1)", () => {
  test("the lore is named, added and left out; nothing is said where none changed", () => {
    expect(loreNamesWords({ added: ["The night key"], dropped: ["Joss", "The harbour office"] })).toBe("Added “The night key”. Left out of this prompt: “Joss” and “The harbour office”.");
    expect(loreNamesWords({ added: [], dropped: [] })).toBe("");
  });

  test("how long it took comes with what it cost, where a cost is known", () => {
    expect(tookWords(12_400, { cost: 0.0018 })).toBe("12.4 s, $0.0018");
    expect(tookWords(12_400, {})).toBe("12.4 s");
    expect(tookWords(12_400, null)).toBe("12.4 s");
  });

  test("a short brief shows whole; a long one opens with its first lines, cut at a word, as plain words", () => {
    expect(briefOpening("Mara reaches the harbour office at dusk.")).toBeNull();
    const long = `## Scene\n\n${"Ilse holds the **night key** and will not hand it over. ".repeat(12)}`;
    const opening = briefOpening(long);
    expect(opening).toEndWith("…");
    expect(opening?.length).toBeLessThanOrEqual(281);
    expect(opening).not.toContain("**");
    expect(opening).not.toContain("##");
    expect(opening?.slice(0, -1).endsWith(" ")).toBe(false);
  });
});

describe("what the prompt held, and the lore the writer saw", () => {
  const briefed = briefedTurn("chat-mara", "turn-h", T0);
  const turn = turnView(viewOf(briefed));

  test("the turn holds what the main agent was told of the prompt, and its fold's line says how much", () => {
    expect(turn.held?.lore.map((e) => e.entryId)).toEqual(["lore-town-rules", "lore-harbour-office", "lore-joss"]);
    expect(heldLine(PROMPT_HELD)).toBe("3 lore entries (≈110 tokens) and 18 of the chat's 47 messages");
    expect(heldLine({ lore: [], index: { listed: [], more: 0 }, history: { held: [[1, 12]], missing: [], stands: [] } })).toBe("no lore and all 12 messages of the chat");
    expect(heldLine({ lore: [], index: { listed: [], more: 0 }, history: { held: [], missing: [], stands: [] } })).toBe("no lore and none of the chat");
    // A turn that says nothing of its prompt (a job's run, an older transcript) has none.
    expect(turnView(viewOf(finishedTurn("chat-mara", "turn-o", T0))).held).toBeNull();
  });

  test("the chat in the prompt: which messages it holds word for word, which it doesn't, and what stands in for those", () => {
    expect(rangesWords([[30, 47]])).toBe("#30 to #47");
    expect(rangesWords([[1, 12], [20, 29], [33, 33]])).toBe("#1 to #12, #20 to #29 and #33");
    expect(rangeCount([[1, 12], [20, 29], [33, 33]])).toBe(23);
    expect(historyWords(PROMPT_HELD.history)).toEqual(["Messages #30 to #47 are in the prompt word for word.", "#1 to #29 are not. Lumiverse's summary (Story so far) stands in for them."]);
    expect(historyWords({ held: [[5, 5]], missing: [[1, 4]], stands: [] })).toEqual(["Message #5 is in the prompt word for word.", "#1 to #4 are not. Nothing stands in for them: the main agent reads them with its tools when the reply needs them."]);
    expect(historyWords({ held: [[1, 9]], missing: [], stands: [] })).toEqual(["Messages #1 to #9 are in the prompt word for word."]);
    expect(historyWords({ held: [], missing: [[1, 9]], stands: [{ kind: "book", name: "Mara's book" }, { kind: "memories", name: "Memories" }] })[1]).toBe("#1 to #9 are not. The chat's book (Mara's book) and Lumiverse's memories (Memories) stand in for them.");
  });

  test("the lore not in the prompt: what the main agent was shown of it", () => {
    expect(indexWords(PROMPT_HELD.index)).toBe("The main agent was shown 2 entries that aren't in the prompt, by title and keys, to look up if the reply needs them; 24 more were only counted.");
    expect(indexWords({ listed: [], more: 0 })).toBe("Every entry of the chat's books is in the prompt.");
    expect(indexWords({ listed: [], more: 3 })).toContain("3 more entries are in the chat's books");
  });

  test("write_reply's call says which entries it added and which it left out of this prompt, and a search finds them", () => {
    const write = feedOf(turn, NO_FILTER)[0]?.items.find((i) => i.kind === "tool" && i.call.name === "write_reply");
    if (write?.kind !== "tool" || write.lore === null) throw new Error("the turn's write_reply says nothing of the lore");
    expect(loreChangeLine(write.lore)).toBe("The main agent added 1 lore entry and left 1 out of this prompt; 1 entry it named was refused.");
    expect(loreChangeText(write.lore).split("\n")).toEqual(["Added: The night key", "Left out of this prompt: Joss", "Refused: lore-ilse (The chat's books have no entry lore-ilse. lore_index lists the entries there are.)"]);
    expect(loreChangeLine({ added: [], dropped: [], refused: [] })).toBe("The main agent left the lore in the prompt as Lumiverse had it.");
    expect(loreChangeLine({ added: [], dropped: [{ entryId: "a", bookId: "b", title: "A", chars: 1 }, { entryId: "c", bookId: "b", title: "C", chars: 1 }], refused: [] })).toBe("The main agent left 2 out of this prompt.");
    // The title is in no argument and no result: only what the call did to the lore says it.
    const found = findMatches(feedOf(turn, NO_FILTER), "Left out of this prompt: Joss");
    expect(found.map((g) => [g.key === write.key, g.field])).toEqual([[true, 3]]);
    // A tool call that changes no lore says nothing of it.
    expect(feedOf(turn, NO_FILTER)[0]?.items.filter((i) => i.kind === "tool" && i.lore !== null).length).toBe(1);
  });

  test("Copy and Export say both", () => {
    const md = transcriptMarkdown(turn);
    expect(md).toContain("What the prompt held: 3 lore entries (≈110 tokens) and 18 of the chat's 47 messages.");
    expect(md).toContain("- The harbour office (212 characters): a key matched: harbour office");
    expect(md).toContain("The main agent added 1 lore entry and left 1 out of this prompt; 1 entry it named was refused.\nAdded: The night key");
  });
});
