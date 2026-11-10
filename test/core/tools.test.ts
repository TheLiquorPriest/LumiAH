// The base tools (DESIGN §4.3) and the conventions their answers keep: results are paged with a
// cursor, a search says how many it found and how many it shows, an error says what to do next, and
// nothing returns more than its limit setting allows.

import { describe, expect, test } from "bun:test";
import type { JsonObject, TurnRequest } from "../../src/core/ports";
import type { SessionSegment } from "../../src/core/sessions";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { Texts } from "../../src/core/texts";
import type { AgentTool, PastTurn, ToolEnv, ToolOutcome } from "../../src/core/tools";
import { BASE_TOOLS } from "../../src/core/tools/base";
import { chatView, loreView, shortIds } from "../../src/core/views";
import { MemoryHost } from "./support/host";

const CHAT = "chat-1";

const segment = (reply: number, steps: SessionSegment["steps"]): SessionSegment => ({ v: 1, kind: "segment", reply, generationId: `gen-${reply}`, turn: "new", at: 1, request: { messages: reply, last: reply - 1 }, steps });

/** A chat of forty messages, two world books and a preset, and the base tools built over them as one turn builds them. */
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
  const env: ToolEnv = { host, turn, settings, texts: new Texts(texts), agent: "main", chat: chatView(host, CHAT, await host.chat.path(CHAT), settings.tools), lore: loreView(host, turn, settings.tools), past, writeReply: async (brief) => ({ text: `written from: ${brief}`, end: true }) };
  const tools = new Map(BASE_TOOLS.flatMap((d) => d.build(env) ?? []).map((t): [string, AgentTool] => [t.name, t]));
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
    expect([...r.tools.keys()]).toEqual(["chat_search", "chat_grep", "chat_read", "lore_index", "lore_search", "lore_grep", "lore_read", "active_lore", "preset_instructions", "past_turn", "write_reply"]);
    for (const tool of r.tools.values()) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.parameters.type).toBe("object");
      for (const arg of Object.values(tool.parameters.properties as Record<string, { description: string }>)) expect(arg.description.length).toBeGreaterThan(10);
    }
  });

  test("answers within Answer length, whatever it is asked", async () => {
    const r = await rig((s) => (s.tools = { ...s.tools, pageChars: 600, pageItems: 50 }));
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

  test("refuses a cursor it never gave, saying what to pass instead", async () => {
    const r = await rig();
    for (const [name, args] of [["chat_search", { query: "lantern" }], ["lore_index", {}], ["past_turn", { reply: 21 }]] as [string, JsonObject][]) {
      const bad = await r.run(name, { ...args, cursor: "page two" });
      expect(bad).toEqual({ text: `“page two” isn't a cursor ${name} gave. Pass the cursor exactly as the last answer wrote it, or leave it out to start at the beginning.`, error: true });
      expect((await r.run(name, { ...args, cursor: "9999" })).error).toBe(true);
    }
  });

  test("says which argument is missing, in the argument's own words", async () => {
    const r = await rig();
    expect(await r.run("chat_search")).toEqual({ text: "chat_search needs query: The words to look for. Names and rare words find the most. Call it again with query.", error: true });
    expect((await r.run("lore_read")).text).toStartWith("lore_read needs id:");
    expect((await r.run("chat_read", { from: "seven" })).text).toStartWith("chat_read needs from:");
  });
});

describe("the chat tools", () => {
  test("chat_search says how many it found and which it shows, and pages to the end by cursor", async () => {
    const r = await rig((s) => (s.tools.pageItems = 15));
    const all = await pages(r.run, "chat_search", { query: "lantern" });
    expect(all).toHaveLength(3);
    expect(all[0]).toStartWith("39 messages found; showing 1 to 15.\n- #");
    expect(all[0]).toEndWith('[There is more: call chat_search again with the same arguments and cursor "15".]');
    expect(all[1]).toStartWith("39 messages found; showing 16 to 30.");
    expect(all[2]).toStartWith("39 messages found; showing 31 to 39.");
    expect(all[2]).toEndWith("[That is the end.]");
    const hits = all.flatMap((page) => page.split("\n").filter((line) => line.startsWith("- #")));
    expect(new Set(hits).size).toBe(39);
    // The chat's text was read from the host once, however many searches.
    expect(r.host.messageReads).toBe(1);
  });

  test("chat_search ranks the message that says most of what was asked first, and shows where", async () => {
    const r = await rig();
    const found = await r.run("chat_search", { query: "Brann nets quay" });
    expect(found.text.split("\n")[1]).toStartWith("- #7 (Joss, 1199 characters): Brann ");
  });

  test("a search that finds nothing says what to try next", async () => {
    const r = await rig();
    expect(await r.run("chat_search", { query: "dragon" })).toEqual({ text: "No message of this chat matches “dragon”. Try fewer or other words (names and rare words find the most), or chat_grep for an exact phrase." });
    expect(await r.run("chat_grep", { text: "dragon" })).toEqual({ text: "No line of this chat holds “dragon”. Try a shorter piece of it, or chat_search for the words in any order." });
  });

  test("chat_grep finds every line that holds a text, in any letter case, with its message and line", async () => {
    const r = await rig();
    const found = await r.run("chat_grep", { text: "brann" });
    expect(found.text).toBe("2 lines found; showing 1 to 2.\n- #7 (Joss), line 1: Brann mends the nets by the quay.\n- #7 (Joss), line 3: Brann counts the floats.");
  });

  test("chat_read reads a run of messages, and a long message a page at a time", async () => {
    const r = await rig();
    const run = await r.run("chat_read", { from: 2, to: 4 });
    expect(run.text).toBe("Chat messages #2 to #4 (3 asked for):\n#2 (Mara), characters 0 to 48 of 48:\nMessage 2: the lantern at the mill burns bright.\n\n#3 (Joss), characters 0 to 45 of 45:\nMessage 3: the lantern at the mill burns low.\n\n#4 (Mara), characters 0 to 48 of 48:\nMessage 4: the lantern at the mill burns bright.");
    const small = await rig((s) => (s.tools.pageChars = 500));
    const all = await pages(small.run, "chat_read", { from: 7 });
    expect(all.length).toBeGreaterThan(2);
    expect(cursorOf(all[0] ?? "")).toMatch(/^7:\d+$/);
    const text = all.map((page) => page.split("\n").slice(2).join("\n").replace(/\n\[(There is more|That is the end)[^\]]*\]$/, "")).join("");
    expect(text).toBe((await small.host.chat.messages(CHAT, 7, 8))[0]?.content ?? "");
  });

  test("chat_read says which messages there are when asked for one that isn't", async () => {
    const r = await rig();
    expect(await r.run("chat_read", { from: 41 })).toEqual({ text: "There is no chat message #41: this turn reads messages #0 to #39. Give a number in that range.", error: true });
  });
});

describe("the lore tools", () => {
  test("lore_index lists each book and its entries by short id, entries switched off or always sent marked", async () => {
    const r = await rig();
    expect((await r.run("lore_index")).text).toBe(
      [
        "3 entries found; showing 1 to 3.",
        "Book “The Coast” [book-coast], 2 entries — Places along the shore.:",
        "- [11111111-a] The Mill · keys: mill, millrace · 88 characters",
        "- [11111111-b] The Quay (switched off) · keys: quay, harbour · 807 characters",
        "Book “People” [book-people], 1 entry:",
        "- [22222222] Okoro (always sent) · keys: okoro, keeper · 52 characters",
      ].join("\n"),
    );
    expect((await r.run("lore_index", { book: "people" })).text).toStartWith("1 entry found; showing 1 to 1.\nBook “People” [book-people], 1 entry:");
    expect(await r.run("lore_index", { book: "Maps" })).toEqual({ text: "No book “Maps” applies to this chat. The books are: “The Coast” [book-coast], “People” [book-people]. Give one of those, or leave book out to list them all.", error: true });
  });

  test("lore_search and lore_grep reach entries Lumiverse didn't activate, and lore_read reads one by the id they give", async () => {
    const r = await rig();
    const found = await r.run("lore_search", { query: "wheel flood" });
    expect(found.text).toStartWith("1 entry found; showing 1 to 1.\n- [11111111-a] The Mill (book “The Coast”, 88 characters): The mill stands where the river meets the sea. Its wheel has not turned since the flood.");
    expect((await r.run("lore_grep", { text: "GRANDFATHER" })).text).toBe("1 line found; showing 1 to 1.\n- [11111111-b] The Quay, line 1: The quay is stone, laid by Ilse's grandfather.");
    expect((await r.run("lore_read", { id: "11111111-a" })).text).toBe("[11111111-a] The Mill (book “The Coast”) · keys: mill, millrace · characters 0 to 88 of 88:\nThe mill stands where the river meets the sea.\nIts wheel has not turned since the flood.");
    // The whole id reads it too, and so does the id copied with its brackets.
    expect((await r.run("lore_read", { id: "[22222222]" })).text).toContain("Okoro keeps the lighthouse");
    expect((await r.run("lore_read", { id: "22222222-cccc-4000-8000-000000000003" })).text).toContain("Okoro keeps the lighthouse");
  });

  test("lore_read pages a long entry, and says what to do with an id that names none or several", async () => {
    const r = await rig((s) => (s.tools.pageChars = 400));
    const all = await pages(r.run, "lore_read", { id: "11111111-b" });
    expect(all.length).toBeGreaterThan(2);
    expect(await r.run("lore_read", { id: "33333333" })).toEqual({ text: "There is no lore entry 33333333 in the books that apply to this chat. Take an id from lore_index or a lore search, written as it gives it.", error: true });
    expect(await r.run("lore_read", { id: "1111" })).toEqual({ text: "1111 names several entries: [11111111-a] The Mill, [11111111-b] The Quay. Give more of the id.", error: true });
  });

  test("active_lore lists what Lumiverse activated for this turn", async () => {
    const r = await rig();
    expect((await r.run("active_lore")).text).toBe("1 entry found; showing 1 to 1.\n- [22222222] Okoro (book “People”, 52 characters): Okoro keeps the lighthouse and owes the mill a debt.");
    r.host.activatedLore = [];
    const none = await rig();
    none.host.activatedLore = [];
    expect((await none.run("active_lore")).text).toBe("Lumiverse activated no lore entry for this reply. lore_search and lore_index reach the books that apply.");
  });

  test("short ids are as long as it takes to name one entry", () => {
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
  test("Hits per page, Excerpt length and Line length change what a page holds", async () => {
    const r = await rig((s) => (s.tools = { ...s.tools, pageItems: 2, excerptChars: 40, lineChars: 40 }));
    const found = await r.run("chat_search", { query: "tide floats" });
    expect(found.text.split("\n")[1]?.length).toBeLessThan(90);
    const lines = (await r.run("chat_grep", { text: "lantern" })).text.split("\n");
    expect(lines[0]).toBe("39 lines found; showing 1 to 2.");
    expect(lines).toHaveLength(4);
    const long = (await r.run("chat_grep", { text: "tide runs" })).text.split("\n")[1] ?? "";
    expect(long).toMatch(/line 2: .{40}…$/);
  });

  test("a replaced text is what the model reads", async () => {
    const r = await rig(undefined, { "tool.chat_search": "Find messages.", "tool.answer.found": "{{total}} — {{from}}..{{to}}", "tool.answer.chat_search_nothing": "Nothing for {{query}}." });
    expect(r.tools.get("chat_search")?.description).toBe("Find messages.");
    expect((await r.run("chat_search", { query: "Brann" })).text).toStartWith("1 message — 1..1\n");
    expect((await r.run("chat_search", { query: "dragon" })).text).toBe("Nothing for dragon.");
  });
});
