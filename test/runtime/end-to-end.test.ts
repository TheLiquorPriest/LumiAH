// One reply, end to end (DESIGN §2): Lumiverse's prompt goes through the extension's interceptor,
// which tags it; the request reaches the runtime's loopback endpoint; the runtime checks the tag
// with the extension and runs the core's harness; the main agent's model calls and the writer's go
// back through the extension to a scripted model; the reply streams back as the completion; and the
// turn's record is anchored on the reply's message once Lumiverse has saved it. Then a second reply
// resumes the session the first one left.

import { afterEach, describe, expect, test } from "bun:test";
import { recordOf } from "../../src/core/sessions";
import { isRecord } from "../../src/link/json";
import { toolCall } from "../support/fake-host";
import { type Rig, rig, until, USER } from "../support/rig";

let r: Rig | null = null;
afterEach(() => {
  r?.close();
  r = null;
});

/** The record LumiAH keeps on a message for a swipe, read as the core reads one; null when there is none. */
function anchored(own: unknown, swipe: number) {
  return isRecord(own) && isRecord(own.swipes) ? recordOf(own.swipes[String(swipe)]) : null;
}

describe("a chat on the loopback connection", () => {
  test("is answered by the main agent and the writer, streamed back, and anchored on the reply", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light; Ilse handed it over last spring." })] }, "Okoro keeps it now. Ilse handed him the keys last spring."];

    const out = await it.generate(chatId);

    // The reply is the writer's answer, as a streamed completion.
    expect(out.error).toBeNull();
    expect(out.status).toBe(200);
    expect(out.content).toBe("Okoro keeps it now. Ilse handed him the keys last spring.");
    expect(out.finish).toBe("stop");
    // The interceptor tagged the request, and the main agent's steps went to the thinking block.
    expect(typeof out.body.lumiah_turn).toBe("string");
    expect(out.reasoning).toContain("write_reply");

    // Both calls went through the extension, on the user's own connection, never the loopback.
    expect(it.host.calls.map((c) => c.kind)).toEqual(["call", "call"]);
    const [main, writer] = it.host.calls;
    if (main?.kind !== "call" || writer?.kind !== "call") throw new Error("two agent calls were expected");
    expect(main.request.tools?.map((t) => t.name)).toContain("write_reply");
    // The writer gets Lumiverse's own messages (the tag is gone from them) with the brief put in.
    const sent = writer.request.messages.map((m) => m.content).join("\n");
    expect(sent).toContain("Who keeps the harbour light now?");
    expect(sent).toContain("Okoro keeps the light; Ilse handed it over last spring.");
    expect(JSON.stringify(writer.request)).not.toContain(String(out.body.lumiah_turn));

    // The turn's record is on the reply's message, for the swipe it wrote, once Lumiverse saved it.
    const reply = it.host.message(chatId, out.messageId ?? "");
    await until(() => reply.own !== null, "the reply's record");
    const record = anchored(reply.own, 0);
    expect(record?.generationId).toBe(out.generationId);
    expect(record?.kind).toBe("new");
    // Its bodies are blobs in the user's own storage.
    expect(it.host.files.has(`${USER}/blobs/${record?.segment.slice(0, 2)}/${record?.segment}`)).toBe(true);

    // The live view holds the turn, ended (its last events follow the record over the link).
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");
    const live = await it.page.request("lah.live.open", { stream: chatId });
    expect(live.live?.turn).toBe(out.generationId);
    expect(live.live?.ended?.state).toBe("done");
    expect(live.live?.events[0]?.event.kind).toBe("turn_started");

    // First-time setup is done, down to its last step. The runtime's own steps are no step of it (they are the Runtime page's), and the state says this one is ready: linked, its key minted, its connection made.
    await it.backend.settle();
    const state = await it.page.request("lah.hello", {});
    expect(state.setup.steps).toEqual([
      { id: "permissions", done: true },
      { id: "chat", done: true },
      { id: "reply", done: true },
    ]);
    expect(state.runtime.ready).toBe(true);
  });

  test("resumes its session on the next reply, and the Sessions page lists both turns", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = [
      { toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." }, "c1")] },
      "Okoro keeps it now.",
      { toolCalls: [toolCall("write_reply", { brief: "Brann sells him the oil." }, "c2")] },
      "Brann does, every market day.",
    ];
    const first = await it.generate(chatId);
    await until(() => it.host.message(chatId, first.messageId ?? "").own !== null, "the first reply's record");

    it.host.say(chatId, "user", "And who sells him the lamp oil?");
    const second = await it.generate(chatId);
    expect(second.content).toBe("Brann does, every market day.");
    await until(() => it.host.message(chatId, second.messageId ?? "").own !== null, "the second reply's record");

    // The main agent's second turn takes up what its first one did.
    const again = it.host.calls[2];
    if (again?.kind !== "call") throw new Error("the second turn's main call was expected");
    expect(again.request.messages.map((m) => m.content).join("\n")).toContain("Okoro keeps the light.");

    const turns = await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 10 });
    expect(turns.total).toBe(2);
    expect(turns.turns.map((t) => t.turn)).toEqual([second.generationId, first.generationId]);
    expect(turns.turns.every((t) => t.onPath)).toBe(true);
    expect(turns.turns[0]?.preview).toBe("Brann does, every market day.");
    expect(turns.session).toMatchObject({ turns: 2, summary: false, dropped: 0, missing: 0 });

    // The stored transcript reads back as the live view showed it.
    const transcript = turns.turns[1]?.transcript ?? "";
    const stored = await it.page.request("lah.transcript.get", { transcript, from: 1 });
    expect(stored.view.turn).toBe(first.generationId);
    expect(stored.view.ended?.state).toBe("done");
    expect(stored.view.events.length).toBeGreaterThan(3);
  });
});
