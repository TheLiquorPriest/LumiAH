// What an agent runs on when no connection is set for it, and what the writer is given beside the
// brief. A turn reaches the runtime over the loopback connection, which no agent may call, so an
// agent with none of its own set runs on the chat's own connection, else on the user's default.

import { describe, expect, test } from "bun:test";
import { createHarness, type Harness } from "../../src/core/harness";
import type { ModelRequest } from "../../src/core/ports";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { call, MemoryHost, runTurn, type Script } from "./support/host";

const CHAT = "chat-1";
const never = new AbortController().signal;

const isMain = (request: ModelRequest): boolean => request.tools?.some((t) => t.name === "write_reply") === true;
const BRIEF: Script = (request) => (isMain(request) ? { toolCalls: [call("write_reply", { brief: "Okoro opens the door a hand's width." }, "w1")] } : "The door opens.");

function rig(script: Script = BRIEF, change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  host.script = script;
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I walk down to the lighthouse and knock.");
  const stored = { values: defaultSettings(), texts: {} as Record<string, string> };
  change(stored.values);
  const harness: Harness = createHarness(host, { settings: async () => structuredClone(stored) });
  return { host, harness, stored };
}

describe("the chat's own connection", () => {
  test("an agent with no connection set runs on the chat's own; one with its own keeps it; with neither, the user's default", async () => {
    const r = rig();
    r.host.infos.set(CHAT, { connectionId: "conn-writer" });
    await runTurn(r.host, r.harness, CHAT, {});
    expect(r.host.calls.map((c) => c.connectionId)).toEqual(["conn-writer", "conn-writer"]);
    const own = rig(BRIEF, (s) => {
      (s.agents.main as NonNullable<typeof s.agents.main>).connectionId = "conn-main";
    });
    own.host.infos.set(CHAT, { connectionId: "conn-writer" });
    await runTurn(own.host, own.harness, CHAT, {});
    expect(own.host.calls.map((c) => c.connectionId)).toEqual(["conn-main", "conn-writer"]);
    const none = rig();
    await runTurn(none.host, none.harness, CHAT, {});
    expect(none.host.calls.map((c) => c.connectionId)).toEqual([null, null]);
  });

  test("a chat's job uses the chat's own, which the host gives with the chat", async () => {
    const r = rig(["The notes are tidy.", "Nothing to add."]);
    r.host.infos.set(CHAT, { connectionId: "conn-writer" });
    const { job } = await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: "Tidy the notes.", when: "now" });
    await r.harness.jobs.run({ id: job.id }, never);
    expect(r.host.calls[0]?.connectionId).toBe("conn-writer");
  });
});

describe("the writer and the agents' guidance", () => {
  test("off, as it ships, the writer's call holds the brief alone; on, the guidance goes beside it, each level named", async () => {
    const r = rig();
    await r.harness.guidance.set({ chatId: CHAT, level: "user", text: "Keep replies under eighty words.", base: null });
    await r.harness.guidance.set({ chatId: CHAT, level: "chat", text: "Okoro never raises his voice.", base: null });
    await runTurn(r.host, r.harness, CHAT, {});
    expect(JSON.stringify(r.host.calls[1]?.messages)).not.toContain("Keep replies under eighty words.");
    r.stored.values.reply.writerGuidance = true;
    r.host.say(CHAT, "user", "I knock again.");
    await runTurn(r.host, r.harness, CHAT, {});
    const writer = r.host.calls.at(-1)?.messages ?? [];
    const added = writer.find((m) => m.content.includes("Okoro opens the door a hand's width."))?.content ?? "";
    expect(added).toStartWith("[Guidance from the user, for every chat. Follow it.]\nKeep replies under eighty words.\n\n[Guidance for this chat. Follow it.]\nOkoro never raises his voice.\n\n");
  });
});
