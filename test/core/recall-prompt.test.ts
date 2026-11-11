// What the prompt already holds (DESIGN §24.1): the three notes the main agent is given with the
// request, worked out by code from the flags Lumiverse puts on the prompt's messages, the entries it
// says it activated, the chat's books and the chat's path; the same as plain data in the trace; and
// how the chat's lore stood at the turn, kept for the tools and the page.

import { describe, expect, test } from "bun:test";
import type { Book } from "../../src/core/book";
import { createHarness } from "../../src/core/harness";
import type { PresetBlock, RequestMessage, TraceEvent, TurnRequest } from "../../src/core/ports";
import { Recall, recallOf } from "../../src/core/recall/recall";
import { recallTold } from "../../src/core/recall/turn";
import { requestDocument } from "../../src/core/request";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { clip } from "../../src/core/util";
import { CHAT, harbour, type RecallHost, toolRig } from "./recall-support";
import { call, Sink } from "./support/host";

const OKORO = "22222222-aaaa-4000-8000-000000000004";
const BRANN = "22222222-bbbb-4000-8000-000000000005";
const LIGHTHOUSE = "11111111-bbbb-4000-8000-000000000002";
const CUSTOMS = "11111111-aaaa-4000-8000-000000000001";
const MILL = "11111111-cccc-4000-8000-000000000003";

const chars = (host: RecallHost, id: string): number => host.entries.find((e) => e.id === id)?.content.length ?? -1;

/** The chat's messages from `from` on, as Lumiverse flags them in a request. */
const history = (host: RecallHost, from: number): RequestMessage[] => host.requestOf(CHAT, 12, null).slice(from);

/** Lumiverse activated these: each as `LorePort` gives it. */
function activate(host: RecallHost, ...ids: string[]): void {
  host.activatedLore = ids.map((id) => {
    const entry = host.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`no entry ${id}`);
    return { entryId: id, bookId: entry.bookId, title: entry.title, content: entry.content };
  });
}

/** The lore a turn's trace says the prompt held. */
const heldOf = (events: readonly TraceEvent[]) => events.flatMap((event) => (event.kind === "prompt_held" ? event.lore : []));

/** The notes of a turn whose request is `messages`, the trace events they made, and the request as the main agent reads it. */
async function told(host: RecallHost, messages: RequestMessage[], options: { settings?: (s: Settings) => void; blocks?: PresetBlock[]; writes?: boolean; book?: Book; texts?: Record<string, string> } = {}) {
  const rig = await toolRig(host, [], { turn: { messages }, ...(options.settings ? { settings: options.settings } : {}), ...(options.book ? { book: options.book } : {}), ...(options.texts ? { texts: options.texts } : {}) });
  const events: TraceEvent[] = [];
  const path = await host.chat.path(CHAT);
  const blocks = options.blocks ?? [];
  const recall = await recallTold(recallOf(rig.env), { path, blocks, writes: options.writes ?? false, learned: rig.env.workspace?.areas.learned ?? null, jobs: null, emit: (event) => events.push(event), log: host.log, now: 5 });
  return { ...recall, events, rig, document: requestDocument(messages, blocks, path, rig.env.texts, recall).text };
}

describe("the three notes", () => {
  test("say which lore the prompt holds and how it got there, which it doesn't, and which chat messages it holds word for word", async () => {
    const host = harbour();
    activate(host, OKORO, LIGHTHOUSE);
    host.activatedHow.set(LIGHTHOUSE, { how: "vector", score: 0.712 });
    const messages: RequestMessage[] = [{ role: "system", content: "Write in the present tense." }, host.loreMessage(OKORO), host.loreMessage(LIGHTHOUSE, false), ...history(host, 6)];
    const { notes, document } = await told(host, messages);
    const [lore, index, past] = notes.split("\n\n");
    expect(lore).toBe(
      [
        `Lore in the prompt (2 entries, about ${Math.ceil(chars(host, OKORO) / 3.2) + Math.ceil(chars(host, LIGHTHOUSE) / 3.2)} tokens). The writer already has these:`,
        `- [22222222-a] Okoro · ${chars(host, OKORO)} characters · always sent · message [2]`,
        `- [11111111-b] The Lighthouse · ${chars(host, LIGHTHOUSE)} characters · matched by meaning, score 0.71 · message [3]`,
      ].join("\n"),
    );
    // The entries the prompt doesn't hold, the one switched off left out: each by the id the lore tools take.
    const lines = (index ?? "").split("\n");
    expect(lines[0]).toBe("Lore not in the prompt (3 entries; the best match for the latest messages first). The writer doesn't have these. To give the writer one whole, name its id in write_reply's add; lore_read reads it first if you need to.");
    expect(lines.slice(1).sort()).toEqual([`- [11111111-a] The Customs House · keys: customs house, strongbox · ${chars(host, CUSTOMS)} characters`, `- [22222222-b] Brann · keys: brann · ${chars(host, BRANN)} characters`, "- [22222222-c] Ilse · keys: ilse, miller · 57 characters"].sort());
    expect(past).toBe("History in the prompt: the request holds chat messages #6 to #11 word for word (6 of 12 messages). It doesn't hold #0 to #5. Nothing in the request stands in for them: chat_outline, chat_about and chat_search reach them.");
    // The request names each world-info message as the entry it is, and the notes follow its messages.
    expect(document).toContain(`[2] system · lore entry [22222222-a] Okoro\n${host.entries.find((e) => e.id === OKORO)?.content}`);
    expect(document).toContain("[3] system · lore entry [11111111-b] The Lighthouse\n");
    expect(document).toEndWith(notes);
    expect(document.indexOf("[9] assistant · chat message #11")).toBeLessThan(document.indexOf("Lore in the prompt"));
  });

  test("how an entry got there is only what Lumiverse said: a key is named where Lumiverse names it, and none is worked out from the chat (M8)", async () => {
    const host = harbour();
    activate(host, CUSTOMS, BRANN, LIGHTHOUSE);
    // Lumiverse names the key for the first, says only that a key matched for the second, and says nothing of how for the third.
    host.activatedHow.set(CUSTOMS, { how: "key", key: "customs house" });
    host.activatedHow.set(LIGHTHOUSE, { how: null });
    const { notes, events } = await told(host, [host.loreMessage(CUSTOMS), host.loreMessage(BRANN), host.loreMessage(LIGHTHOUSE), ...history(host, 6)]);
    expect(notes).toContain(`- [11111111-a] The Customs House · ${chars(host, CUSTOMS)} characters · key “customs house” matched · message [1]`);
    expect(notes).toContain(`- [22222222-b] Brann · ${chars(host, BRANN)} characters · a key matched · message [2]`);
    expect(notes).toContain(`- [11111111-b] The Lighthouse · ${chars(host, LIGHTHOUSE)} characters · activated by Lumiverse · message [3]`);
    // Message #7 says "strongbox", another of the first entry's keys, and "brann" stands in the chat: neither is told as what matched.
    expect(history(host, 6).some((m) => m.content.includes("strongbox"))).toBe(true);
    expect(notes).not.toContain("“strongbox” matched");
    expect(notes).not.toContain("“brann” matched");
    expect(heldOf(events).map((entry) => entry.why)).toEqual([{ by: "key", key: "customs house" }, { by: "key", key: null }, { by: "unknown" }]);
  });

  test("tell the main agent how to give the writer an entry only where it briefs a writer and may add", async () => {
    const host = harbour();
    const add = "To give the writer one whole, name its id in write_reply's add";
    expect((await told(host, history(host, 6))).notes).toContain(add);
    expect((await told(harbour(), history(host, 6), { writes: true })).notes).not.toContain(add);
    expect((await told(harbour(), history(host, 6), { settings: (s) => (s.recall.writer.add = false) })).notes).not.toContain(add);
  });
});

describe("the lore the prompt holds", () => {
  test("a flagged message Lumiverse doesn't name is an entry only where its text is exactly that entry's (M8)", async () => {
    const filled = "Brann was master of the Heron. He says the brass key went down with her.\nHis debt is the longest page in Ilse's ledger.";
    const brannFilled = (): RecallHost => {
      const host = harbour();
      activate(host, BRANN);
      // The stored text holds a macro; what Lumiverse says it put in the prompt for the entry has it filled.
      host.entries.find((e) => e.id === BRANN)!.content = `{{char}}${filled.slice("Brann".length)}`;
      host.activatedLore[0]!.content = filled;
      return host;
    };
    // Exactly that text, the blanks around it aside: the message is the entry.
    const exact = brannFilled();
    const same = await told(exact, [{ role: "system", content: `${filled}\n`, source: { kind: "lore" } }, ...history(exact, 10)]);
    expect(heldOf(same.events)).toMatchObject([{ entryId: BRANN, bookId: "book-people", title: "Brann", message: 1, why: { by: "key", key: null } }]);
    expect(same.notes).not.toContain("Activated by Lumiverse, but");

    // Most of the entry's words, and not its text: no entry is named for it. It is told as a World Info message Lumiverse didn't name, and the activated entry as one the request doesn't show.
    const near = brannFilled();
    const text = "Brann was master of the Heron, and he says the brass key went down with her. His debt is the longest page in the ledger.";
    const other = await told(near, [{ role: "system", content: text, source: { kind: "lore" } }, ...history(near, 10)]);
    expect(other.notes.split("\n\n")[0]).toBe(
      [
        `Lore in the prompt (1 entry, about ${Math.ceil(text.length / 3.2)} tokens). The writer already has these:`,
        `- world info Lumiverse didn't name · ${text.length} characters · message [1] · opens: ${clip(text, 60)}`,
        "Activated by Lumiverse, but their text is not in the request (1 entry). The writer doesn't have these. To give the writer one whole, name its id in write_reply's add.",
        `- [22222222-b] Brann · ${filled.length} characters · a key matched`,
      ].join("\n"),
    );
    expect(heldOf(other.events)).toMatchObject([{ entryId: "", bookId: null, message: 1, why: { by: "unknown" } }]);
    expect(other.document).toContain("[1] system · world info (Lumiverse doesn't say which entry)\n");

    // A message with exactly the text of an entry of the books is that entry, though Lumiverse listed no activation for it: how it got there isn't said.
    const plain = harbour();
    const listed = await told(plain, [plain.loreMessage(LIGHTHOUSE, false), ...history(plain, 10)]);
    expect(listed.notes).toContain(`- [11111111-b] The Lighthouse · ${chars(plain, LIGHTHOUSE)} characters · activated by Lumiverse · message [1]`);
  });

  test("an entry a preset's macro put inside a block is found there; one Lumiverse activated whose text the request doesn't show is listed apart, as lore the writer doesn't have (M8)", async () => {
    const host = harbour();
    activate(host, OKORO, LIGHTHOUSE);
    const okoro = host.entries.find((e) => e.id === OKORO)!.content;
    const { notes, events } = await told(host, [{ role: "system", content: `[World]\n${okoro}\n[End of world]`, source: { kind: "block", blockId: "b-world" } }, ...history(host, 10)]);
    const [lore, index] = notes.split("\n\n");
    expect(lore).toBe(
      [
        `Lore in the prompt (1 entry, about ${Math.ceil(okoro.length / 3.2)} tokens). The writer already has these:`,
        `- [22222222-a] Okoro · ${okoro.length} characters · always sent · inside message [1]`,
        "Activated by Lumiverse, but their text is not in the request (1 entry). The writer doesn't have these. To give the writer one whole, name its id in write_reply's add.",
        `- [11111111-b] The Lighthouse · ${chars(host, LIGHTHOUSE)} characters · a key matched`,
      ].join("\n"),
    );
    // It is in neither list of what the writer has or hasn't by the books: the trace's lore is what the request shows.
    expect(index).toStartWith("Lore not in the prompt (3 entries;");
    expect(index).not.toContain("The Lighthouse");
    expect(heldOf(events).map((entry) => entry.entryId)).toEqual([OKORO]);
    // Where the main agent writes the reply itself, or may not add, the list doesn't say how to add.
    const writes = harbour();
    activate(writes, LIGHTHOUSE);
    expect((await told(writes, history(writes, 10), { writes: true })).notes).toStartWith(`Lore in the prompt: the request shows the text of no world-info entry.\nActivated by Lumiverse, but their text is not in the request (1 entry). The writer doesn't have these.\n- [11111111-b] The Lighthouse · ${chars(writes, LIGHTHOUSE)} characters · a key matched\n\n`);
  });

  test("the entries listed apart keep within the first note's length, however many Lumiverse activated", async () => {
    const host = harbour();
    activate(host, OKORO, LIGHTHOUSE, CUSTOMS, BRANN, MILL);
    const { notes } = await told(host, [host.loreMessage(OKORO), ...history(host, 10)], { settings: (s) => (s.recall.prompt.loreChars = 400) });
    const [lore] = notes.split("\n\n");
    expect(lore?.length).toBeLessThanOrEqual(400);
    expect(lore).toStartWith("Lore in the prompt (1 entry, about");
    expect(lore).toContain("Activated by Lumiverse, but their text is not in the request (4 entries).");
    expect(lore).toMatch(/\(and \d more\)$/);
  });

  test("a chat with books and nothing activated says so; a chat with no book says nothing of lore", async () => {
    expect((await told(harbour(), history(harbour(), 6))).notes).toStartWith("Lore in the prompt: none. Lumiverse activated no world-info entry for this reply.\n\nLore not in the prompt (5 entries;");
    const bare = harbour();
    bare.books.length = 0;
    bare.entries.length = 0;
    expect((await told(bare, history(bare, 0))).notes).toBe("History in the prompt: the request holds chat messages #0 to #11 word for word (12 of 12 messages). That is the whole chat.");
  });
});

describe("the index of lore not in the prompt", () => {
  test("leads with the entry that matches the latest messages best, by title and keys before text", async () => {
    const host = harbour();
    // The latest message names the lighthouse: the entry titled and keyed with it leads, before those that only mention it.
    host.say(CHAT, "user", "I climb to the lighthouse.");
    const messages = host.requestOf(CHAT, 13, null).slice(12);
    const { notes } = await told(host, messages, { settings: (s) => (s.recall.prompt.recent = 1) });
    const index = notes.split("\n\n")[1]?.split("\n") ?? [];
    expect(index[1]).toStartWith("- [11111111-b] The Lighthouse · keys: lighthouse, lamp");
    expect(index[2]).toStartWith("- [22222222-a] Okoro");
    // Entries that match nothing follow in the books' order.
    expect(index.slice(3).map((line) => line.slice(0, 14))).toEqual(["- [11111111-a]", "- [22222222-b]", "- [22222222-c]"]);
  });

  test("is cut at its size with a count of the rest, and lists entries switched off only where Settings say", async () => {
    const host = harbour();
    const small = await told(host, history(host, 6), { settings: (s) => (s.recall.prompt.indexChars = 460) });
    const index = small.notes.split("\n\n")[1] ?? "";
    expect(index.length).toBeLessThanOrEqual(460);
    expect(index).toMatch(/\n\(and [1-4] more: lore_index lists them all, lore_search and lore_about find among them\)$/);
    const held = small.events.find((e) => e.kind === "prompt_held");
    expect(held?.kind === "prompt_held" ? held.index.listed.length + held.index.more : 0).toBe(5);
    expect(small.notes).not.toContain("The Mill");
    const off = await told(harbour(), history(host, 6), { settings: (s) => (s.recall.prompt.indexOff = true) });
    expect(off.notes).toContain(`- [11111111-c] The Mill (switched off) · keys: mill, millrace · ${chars(host, MILL)} characters`);
  });
});

describe("the history in the prompt", () => {
  test("names what stands in for the messages it doesn't hold: the chat's book, and a preset block that carries a summary or memories", async () => {
    const host = harbour();
    const blocks: PresetBlock[] = [
      { id: "b-sum", name: "Story so far", role: "system", kind: "marker", marker: "chat_summary", content: "", enabled: true },
      { id: "b-mem", name: "Recollections", role: "system", kind: "marker", marker: "memories", content: "", enabled: true },
      { id: "b-off", name: "Old summary", role: "system", kind: "marker", marker: "summary", content: "", enabled: true },
    ];
    const messages: RequestMessage[] = [{ role: "system", content: "Mara has the brass key.", source: { kind: "block", blockId: "b-sum" } }, { role: "system", content: "Okoro keeps the other.", source: { kind: "block", blockId: "b-mem" } }, ...history(host, 8)];
    const book = { nodes: [], coverage: { messages: 12, covered: 8, uncovered: { count: 4, runs: [[8, 11]] }, changed: null }, contents: new Map() } as Book;
    const { notes } = await told(host, messages, { blocks, book });
    // The block that isn't in the request stands in for nothing.
    expect(notes).toEndWith("It doesn't hold #0 to #7. Standing in for them: the chat's book (LumiBooks; book_outline lists it), the preset block “Story so far” (a summary), the preset block “Recollections” (Lumiverse's memories). A summary is somebody's reading: chat_outline, chat_about and chat_search reach the messages themselves.");
  });

  test("a request with gaps says each run it holds and each it doesn't, within its size", async () => {
    const host = harbour();
    const all = host.requestOf(CHAT, 12, null);
    const { notes } = await told(host, [all[0]!, all[1]!, all[5]!, all[10]!, all[11]!]);
    expect(notes.split("\n\n").at(-1)).toStartWith("History in the prompt: the request holds chat messages #0 to #1, #5, #10 to #11 word for word (5 of 12 messages). It doesn't hold #2 to #4, #6 to #9.");
    const short = await told(harbour(), [all[0]!, all[1]!, all[5]!, all[10]!, all[11]!], { settings: (s) => (s.recall.prompt.historyChars = 200) });
    expect((short.notes.split("\n\n").at(-1) ?? "").length).toBeLessThanOrEqual(200);
  });
});

describe("each note", () => {
  test("can be switched off, and with all three off the request reads as it did without them", async () => {
    const host = harbour();
    activate(host, OKORO);
    const messages = [host.loreMessage(OKORO), ...history(host, 6)];
    const only = async (keep: "lore" | "index" | "history") => (await told(harbour(activateOn()), messages, { settings: (s) => (s.recall.prompt = { ...s.recall.prompt, lore: keep === "lore", index: keep === "index", history: keep === "history" }) })).notes;
    function activateOn(): RecallHost {
      const fresh = harbour();
      activate(fresh, OKORO);
      fresh.books.length = 0;
      fresh.entries.length = 0;
      return fresh;
    }
    expect(await only("lore")).toStartWith("Lore in the prompt (1 entry");
    expect(await only("lore")).not.toContain("History in the prompt");
    expect(await only("index")).toStartWith("Lore not in the prompt (4 entries");
    expect(await only("history")).toStartWith("History in the prompt");
    const none = await told(host, messages, { settings: (s) => (s.recall.prompt = { ...s.recall.prompt, lore: false, index: false, history: false }) });
    expect(none.notes).toBe("");
    expect(none.document).toStartWith("[1] system\n");
    // What the prompt held is traced all the same: the pages show it whatever the main agent is told.
    expect(none.events.map((e) => e.kind)).toEqual(["prompt_held"]);
  });

  test("is a text the user can replace", async () => {
    const host = harbour();
    const { notes } = await told(host, history(host, 0), { texts: { "recall.prompt.history": "Held: {{held}} ({{count}}/{{total}}). {{missing}}", "recall.prompt.lore.none": "No lore came with this prompt." } });
    expect(notes).toStartWith("No lore came with this prompt.\n\n");
    expect(notes).toEndWith("Held: #0 to #11 (12/12 messages). That is the whole chat.");
  });

  test("is left out, and the log says why, when the books can't be read: the turn is not lost to its notes", async () => {
    const host = harbour();
    host.recall!.lore!.read = async () => {
      throw new Error("the books are locked");
    };
    const { notes, document, events } = await told(host, history(host, 6));
    expect(notes).toBe("");
    expect(document).toStartWith("[1] user · chat message #6");
    expect(events).toEqual([]);
    expect(host.logs.at(-1)).toEqual({ level: "warn", message: "[LumiAH] what the prompt holds of the lore and the chat couldn't be worked out (the books are locked): the main agent is given the request without it" });
  });
});

describe("a turn", () => {
  test("gives its main agent the notes with the request, traces what the prompt held, and keeps how the lore stood", async () => {
    const host = harbour();
    activate(host, OKORO);
    host.script = [{ toolCalls: [call("write_reply", { brief: "Okoro is at the mill tonight." }, "c1")] }, "Okoro waits by the millrace."];
    const stored = { values: defaultSettings(), texts: {} };
    const harness = createHarness(host, { settings: async () => structuredClone(stored) });
    const request: TurnRequest = { userId: "user-1", chatId: CHAT, generationId: "gen-notes", kind: "new", target: { messageId: null, swipeId: 0 }, presetId: null, messages: [host.loreMessage(OKORO), ...history(host, 8)], params: {}, maxTokens: 400 };
    const result = await harness.answer(request, new Sink(), new AbortController().signal);
    expect(result.status).toBe("done");
    const asked = host.calls[0]?.messages.at(-1)?.content ?? "";
    expect(asked).toContain("[1] system · lore entry [22222222-a] Okoro\n");
    expect(asked).toContain("Lore in the prompt (1 entry, about ");
    expect(asked).toContain("Lore not in the prompt (4 entries; the best match for the latest messages first).");
    expect(asked).toContain("History in the prompt: the request holds chat messages #8 to #11 word for word (4 of 12 messages). It doesn't hold #0 to #7.");
    // The notes stand between the request's messages and what the main agent is asked to do.
    expect(asked.indexOf("History in the prompt")).toBeLessThan(asked.indexOf("Work out what this reply needs"));
    const held = host.traced.map((t) => t.event).find((e) => e.kind === "prompt_held");
    expect(held).toMatchObject({ kind: "prompt_held", lore: [{ entryId: OKORO, title: "Okoro", why: { by: "constant" }, message: 1 }], index: { more: 0 }, history: { held: [[8, 11]], missing: [[0, 7]], stands: [] } });
    expect(held?.kind === "prompt_held" ? held.index.listed.map((e) => e.entryId).sort() : []).toEqual([CUSTOMS, LIGHTHOUSE, BRANN, "22222222-cccc-4000-8000-000000000006"].sort());
    expect(await Recall.of(host).last(CHAT)).toMatchObject({ generationId: "gen-notes", held: { [OKORO]: { by: "constant" } }, added: [], dropped: [] });
    // And a new harness on the same host (a restart) reads it back from the store.
    expect(host.documents.get("chats/chat-1/recall.json")).toMatchObject({ v: 1, generationId: "gen-notes" });
  });
});
