// What a receipt keeps of a turn (DESIGN §5): the start of each call's arguments and of each result,
// each within its own length setting, with how to read the whole. A file written in one turn, or a
// long brief, is never carried whole in the notes of the turns after.

import { describe, expect, test } from "bun:test";
import { createHarness } from "../../src/core/harness";
import type { ModelRequest } from "../../src/core/ports";
import { carriedOf, receiptOf, stepText } from "../../src/core/receipts";
import type { SessionSegment } from "../../src/core/sessions";
import { defaultSettings } from "../../src/core/settings";
import { Texts } from "../../src/core/texts";
import { call, MemoryHost, runTurn } from "./support/host";

const CHAT = "chat-1";
const TIDES = "The tide table for the season, line after line. ".repeat(700);
const isMain = (request: ModelRequest): boolean => request.tools?.some((t) => t.name === "write_reply") === true;

const segment = (steps: SessionSegment["steps"]): SessionSegment => ({ v: 1, kind: "segment", reply: 7, generationId: "gen-7", turn: "new", at: 1000, request: { messages: 12, last: 6 }, steps });

describe("a receipt", () => {
  test("keeps a call's arguments up to their own length, and says where the whole is", () => {
    const texts = new Texts({});
    const args = { path: "/tides.md", content: TIDES, base: "new" };
    const json = JSON.stringify(args);
    const wrote = segment([
      { kind: "said", text: "I will keep the tide table." },
      { kind: "call", name: "workspace_write", args, result: "Wrote /tides.md." },
      { kind: "call", name: "write_reply", args: { brief: "Okoro opens the door." }, result: "the writer wrote the reply" },
    ]);
    const receipt = receiptOf(wrote, { receiptChars: 600, receiptArgChars: 80 }, texts);
    expect(receipt).toBe(
      [
        "What you did:",
        "- you noted: I will keep the tide table.",
        `- workspace_write ${json.slice(0, 80)}… (arguments of ${json.length} characters in all; past_turn with reply 7 and step 2 reads them whole)`,
        "  → Wrote /tides.md.",
        '- write_reply {"brief":"Okoro opens the door."}',
        "  → the writer wrote the reply",
      ].join("\n"),
    );
    // What past_turn reads of the step is whole, as before.
    expect(stepText(wrote.steps[1] ?? { kind: "said", text: "" })).toBe(`${json}\nWrote /tides.md.`);
    // The two lengths are two settings: one doesn't cut what the other keeps.
    const long = segment([{ kind: "call", name: "chat_read", args: { from: 3 }, result: "x".repeat(900) }]);
    expect(receiptOf(long, { receiptChars: 100, receiptArgChars: 0 }, texts)).toBe(`What you did:\n- chat_read … (arguments of 10 characters in all; past_turn with reply 7 and step 1 reads them whole)\n  → ${"x".repeat(100)}… (900 characters in all; past_turn with reply 7 reads it whole)`);
    expect(receiptOf(long, { receiptChars: 1000, receiptArgChars: 10 }, texts)).toBe(`What you did:\n- chat_read {"from":3}\n  → ${"x".repeat(900)}`);
  });

  test("of a failed call cuts its arguments the same way, in the user's own words where they replaced the text", () => {
    const texts = new Texts({ "session.receipt.args_clipped": "{{text}} [cut: {{chars}}; reply {{reply}}, step {{step}}]" });
    const failed = segment([{ kind: "call", name: "workspace_edit", args: { path: "/tides.md", find: TIDES, replace: "", base: "abc" }, result: "Nothing was changed.", error: true }]);
    expect(receiptOf(failed, { receiptChars: 600, receiptArgChars: 30 }, texts)).toBe(`What you did:\n- workspace_edit {"path":"/tides.md","find":"Th [cut: ${JSON.stringify(failed.steps[0]?.kind === "call" ? failed.steps[0].args : {}).length}; reply 7, step 1]\n  → failed: Nothing was changed.`);
  });

  test("what the main agent carries is counted with the arguments cut", () => {
    const texts = new Texts({});
    const turn = { reply: 7, hash: "h", segment: segment([{ kind: "call", name: "workspace_write", args: { path: "/tides.md", content: TIDES, base: "new" }, result: "Wrote /tides.md." }]) };
    const carried = carriedOf({ summary: null, turns: [turn] }, { receiptChars: 600, receiptArgChars: 600, charsPerToken: 4, texts });
    expect(carried.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(carried.history[1]?.content.length).toBeLessThan(900);
    expect(carried.tokens).toBeLessThan(300);
  });
});

describe("the notes of the turns after a long write", () => {
  test("a file written in one turn is not sent again in the next turn's prompt: its start is, with how to read it whole", async () => {
    const host = new MemoryHost();
    let n = 0;
    host.script = (request) => {
      if (!isMain(request)) return "The door opens.";
      n++;
      return n === 1 ? { toolCalls: [call("workspace_write", { path: "/tides.md", content: TIDES, base: "new" }, "a1")] } : { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, `w${n}`)] };
    };
    host.say(CHAT, "assistant", "The harbour is quiet tonight.");
    host.say(CHAT, "user", "I walk down to the lighthouse and knock.");
    const stored = { values: defaultSettings(), texts: {} as Record<string, string> };
    const harness = createHarness(host, { settings: async () => structuredClone(stored) });
    await runTurn(host, harness, CHAT);
    host.say(CHAT, "user", "I wait.");
    await runTurn(host, harness, CHAT);
    const next = host.calls.findLast(isMain);
    const sent = (next?.messages ?? []).map((m) => m.content).join("\n");
    const { receiptArgChars } = stored.values.session;
    expect(receiptArgChars).toBe(600);
    expect(sent).toContain('- workspace_write {"path":"/tides.md","content":"The tide table for the season');
    expect(sent).toContain(`(arguments of ${JSON.stringify({ path: "/tides.md", content: TIDES, base: "new" }).length} characters in all; past_turn with reply 2 and step 1 reads them whole)`);
    expect(sent).not.toContain(TIDES.slice(0, receiptArgChars + 100));
    expect(sent.length).toBeLessThan(TIDES.length / 2);
    // A shorter length holds from the next turn, with nothing stored changed.
    stored.values.session.receiptArgChars = 40;
    host.say(CHAT, "user", "I knock again.");
    await runTurn(host, harness, CHAT);
    const later = (host.calls.findLast(isMain)?.messages ?? []).map((m) => m.content).join("\n");
    expect(later).toContain(`- workspace_write ${JSON.stringify({ path: "/tides.md", content: TIDES, base: "new" }).slice(0, 40)}… (arguments of`);
  });
});
