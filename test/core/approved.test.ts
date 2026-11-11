// What the user approved "for this chat" (DESIGN §17), as the page reads it and takes it back:
// `harness.approvals.kept` lists a chat's kept approvals, or every chat's, the newest first, and
// `harness.approvals.forget` takes one out, after which the tool asks again.

import { describe, expect, test } from "bun:test";
import { forgetApproval, keepApproval, keptApprovals } from "../../src/core/approved";
import { createHarness } from "../../src/core/harness";
import { DOC } from "../../src/core/paths";
import type { ApprovalAsk, ModelRequest, ModelToolCall, StorePort } from "../../src/core/ports";
import { HarnessRefusal } from "../../src/core/refusal";
import { defaultSettings } from "../../src/core/settings";
import { call, MemoryHost, runTurn } from "./support/host";

const ONE = "chat-1";
const TWO = "chat-2";

/** Two chats on a host whose user answers every held call with "for this chat"; write tools ask first. A turn's main agent makes `calls` in its first round, then has the reply written. */
function rig() {
  const host = new MemoryHost();
  const asks: ApprovalAsk[] = [];
  host.approvals = {
    ask: async (ask) => {
      asks.push(ask);
      return { decision: "chat" };
    },
  };
  let calls: ModelToolCall[] = [];
  host.script = (request: ModelRequest) => {
    if (!request.tools) return "The door opens.";
    const answered = request.messages.at(-1)?.parts?.some((part) => part.type === "tool_result") === true;
    return answered || calls.length === 0 ? { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "w1")] } : { toolCalls: calls };
  };
  for (const chat of [ONE, TWO]) host.say(chat, "assistant", "The harbour is quiet tonight.");
  const stored = { values: defaultSettings(), texts: {} as Record<string, string> };
  stored.values.approval.tiers.write = "ask";
  const harness = createHarness(host, { settings: async () => structuredClone(stored) });
  /** One turn in a chat, an hour after the one before it, whose main agent makes these calls. */
  const turn = async (chat: string, ...made: ModelToolCall[]): Promise<number> => {
    host.clock.advance(3_600_000);
    calls = made;
    host.say(chat, "user", "I walk down to the lighthouse and knock.");
    await runTurn(host, harness, chat);
    return host.clock.now();
  };
  return { host, harness, asks, turn };
}

const write = (path: string, id: string): ModelToolCall => call("workspace_write", { path, content: "Brann holds the key.", base: "new" }, id);

async function refusal(asked: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await asked;
  } catch (error) {
    if (error instanceof HarnessRefusal) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("the request wasn't refused");
}

describe("the approvals a user keeps", () => {
  test("are listed for a chat and for every chat, the newest first, each with when it was given", async () => {
    const r = rig();
    const first = await r.turn(ONE, write("learned/a.md", "c1"));
    const second = await r.turn(TWO, write("learned/a.md", "c2"));
    const third = await r.turn(ONE, call("workspace_pin", { path: "learned/a.md", pinned: true }, "c3"));
    expect(r.asks.map((ask) => [ask.chatId, ask.tool])).toEqual([
      [ONE, "workspace_write"],
      [TWO, "workspace_write"],
      [ONE, "workspace_pin"],
    ]);
    expect(await r.harness.approvals.kept({ chatId: null })).toEqual({
      kept: [
        { chatId: ONE, tool: "workspace_pin", at: third },
        { chatId: TWO, tool: "workspace_write", at: second },
        { chatId: ONE, tool: "workspace_write", at: first },
      ],
    });
    expect((await r.harness.approvals.kept({ chatId: TWO })).kept).toEqual([{ chatId: TWO, tool: "workspace_write", at: second }]);
    expect((await r.harness.approvals.kept({ chatId: "chat-none" })).kept).toEqual([]);
    // Kept, the tool runs without asking in that chat.
    await r.turn(ONE, write("learned/b.md", "c4"));
    expect(r.asks).toHaveLength(3);
  });

  test("a forgotten approval is gone from its chat alone, and the tool asks again from the next run on", async () => {
    const r = rig();
    await r.turn(ONE, write("learned/a.md", "c1"));
    const two = await r.turn(TWO, write("learned/a.md", "c2"));
    const pinned = await r.turn(ONE, call("workspace_pin", { path: "learned/a.md", pinned: true }, "c3"));
    expect(await r.harness.approvals.forget({ chatId: ONE, tool: "workspace_write" })).toEqual({ kept: [{ chatId: ONE, tool: "workspace_pin", at: pinned }] });
    expect((await r.harness.approvals.kept({ chatId: null })).kept).toEqual([
      { chatId: ONE, tool: "workspace_pin", at: pinned },
      { chatId: TWO, tool: "workspace_write", at: two },
    ]);
    // Forgetting what isn't kept changes nothing and answers with what is.
    expect(await r.harness.approvals.forget({ chatId: ONE, tool: "workspace_write" })).toEqual({ kept: [{ chatId: ONE, tool: "workspace_pin", at: pinned }] });
    const asked = r.asks.length;
    // The other chat still runs it without a word; this one asks, and keeps the new word with its own time.
    await r.turn(TWO, write("learned/b.md", "c4"));
    expect(r.asks).toHaveLength(asked);
    const again = await r.turn(ONE, write("learned/b.md", "c5"));
    expect(r.asks.slice(asked).map((ask) => [ask.chatId, ask.tool])).toEqual([[ONE, "workspace_write"]]);
    expect((await r.harness.approvals.kept({ chatId: ONE })).kept).toEqual([
      { chatId: ONE, tool: "workspace_write", at: again },
      { chatId: ONE, tool: "workspace_pin", at: pinned },
    ]);
    // A chat left with none keeps no document.
    await r.harness.approvals.forget({ chatId: TWO, tool: "workspace_write" });
    expect(r.host.documents.has(DOC.approvals(TWO))).toBe(false);
    expect((await r.harness.approvals.kept({ chatId: null })).kept.map((row) => row.chatId)).toEqual([ONE, ONE]);
  });

  test("one kept before times were is listed after the others, with no time, and forgetting a neighbour keeps it", async () => {
    const r = rig();
    await r.host.store.write(DOC.approvals(ONE), { v: 1, kind: "approvals", tools: ["workspace_edit", "workspace_move"] });
    const at = await r.turn(ONE, write("learned/a.md", "c1"));
    expect((await r.harness.approvals.kept({ chatId: ONE })).kept).toEqual([
      { chatId: ONE, tool: "workspace_write", at },
      { chatId: ONE, tool: "workspace_move", at: null },
      { chatId: ONE, tool: "workspace_edit", at: null },
    ]);
    expect((await r.harness.approvals.forget({ chatId: ONE, tool: "workspace_move" })).kept).toEqual([
      { chatId: ONE, tool: "workspace_write", at },
      { chatId: ONE, tool: "workspace_edit", at: null },
    ]);
    // The document is still one every build reads: its tools, in the order they were approved.
    expect(r.host.documents.get(DOC.approvals(ONE))).toEqual({ v: 1, kind: "approvals", tools: ["workspace_edit", "workspace_write"], at: { workspace_write: at } });
  });

  test("changes made at once are made one after another: none writes over what another kept or took out", async () => {
    const host = new MemoryHost();
    await Promise.all([keepApproval(host, ONE, "a"), keepApproval(host, ONE, "b"), forgetApproval(host, ONE, "a"), keepApproval(host, ONE, "c"), keepApproval(host, ONE, "b")]);
    expect((await keptApprovals(host.store, ONE)).map((kept) => kept.tool)).toEqual(["b", "c"]);
    // A tool whose name is a word every object knows is kept like any other.
    await keepApproval(host, ONE, "__proto__");
    await keepApproval(host, ONE, "constructor");
    expect((await keptApprovals(host.store, ONE)).map((kept) => [kept.tool, kept.at])).toEqual([
      ["b", host.clock.now()],
      ["c", host.clock.now()],
      ["__proto__", host.clock.now()],
      ["constructor", host.clock.now()],
    ]);
    // What isn't such a document reads as nothing kept.
    await host.store.write(DOC.approvals(TWO), { v: 1, kind: "approvals", tools: "all" });
    expect(await keptApprovals(host.store, TWO)).toEqual([]);
  });

  test("is refused in words for a request that names no chat or no tool, and for every chat at once where the store can't list", async () => {
    const r = rig();
    await r.turn(ONE, write("learned/a.md", "c1"));
    const loose = r.harness.approvals.forget as (input: unknown) => Promise<unknown>;
    expect(await refusal(loose({ chatId: ONE }))).toEqual({ code: "bad_request", message: "Say which tool to forget, and for which chat." });
    expect(await refusal(loose({ tool: "workspace_write" }))).toEqual({ code: "bad_request", message: "Say which tool to forget, and for which chat." });
    const store: StorePort = r.host.store;
    delete store.list;
    expect(await refusal(r.harness.approvals.kept({ chatId: null }))).toEqual({ code: "unavailable", message: "This runtime can't list its documents, so what you approved can be read for one chat at a time only." });
    expect((await r.harness.approvals.kept({ chatId: ONE })).kept.map((row) => row.tool)).toEqual(["workspace_write"]);
  });
});
