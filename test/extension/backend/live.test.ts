// A model's answer in the live view as it arrives (DESIGN §8 Live): the runtime sends what each call
// in flight gained, the live buffer keeps it as that call's partial and hands each delta on to the
// pages following the chat, a page that opens the view mid-call gets the partial with it, and the
// partial is gone once the call's own entry lands. Nothing of it is stored.

import { afterEach, describe, expect, test } from "bun:test";
import type { TraceDelta, TraceRecord } from "../../../src/core/ports";
import { LINK } from "../../../src/link/contract";
import { type BackendToFrontend, type LiveDelta, type LiveView, followDelta, followLive } from "../../../src/shared/ui";
import type { FakePage } from "../../support/fake-lumiverse";
import { toolCall } from "../../support/fake-host";
import { type Rig, rig, until, USER } from "../../support/rig";

let r: Rig | null = null;
afterEach(() => {
  r?.close();
  r = null;
});

const deltasOf = (page: FakePage): LiveDelta[] => page.pushes.flatMap((p: BackendToFrontend) => (p.type === "lah.live.delta" ? [p.delta] : []));

/** A page's view after everything it was pushed since it opened the chat, followed with the page's own functions. */
function followed(opened: LiveView | null, page: FakePage): LiveView | null {
  let view = opened;
  for (const push of page.pushes) {
    if (push.type !== "lah.live" && push.type !== "lah.live.delta") continue;
    const next = push.type === "lah.live" ? followLive(view, push.change) : followDelta(view, push.delta);
    if ("gap" in next) throw new Error(`the page couldn't follow: it found a gap (${next.gap})`);
    view = next;
  }
  return view;
}

describe("a call in flight", () => {
  test("reaches a following page delta by delta, is in the view a page opens mid-call, and is gone after its answer", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    // The main agent's first call never answers by itself: the test says what arrives of it.
    it.host.script = [{ hang: true }];
    let turn = "";
    const stop = new AbortController();
    const generating = it.generate(chatId, { signal: stop.signal, onStarted: (id) => (turn = id) });
    await until(() => it.host.calls.length === 1 && it.backend.live.runningOf(USER).length === 1, "the turn to be running");
    const early = it.lumiverse.page();
    const opened = await early.request("lah.live.open", { chatId });
    expect(opened.live?.partials).toEqual([]);

    const delta = (more: Pick<TraceDelta, "text" | "reasoning">): TraceDelta => ({ turn, chatId, agentId: "main", call: 1, ...more, at: 1_000 });
    it.runtime.link.notify({ type: "trace.deltas", deltas: [delta({ reasoning: "Who keeps the light? " }), delta({ text: "Okoro " }), delta({ text: "keeps " })] });
    await until(() => deltasOf(early).length === 3, "the deltas to reach the page");

    // In the order they were sent, each saying how much of the call came before it.
    expect(deltasOf(early)).toEqual([
      { turn, agentId: "main", call: 1, reasoning: "Who keeps the light? ", before: { text: 0, reasoning: 0 }, at: 1_000 },
      { turn, agentId: "main", call: 1, text: "Okoro ", before: { text: 0, reasoning: 21 }, at: 1_000 },
      { turn, agentId: "main", call: 1, text: "keeps ", before: { text: 6, reasoning: 21 }, at: 1_000 },
    ]);

    // A page that starts following now gets what has arrived so far with the view.
    const late = it.lumiverse.page();
    const midCall = await late.request("lah.live.open", { chatId });
    expect(midCall.live?.partials).toEqual([{ agentId: "main", call: 1, text: "Okoro keeps ", reasoning: "Who keeps the light? ", at: 1_000 }]);

    // Both hear what arrives next, and both hold the same partial after it.
    it.runtime.link.notify({ type: "trace.deltas", deltas: [delta({ text: "it." })] });
    await until(() => deltasOf(late).length === 1 && deltasOf(early).length === 4, "the next delta to reach both pages");
    expect(deltasOf(late)[0]?.before).toEqual({ text: 12, reasoning: 21 });
    const whole = [{ agentId: "main", call: 1, text: "Okoro keeps it.", reasoning: "Who keeps the light? ", at: 1_000 }];
    expect(followed(opened.live, early)?.partials).toEqual(whole);
    expect(followed(midCall.live, late)?.partials).toEqual(whole);

    // A delta from a session that is no runtime's is not taken.
    it.host.deliver({ link: LINK, type: "trace.deltas", deltas: [delta({ text: " (not from the runtime)" })] }, USER, early.session);

    // The call's own entry lands: the partial has done its work.
    const held = (await late.request("lah.live.open", { chatId })).live?.events.length ?? 0;
    const answer: TraceRecord = { turn, chatId, seq: held + 1, event: { kind: "agent_entry", agentId: "main", entry: { kind: "answer", text: "Okoro keeps it.", reasoning: "Who keeps the light? ", calls: [], written: false, tools: "none", usage: { in: 10, cachedIn: 0, out: 4, reasoningOut: 0, estimated: [] }, model: "scripted-model", finishReason: "stop", ms: 5, at: 1_200 } } };
    expect(await it.runtime.link.request("trace.push", { records: [answer] }, 1_000)).toEqual({ taken: 1 });
    const after = await it.lumiverse.page().request("lah.live.open", { chatId });
    expect(after.live?.partials).toEqual([]);
    expect(after.live?.events.at(-1)?.event).toMatchObject({ kind: "agent_entry", entry: { kind: "answer", text: "Okoro keeps it." } });
    expect(followed(opened.live, early)?.partials).toEqual([]);

    // What comes late of the answered call is left; the agent's next call starts its own partial.
    it.runtime.link.notify({ type: "trace.deltas", deltas: [delta({ text: " (late)" }), { ...delta({ text: "Next." }), call: 2 }] });
    await until(() => deltasOf(early).length === 5, "the next call's delta");
    expect(deltasOf(early).at(-1)).toMatchObject({ call: 2, text: "Next.", before: { text: 0, reasoning: 0 } });
    expect((await late.request("lah.live.open", { chatId })).live?.partials).toEqual([{ agentId: "main", call: 2, text: "Next.", reasoning: "", at: 1_000 }]);

    // The turn ends: nothing is in flight, and nothing of the partials was stored.
    stop.abort();
    await generating;
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn to end");
    expect((await late.request("lah.live.open", { chatId })).live?.partials).toEqual([]);
    expect([...it.host.files.values()].some((text) => text.includes("Okoro keeps"))).toBe(false);
  });

  test("of a real turn: the writer's answer reaches a following page as it streams, before the entry that holds it whole", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." })] }, { content: "Okoro keeps it now. Ilse handed him the keys.", reasoning: "Short and plain." }];
    const opened = await it.page.request("lah.live.open", { chatId });

    const out = await it.generate(chatId);
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn to end");
    await it.backend.settle();

    expect(out.content).toBe("Okoro keeps it now. Ilse handed him the keys.");
    // The page could follow all of it, and ends with the turn done and nothing in flight.
    const view = followed(opened.live, it.page);
    expect(view?.ended?.state).toBe("done");
    expect(view?.partials).toEqual([]);
    // What the page was pushed of the writer's call, joined in order, is the reply and its thinking.
    const writer = view?.events.flatMap((e) => (e.event.kind === "agent_started" && e.event.agent.role === "writer" ? [e.event.agent.id] : []))[0] ?? "";
    const written = deltasOf(it.page).filter((d) => d.agentId === writer);
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((d) => d.call === 1)).toBe(true);
    expect(written.map((d) => d.text ?? "").join("")).toBe("Okoro keeps it now. Ilse handed him the keys.");
    expect(written.map((d) => d.reasoning ?? "").join("")).toBe("Short and plain.");
    // Every delta of the call came before the push that carried its answer entry.
    const lastDelta = it.page.pushes.findLastIndex((p) => p.type === "lah.live.delta" && p.delta.agentId === writer);
    const entry = it.page.pushes.findIndex((p) => p.type === "lah.live" && "events" in p.change && p.change.events.some((e) => e.event.kind === "agent_entry" && e.event.agentId === writer && e.event.entry.kind === "answer"));
    expect(entry).toBeGreaterThan(lastDelta);
  });
});
