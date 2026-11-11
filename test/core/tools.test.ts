// The base tools that read the chat's preset and the main agent's past turns, and write_reply
// (DESIGN §4.3), and the conventions every tool's answers keep: results are paged with a cursor, a
// listing says how many it found and how many it shows, an error says what to do next, and nothing
// returns more than its limit setting allows, whatever the call's arguments are. The tools that
// read the chat and its lore (§24) are built here too, so the conventions are held over them; what
// each of those answers has its own tests (`recall-*.test.ts`).

import { describe, expect, test } from "bun:test";
import type { JsonObject, TurnRequest } from "../../src/core/ports";
import type { SessionSegment } from "../../src/core/sessions";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { Texts } from "../../src/core/texts";
import type { AgentTool, PastTurn, ToolEnv, ToolOutcome } from "../../src/core/tools";
import { CHAT_TOOLS } from "../../src/core/tools/chat";
import { LORE_TOOLS } from "../../src/core/tools/lore";
import { PAST_TOOLS } from "../../src/core/tools/past-turn";
import { PRESET_TOOLS } from "../../src/core/tools/preset";
import { REPLY_TOOLS } from "../../src/core/tools/write-reply";
import { chatView, loreView, shortIds } from "../../src/core/views";
import { MemoryHost } from "./support/host";

const CHAT = "chat-1";

const segment = (reply: number, steps: SessionSegment["steps"]): SessionSegment => ({ v: 1, kind: "segment", reply, generationId: `gen-${reply}`, turn: "new", at: 1, request: { messages: reply, last: reply - 1 }, steps });

/** A chat of forty messages, two world books and a preset, and the tools this file is about built over them as one turn builds them for its main agent. */
async function rig(change: (s: Settings) => void = () => undefined, texts: Record<string, string> = {}) {
  const host = new MemoryHost();
  for (let i = 0; i < 40; i++) host.say(CHAT, i % 2 === 0 ? "user" : "assistant", i === 7 ? `Brann mends the nets by the quay.\n${"The tide runs out. ".repeat(60)}\nBrann counts the floats.` : `Message ${i}: the lantern at the mill burns ${i % 3 === 0 ? "low" : "bright"}.`);
  host.books.push({ id: "book-coast", name: "The Coast", description: "Places along the shore." }, { id: "book-people", name: "People", description: "" });
  host.entries.push(
    { id: "11111111-aaaa-4000-8000-000000000001", bookId: "book-coast", title: "The Mill", keys: ["mill", "millrace"], secondaryKeys: [], content: "The mill stands where the river meets the sea.\nIts wheel has not turned since the flood.", enabled: true, constant: false },
    { id: "11111111-bbbb-4000-8000-000000000002", bookId: "book-coast", title: "The Quay", keys: ["quay"], secondaryKeys: ["harbour"], content: `The quay is stone, laid by Ilse's grandfather.\n${"Nets dry along it. ".repeat(40)}`, enabled: false, constant: false },
    { id: "22222222-cccc-4000-8000-000000000003", bookId: "book-people", title: "Okoro", keys: ["okoro", "keeper"], secondaryKeys: [], content: "Okoro keeps the lighthouse and owes the mill a debt.", enabled: true, constant: true },
  );
  host.activatedLore = [{ entryId: "22222222-cccc-4000-8000-000000000003", bookId: "book-people", title: "Okoro", content: "Okoro keeps the lighthouse and owes the mill a debt." }];
  host.presets.set("preset-1", [
    { id: "b-main", name: "Main prompt", role: "system", kind: "instruction", marker: null, content: "Write in the present tense. {{char}} never speaks for {{user}}.", enabled: true },
    { id: "b-desc", name: "Character", role: "system", kind: "marker", marker: "char_description", content: "", enabled: true },
    { id: "b-style", name: "Style", role: "system", kind: "instruction", marker: null, content: "Short paragraphs.", enabled: false },
  ]);
  const settings = defaultSettings();
  change(settings);
  const turn: TurnRequest = { userId: "user-1", chatId: CHAT, generationId: "gen-now", kind: "new", target: { messageId: null, swipeId: 0 }, presetId: "preset-1", messages: [], params: {}, maxTokens: null };
  const past: PastTurn[] = [
    { reply: 21, hash: "a".repeat(64), segment: segment(21, [{ kind: "said", text: "First the lore." }, { kind: "call", name: "lore_search", args: { query: "mill" }, result: `1 entry found.\n${"The mill line. ".repeat(30)}\nThe wheel has not turned.` }, { kind: "call", name: "write_reply", args: { brief: "The wheel is still." }, result: "the writer wrote the reply" }]) },
    { reply: 23, hash: "b".repeat(64), segment: segment(23, [{ kind: "call", name: "chat_read", args: { from: 7 }, result: "nothing there", error: true }, { kind: "stop", reason: "the agent's time ran out" }]) },
  ];
  const env: ToolEnv = {
    host,
    run: { id: "gen-now", kind: "new", chatId: CHAT },
    turn,
    settings,
    story: { hidden: "leave_out", from: "everyone", newest: "directive" },
    texts: new Texts(texts),
    agent: "main",
    depth: 0,
    chat: chatView(host, CHAT, await host.chat.path(CHAT), settings.tools),
    lore: loreView(host, turn, settings.tools),
    past,
    writeReply: async (brief) => ({ text: `written from: ${brief}`, end: true }),
  };
  const tools = new Map([...CHAT_TOOLS, ...LORE_TOOLS, ...PRESET_TOOLS, ...PAST_TOOLS, ...REPLY_TOOLS].flatMap((d) => d.build(env) ?? []).map((t): [string, AgentTool] => [t.name, t]));
  const run = (name: string, args: JsonObject = {}): Promise<ToolOutcome> => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.run(args, { signal: new AbortController().signal, agentId: "agent_test", role: "main", callId: "c1" });
  };
  return { host, settings, tools, run };
}

/** The cursor an answer ends with, or null when it has none. */
const cursorOf = (text: string): string | null => /cursor "([^"]+)"\.\]$/.exec(text)?.[1] ?? null;

/** Every page of a tool's answer to `args`, read by following each page's cursor. */
async function pages(run: (name: string, args?: JsonObject) => Promise<ToolOutcome>, name: string, args: JsonObject): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const page: ToolOutcome = await run(name, cursor === null ? args : { ...args, cursor });
    expect(page.error).toBeUndefined();
    out.push(page.text);
    cursor = cursorOf(page.text);
  } while (cursor !== null && out.length < 100);
  return out;
}

describe("every tool", () => {
  test("is offered with a description and hand-written argument schemas, each argument described", async () => {
    const r = await rig();
    expect([...r.tools.keys()]).toEqual(expect.arrayContaining(["chat_search", "chat_grep", "chat_read", "lore_index", "lore_search", "lore_grep", "lore_read", "active_lore"]));
    expect([...r.tools.keys()].slice(-3)).toEqual(["preset_instructions", "past_turn", "write_reply"]);
    for (const tool of r.tools.values()) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.parameters.type).toBe("object");
      for (const [name, arg] of Object.entries(tool.parameters.properties as Record<string, { description?: string }>)) expect([tool.name, name, (arg.description ?? "").length > 10]).toEqual([tool.name, name, true]);
    }
  });

  test("answers within Answer length, whatever it is asked", async () => {
    const r = await rig((s) => (s.tools = { ...s.tools, pageChars: 600, pageItems: 50 }));
    // 5,000 characters that are no word and no line of anything here, and 5,000 that find every message.
    const long = "zq".repeat(2500);
    const found = "lantern ".repeat(625);
    const asks: [string, JsonObject][] = [
      ["chat_search", { query: "lantern mill" }],
      ["chat_grep", { text: "lantern" }],
      ["chat_read", { from: 0, to: 39 }],
      ["chat_read", { from: 7 }],
      ["lore_index", {}],
      ["lore_search", { query: "mill" }],
      ["lore_grep", { text: "the" }],
      ["lore_read", { id: "11111111-b" }],
      ["active_lore", {}],
      ["preset_instructions", {}],
      ["preset_instructions", { block: "Main prompt" }],
      ["past_turn", {}],
      ["past_turn", { reply: 21 }],
      ["past_turn", { reply: 21, step: 2 }],
      ["past_turn", { grep: "mill" }],
      ["chat_read", { from: 400 }],
      ["lore_read", { id: "nothing" }],
      ["past_turn", { reply: 99 }],
      // Every argument that takes text, 5,000 characters long: what it looks for, what it names, and its cursor.
      ["chat_search", { query: long }],
      ["chat_search", { query: found }],
      ["chat_search", { query: "lantern mill", cursor: long }],
      ["chat_search", { query: "lantern mill", cursor: [long] }],
      ["chat_grep", { text: long }],
      ["chat_grep", { text: "lantern", cursor: long }],
      ["chat_read", { from: 0, to: 39, cursor: long }],
      ["chat_read", { from: 7, cursor: `7:${long}` }],
      ["lore_index", { book: long }],
      ["lore_index", { cursor: long }],
      ["lore_search", { query: long }],
      ["lore_search", { query: "mill", cursor: long }],
      ["lore_grep", { text: long }],
      ["lore_grep", { text: "the", cursor: long }],
      ["lore_read", { id: long }],
      // An id that names several entries, after a book's name as long.
      ["lore_read", { id: `${long}/1111` }],
      ["lore_read", { id: "11111111-b", cursor: long }],
      ["active_lore", { cursor: long }],
      ["preset_instructions", { block: long }],
      ["preset_instructions", { cursor: long }],
      ["preset_instructions", { block: "Main prompt", cursor: long }],
      ["past_turn", { grep: long }],
      ["past_turn", { reply: 21, grep: long }],
      ["past_turn", { grep: "mill", cursor: long }],
      ["past_turn", { cursor: long }],
      ["past_turn", { reply: 21, cursor: long }],
      ["past_turn", { reply: 21, step: 2, cursor: long }],
      // And where a number is asked for.
      ["chat_read", { from: long }],
      ["chat_read", { from: 7, to: long }],
      ["past_turn", { reply: long }],
      ["past_turn", { reply: 21, step: long }],
    ];
    for (const [name, args] of asks) {
      let cursor: string | null = null;
      let read = 0;
      do {
        const page: ToolOutcome = await r.run(name, cursor === null ? args : { ...args, cursor });
        expect(page.text.length).toBeLessThanOrEqual(600);
        cursor = cursorOf(page.text);
      } while (cursor !== null && ++read < 200);
      expect(read).toBeLessThan(200);
    }
  });

  test("says a long argument back clipped at Line length, and shorter where the answer has no room for that", async () => {
    const long = "dragon ".repeat(700).trim();
    const r = await rig((s) => (s.tools.lineChars = 40));
    const start = `${long.slice(0, 39)}…`;
    expect(await r.run("past_turn", { cursor: long })).toEqual({ text: `“${start}” isn't a cursor past_turn gave. Pass the cursor exactly as the last answer wrote it, or leave it out to start at the beginning.`, error: true });
    // The list of what there is keeps its place after an argument as long.
    expect(await r.run("preset_instructions", { block: long })).toEqual({ text: `The preset has no instruction block “${start}”. Its instruction blocks are: “Main prompt” [b-main], “Style” [b-style]. Give one of those, or leave block out to list them.`, error: true });
    // Answer length as short as it may be set, with Line length longer than it: the argument gives way, never what to do next.
    const small = await rig((s) => (s.tools = { ...s.tools, pageChars: 200, lineChars: 300 }));
    for (const [name, args] of [["chat_grep", { text: long }], ["lore_read", { id: long }], ["lore_index", { book: long }], ["preset_instructions", { block: long }], ["past_turn", { grep: long }], ["past_turn", { cursor: long }]] as [string, JsonObject][]) {
      const { text } = await small.run(name, args);
      expect({ name, length: text.length <= 200 ? "within" : text.length }).toEqual({ name, length: "within" });
    }
    for (const [name, args] of [["preset_instructions", { block: long }], ["past_turn", { grep: long }], ["past_turn", { cursor: long }]] as [string, JsonObject][]) expect([name, /\.$/.test((await small.run(name, args)).text)]).toEqual([name, true]);
  });

  test("refuses a cursor it never gave, saying what to pass instead", async () => {
    const r = await rig();
    for (const [name, args] of [["preset_instructions", {}], ["past_turn", {}], ["past_turn", { reply: 21 }]] as [string, JsonObject][]) {
      const bad = await r.run(name, { ...args, cursor: "page two" });
      expect(bad).toEqual({ text: `“page two” isn't a cursor ${name} gave. Pass the cursor exactly as the last answer wrote it, or leave it out to start at the beginning.`, error: true });
      expect((await r.run(name, { ...args, cursor: "9999" })).error).toBe(true);
    }
    // The tools that read the chat and its lore refuse one too.
    for (const [name, args] of [["chat_grep", { text: "lantern" }], ["lore_index", {}]] as [string, JsonObject][]) expect([name, (await r.run(name, { ...args, cursor: "page two" })).error]).toEqual([name, true]);
  });

  test("says which argument is missing, in the argument's own words", async () => {
    const r = await rig();
    expect(await r.run("write_reply")).toEqual({ text: "write_reply needs brief: what the writer needs that the prompt doesn't already give it. When the prompt holds everything, say that in a line. Call write_reply again with brief.", error: true });
    for (const name of ["chat_grep", "lore_grep"]) expect((await r.run(name)).text).toStartWith(`${name} needs text:`);
  });
});

describe("short ids", () => {
  test("are as long as it takes to name one thing", () => {
    expect(shortIds(["abcdefgh-1", "abcdefgh-2", "zzzzzzzz-9", "short"], 8)).toEqual(["abcdefgh-1", "abcdefgh-2", "zzzzzzzz", "short"]);
  });
});

describe("the preset's instructions", () => {
  test("are listed in order, markers left out, those switched off marked; one is read whole, as the preset has it", async () => {
    const r = await rig();
    expect((await r.run("preset_instructions")).text).toBe(
      ["2 instruction blocks found; showing 1 to 2.", "- [b-main] “Main prompt” (system, 63 characters): Write in the present tense. {{char}} never speaks for {{user}}.", "- [b-style] “Style” (system, switched off, 17 characters): Short paragraphs."].join("\n"),
    );
    expect((await r.run("preset_instructions", { block: "style" })).text).toBe("Preset instruction “Style” [b-style] (system, switched off), characters 0 to 17 of 17:\nShort paragraphs.");
    expect(await r.run("preset_instructions", { block: "Tone" })).toEqual({ text: "The preset has no instruction block “Tone”. Its instruction blocks are: “Main prompt” [b-main], “Style” [b-style]. Give one of those, or leave block out to list them.", error: true });
  });
});

describe("past_turn", () => {
  test("lists the turns, lists a turn's steps, and reads one step in full", async () => {
    const r = await rig();
    expect((await r.run("past_turn")).text).toBe(
      ["Your earlier turns in this chat, oldest first. Give reply to list one turn's steps.", "2 turns found; showing 1 to 2.", "- Reply #21 (new): a request of 21 messages, ending at chat message #20. You took 3 steps.", "- Reply #23 (new): a request of 23 messages, ending at chat message #22. You took 2 steps."].join("\n"),
    );
    const steps = (await r.run("past_turn", { reply: 21 })).text.split("\n");
    expect(steps.slice(0, 4)).toEqual(["Reply #21 (new): a request of 21 messages, ending at chat message #20.", "Its steps, in full as they were; read one whole with step:", "3 steps found; showing 1 to 3.", "1. a note of yours (15 characters): First the lore."]);
    expect(steps[4]).toStartWith('2. lore_search {"query":"mill"} (');
    const whole = (await r.run("past_turn", { reply: 21, step: 2 })).text;
    expect(whole).toStartWith('Reply #21, step 2: lore_search {"query":"mill"}, characters 0 to ');
    // A call's step is its arguments whole, then what came back.
    expect(whole.split("\n").slice(1, 3)).toEqual(['{"query":"mill"}', "1 entry found."]);
    expect(whole).toEndWith("The wheel has not turned.");
    expect((await r.run("past_turn", { reply: 23 })).text).toContain('1. chat_read {"from":7}, which failed (24 characters): nothing there');
  });

  test("greps one turn, or the latest turns, and says where it looked when it finds nothing", async () => {
    const r = await rig();
    // A call's arguments are part of its step, so a brief is found where it was written.
    expect((await r.run("past_turn", { grep: "WHEEL" })).text).toBe('2 lines found; showing 1 to 2.\n- reply #21, step 2, line 4: The wheel has not turned.\n- reply #21, step 3, line 1: {"brief":"The wheel is still."}');
    expect((await r.run("past_turn", { reply: 23, grep: "wheel" })).text).toBe("No line of reply #23 holds “wheel”. Try a shorter piece of it, or give reply to search one turn.");
    expect((await r.run("past_turn", { grep: "dragon" })).text).toStartWith("No line of your latest 2 turns holds “dragon”.");
  });

  test("names the turns and steps there are when asked for one that isn't", async () => {
    const r = await rig();
    expect(await r.run("past_turn", { reply: 5 })).toEqual({ text: "Reply #5 is no turn of yours on this chat. Your turns are replies #21, #23. Give one of those.", error: true });
    expect(await r.run("past_turn", { reply: 23, step: 9 })).toEqual({ text: "Reply #23 has 2 steps: give step 1 to 2.", error: true });
  });
});

describe("write_reply", () => {
  test("hands the turn its brief, and is refused without one", async () => {
    const r = await rig();
    expect(await r.run("write_reply", { brief: " Keep the lamp lit. " })).toEqual({ text: "written from: Keep the lamp lit.", end: true });
    expect((await r.run("write_reply", {})).error).toBe(true);
  });
});

describe("limits and texts are the user's", () => {
  test("Hits per page and Line length change what a page holds", async () => {
    const r = await rig((s) => (s.tools = { ...s.tools, pageItems: 1, lineChars: 20 }));
    const lines = (await r.run("past_turn", { grep: "wheel" })).text.split("\n");
    expect(lines[0]).toBe("2 lines found; showing 1 to 1.");
    // One hit a page, its line cut at Line length, and how to read on.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("- reply #21, step 2, line 4: The wheel has not tu…");
    expect(lines[2]).toBe('[There is more: call past_turn again with the same arguments and cursor "1".]');
    expect((await r.run("preset_instructions")).text.split("\n")).toHaveLength(3);
  });

  test("a replaced text is what the model reads", async () => {
    const r = await rig(undefined, { "tool.preset_instructions": "List the preset.", "tool.answer.found": "{{total}} — {{from}}..{{to}}", "tool.answer.preset_no_block": "No block {{block}}." });
    expect(r.tools.get("preset_instructions")?.description).toBe("List the preset.");
    expect((await r.run("preset_instructions")).text).toStartWith("2 instruction blocks — 1..2\n");
    expect(await r.run("preset_instructions", { block: "Tone" })).toEqual({ text: "No block Tone.", error: true });
  });
});
