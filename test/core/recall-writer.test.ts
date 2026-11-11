// The lore the writer sees (DESIGN §24.3): what `write_reply` names to add and to drop is resolved
// against the chat's lore and the prompt under Settings, refused with why where it can't be done,
// and applied to the writer's request: an added entry's own text beside the world info Lumiverse
// put in (or beside the brief, where the prompt has no such place), a dropped entry's text taken
// out. Neither ever holds a reply.

import { describe, expect, test } from "bun:test";
import type { ActivatedLore, RequestMessage } from "../../src/core/ports";
import { Recall, recallOf, type RecallRun } from "../../src/core/recall/recall";
import type { LoreChanged } from "../../src/core/recall/shapes";
import { planWriterLore, writerLore } from "../../src/core/recall/writer";
import type { Settings } from "../../src/core/settings";
import { CHAT, harbour, type RecallHost, toolRig } from "./recall-support";

const ID = {
  customs: "11111111-aaaa-4000-8000-000000000001",
  lighthouse: "11111111-bbbb-4000-8000-000000000002",
  mill: "11111111-cccc-4000-8000-000000000003",
  okoro: "22222222-aaaa-4000-8000-000000000004",
  brann: "22222222-bbbb-4000-8000-000000000005",
  ilse: "22222222-cccc-4000-8000-000000000006",
  quay: "44444444-aaaa-4000-8000-000000000008",
};

/** The entries the tests add and drop, as a change names them. */
const CHANGED: Record<"customs" | "lighthouse" | "mill" | "okoro" | "brann" | "ilse", LoreChanged> = {
  customs: { entryId: ID.customs, bookId: "book-coast", title: "The Customs House", chars: 182 },
  lighthouse: { entryId: ID.lighthouse, bookId: "book-coast", title: "The Lighthouse", chars: 135 },
  mill: { entryId: ID.mill, bookId: "book-coast", title: "The Mill", chars: 88 },
  okoro: { entryId: ID.okoro, bookId: "book-people", title: "Okoro", chars: 102 },
  brann: { entryId: ID.brann, bookId: "book-people", title: "Brann", chars: 119 },
  ilse: { entryId: ID.ilse, bookId: "book-people", title: "Ilse", chars: 57 },
};

const NOTHING = { added: [], dropped: [], refused: [] };

function textOf(host: RecallHost, id: string): string {
  const entry = host.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`no entry ${id}`);
  return entry.content;
}

/** An entry as Lumiverse says it activated it: its own text. */
function activated(host: RecallHost, id: string): ActivatedLore {
  const entry = host.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`no entry ${id}`);
  return { entryId: entry.id, bookId: entry.bookId, title: entry.title, content: entry.content };
}

/** An added entry as the writer's request carries it. */
const added = (host: RecallHost, id: string, role: RequestMessage["role"] = "system"): RequestMessage => ({ role, content: textOf(host, id), source: { kind: "lore", entryId: id } });

/**
 * A turn of the harbour story and its run's view. Left as it is, the request holds the chat's
 * twelve messages, then the lighthouse and Okoro as World Info messages of their own (the request's
 * messages 13 and 14).
 */
async function turn(options: { host?: RecallHost; settings?: (s: Settings) => void; messages?: (host: RecallHost) => RequestMessage[]; active?: (host: RecallHost) => ActivatedLore[] } = {}): Promise<{ host: RecallHost; run: RecallRun; messages: RequestMessage[] }> {
  const host = options.host ?? harbour();
  host.activatedLore = options.active?.(host) ?? [activated(host, ID.lighthouse), activated(host, ID.okoro)];
  const messages = options.messages?.(host) ?? [...host.requestOf(CHAT, 12, null), host.loreMessage(ID.lighthouse), host.loreMessage(ID.okoro)];
  const rig = await toolRig(host, [], { turn: { messages }, ...(options.settings ? { settings: options.settings } : {}) });
  return { host, run: recallOf(rig.env), messages };
}

describe("the lore the writer sees", () => {
  test("an added entry's own text goes in after the last World Info message, and a dropped entry's message is taken out", async () => {
    const host = harbour();
    // Lumiverse puts Ilse's entry in as the user's message; Brann's has no role of its own.
    host.entryMore.set(ID.ilse, { role: "user" });
    const { run, messages } = await turn({ host });
    // Ids as the tools show them: short, or copied with their brackets and title.
    expect(await planWriterLore(run, { add: ["22222222-b", "[22222222-c] Ilse"], drop: ["11111111-b"] })).toEqual({ added: [CHANGED.brann, CHANGED.ilse], dropped: [CHANGED.lighthouse], refused: [] });
    expect({ add: run.writer?.add.map((doc) => doc.short), drop: run.writer?.drop.map((held) => held.message) }).toEqual({ add: ["22222222-b", "22222222-c"], drop: [13] });
    const sent = writerLore(run, messages);
    // Okoro's message stays where it was; the added entries follow it in the order named, Brann as his neighbour's role.
    expect(sent).toEqual({ messages: [...messages.slice(0, 12), host.loreMessage(ID.okoro), added(host, ID.brann), added(host, ID.ilse, "user")], beside: [] });
    // The request is left as Lumiverse assembled it.
    expect(messages.map((m) => m.source?.kind).join(" ")).toBe(`${"history ".repeat(12)}lore lore`);
    // What was added and dropped is kept with how the chat's lore stood at this turn.
    expect(await Recall.of(host).last(CHAT)).toMatchObject({ generationId: "gen-now", added: [ID.brann, ID.ilse], dropped: [ID.lighthouse] });
  });

  test("dropping every entry still leaves the place where world info goes", async () => {
    const { host, run, messages } = await turn();
    // One id alone is taken as a list of one, and an entry named by two forms of its id is added once.
    expect(await planWriterLore(run, { add: "22222222-b", drop: ["11111111-b", "22222222-a", ID.okoro] })).toEqual({ added: [CHANGED.brann], dropped: [CHANGED.lighthouse, CHANGED.okoro], refused: [] });
    expect(writerLore(run, messages)).toEqual({ messages: [...messages.slice(0, 12), added(host, ID.brann)], beside: [] });
  });

  test("where the request has no World Info message, the added texts come back to go beside the brief", async () => {
    const { host, run, messages } = await turn({ messages: (h) => h.requestOf(CHAT, 12, null), active: () => [] });
    expect(await planWriterLore(run, { add: ["22222222-b", "11111111-a"], drop: [] })).toEqual({ added: [CHANGED.brann, CHANGED.customs], dropped: [], refused: [] });
    expect(writerLore(run, messages)).toEqual({ messages, beside: [textOf(host, ID.brann), textOf(host, ID.customs)] });
  });

  test("a reply adds as many entries and as much text as Settings allow, and says which it left out", async () => {
    const few = await turn({ settings: (s) => (s.recall.writer.addEntries = 1) });
    const most = "a reply may add 1 entry at most (Entries added per reply)";
    expect(await planWriterLore(few.run, { add: ["22222222-b", "22222222-c", "11111111-a"], drop: [] })).toEqual({ added: [CHANGED.brann], dropped: [], refused: [{ entryId: "22222222-c", reason: most }, { entryId: "11111111-a", reason: most }] });
    // Brann's 119 characters fit under 180; the customs house's 182 don't beside them; Ilse's 57 still do.
    const short = await turn({ settings: (s) => (s.recall.writer.addChars = 180) });
    expect(await planWriterLore(short.run, { add: ["22222222-b", "11111111-a", "22222222-c"], drop: [] })).toEqual({ added: [CHANGED.brann, CHANGED.ilse], dropped: [], refused: [{ entryId: "11111111-a", reason: "with it the added text would pass 180 characters (Text added per reply)" }] });
    expect(writerLore(short.run, short.messages).messages.slice(14)).toEqual([added(short.host, ID.brann), added(short.host, ID.ilse)]);
  });

  test("Settings say whether the main agent may add, and whether it may drop", async () => {
    const noAdd = await turn({ settings: (s) => (s.recall.writer.add = false) });
    const addOff = "Settings don't let you add entries (Add entries)";
    expect(await planWriterLore(noAdd.run, { add: ["22222222-b", "99999999"], drop: ["11111111-b"] })).toEqual({ added: [], dropped: [CHANGED.lighthouse], refused: [{ entryId: "22222222-b", reason: addOff }, { entryId: "99999999", reason: addOff }] });
    expect(writerLore(noAdd.run, noAdd.messages).messages).toEqual([...noAdd.messages.slice(0, 12), noAdd.host.loreMessage(ID.okoro)]);

    const noDrop = await turn({ settings: (s) => (s.recall.writer.drop = false) });
    expect(await planWriterLore(noDrop.run, { add: ["22222222-b"], drop: ["11111111-b"] })).toEqual({ added: [CHANGED.brann], dropped: [], refused: [{ entryId: "11111111-b", reason: "Settings don't let you drop entries (Drop entries)" }] });
    expect(writerLore(noDrop.run, noDrop.messages).messages).toEqual([...noDrop.messages, added(noDrop.host, ID.brann)]);

    const neither = await turn({ settings: (s) => (s.recall.writer = { ...s.recall.writer, add: false, drop: false }) });
    expect((await planWriterLore(neither.run, { add: ["22222222-b"], drop: ["11111111-b"] })).refused).toHaveLength(2);
    expect(neither.run.writer).toBeNull();
    expect(writerLore(neither.run, neither.messages)).toEqual({ messages: neither.messages, beside: [] });
  });

  test("what can't be done is refused with why, in the order named, and holds up nothing else", async () => {
    const host = harbour();
    host.addEntry("book-coast", ID.quay, "The Quay", ["quay"], "  \n");
    const { run, messages } = await turn({ host });
    const change = await planWriterLore(run, {
      // No such entry; a start three entries share; Ilse, named to drop as well; Okoro, in the prompt; the mill, switched off; the quay, which has no text.
      add: ["99999999", "1111", "22222222-c", "22222222-a", "11111111-c", "44444444"],
      // No such entry; a start three entries share; Ilse again; Brann, who isn't in the prompt; and the lighthouse, which is.
      drop: ["88888888", "2222", ID.ilse, "22222222-b", "11111111-b"],
    });
    expect(change).toEqual({
      added: [],
      dropped: [CHANGED.lighthouse],
      refused: [
        { entryId: "99999999", reason: "no lore entry goes by that id" },
        { entryId: "1111", reason: "it names several entries ([11111111-a] The Customs House, [11111111-b] The Lighthouse, [11111111-c] The Mill): give more of the id" },
        { entryId: "22222222-c", reason: "it is named both to add and to drop" },
        { entryId: "22222222-a", reason: "it is in the prompt already" },
        { entryId: "11111111-c", reason: "it is switched off in its book" },
        { entryId: "44444444", reason: "it has no text" },
        { entryId: "88888888", reason: "no lore entry goes by that id" },
        { entryId: "2222", reason: "it names several entries ([22222222-a] Okoro, [22222222-b] Brann, [22222222-c] Ilse): give more of the id" },
        { entryId: "22222222-b", reason: "it isn't in the prompt, so there is nothing to take out" },
      ],
    });
    expect(writerLore(run, messages)).toEqual({ messages: [...messages.slice(0, 12), host.loreMessage(ID.okoro)], beside: [] });
    // A reference that is no id is said back a line long at most.
    const long = await planWriterLore(run, { add: ["x".repeat(5000)], drop: [] });
    expect(long.refused.map((r) => ({ length: r.entryId.length, reason: r.reason }))).toEqual([{ length: 300, reason: "no lore entry goes by that id" }]);
  });

  test("an entry the user switched off is added only where Settings list such entries to the main agent", async () => {
    const listed = await turn({ settings: (s) => (s.recall.prompt.indexOff = true) });
    expect(await planWriterLore(listed.run, { add: ["11111111-c"], drop: [] })).toEqual({ added: [CHANGED.mill], dropped: [], refused: [] });
    expect(writerLore(listed.run, listed.messages).messages.at(-1)).toEqual(added(listed.host, ID.mill));
  });

  test("an entry a preset's macro put inside a block has exactly its text cut out of that block", async () => {
    const host = harbour();
    const notes: RequestMessage = { role: "system", content: `World notes.\n${textOf(host, ID.brann)}\nEnd of notes.`, source: { kind: "block", blockId: "b-notes" } };
    const alone: RequestMessage = { role: "system", content: `${textOf(host, ID.ilse)}\n`, source: { kind: "block", blockId: "b-lore" } };
    const { run, messages } = await turn({ host, active: (h) => [activated(h, ID.brann), activated(h, ID.ilse), activated(h, ID.okoro)], messages: (h) => [notes, alone, ...h.requestOf(CHAT, 12, null), h.loreMessage(ID.okoro)] });
    expect(await planWriterLore(run, { add: [], drop: ["22222222-b", "22222222-c"] })).toEqual({ added: [], dropped: [CHANGED.brann, CHANGED.ilse], refused: [] });
    // The first block keeps its own words around where the entry stood; the second held nothing else, and is no message any more.
    expect(writerLore(run, messages)).toEqual({ messages: [{ ...notes, content: "World notes.\n\nEnd of notes." }, ...messages.slice(2)], beside: [] });
    expect(notes.content).toContain("Brann was master of the Heron.");
  });

  test("an entry inside a block of parts can't be told apart from it, and one whose text the request doesn't show has nothing to take out and says why", async () => {
    const host = harbour();
    const parts: RequestMessage = { role: "system", content: "", parts: [{ type: "text", text: `World notes.\n${textOf(host, ID.brann)}\nEnd of notes.` }], source: { kind: "block", blockId: "b-notes" } };
    // Lumiverse says it activated Ilse's entry too, but no message of the request holds its text.
    const { run, messages } = await turn({ host, active: (h) => [activated(h, ID.brann), activated(h, ID.ilse)], messages: (h) => [parts, ...h.requestOf(CHAT, 12, null)] });
    expect(await planWriterLore(run, { add: [], drop: ["22222222-b", "22222222-c"] })).toEqual({
      added: [],
      dropped: [],
      refused: [
        { entryId: "22222222-b", reason: "its text sits inside message [1] with other text and couldn't be told apart from it" },
        { entryId: "22222222-c", reason: "Lumiverse activated it, but the request doesn't show its text, so there is nothing to take out" },
      ],
    });
    expect(run.writer).toBeNull();
    expect(writerLore(run, messages)).toEqual({ messages, beside: [] });
  });

  test("an entry Lumiverse activated whose text the request doesn't show isn't held as in the prompt, and is the main agent's to add (M8)", async () => {
    // Lumiverse says it activated Brann's entry and one of a book the tools don't read; no message of the request holds the text of either.
    const { host, run, messages } = await turn({
      active: (h) => [activated(h, ID.brann), activated(h, ID.okoro), { entryId: "ext-tides", bookId: "book-elsewhere", title: "Tide tables", content: "High water at the point comes an hour after the harbour's." }],
      messages: (h) => [...h.requestOf(CHAT, 12, null), h.loreMessage(ID.okoro)],
    });
    const held = await run.held();
    expect([...(held?.byId.keys() ?? [])]).toEqual([ID.okoro]);
    expect(held?.unseen.map((entry) => entry.entryId)).toEqual([ID.brann, "ext-tides"]);
    // The writer never saw its text: adding gives it whole. Dropping either has nothing to take out.
    expect(await planWriterLore(run, { add: ["22222222-b"], drop: ["ext-tides"] })).toEqual({ added: [CHANGED.brann], dropped: [], refused: [{ entryId: "ext-tides", reason: "Lumiverse activated it, but the request doesn't show its text, so there is nothing to take out" }] });
    const sent = writerLore(run, messages).messages;
    expect(sent.length).toBe(messages.length + 1);
    expect(sent.at(-1)).toMatchObject({ content: textOf(host, ID.brann), source: { kind: "lore", entryId: ID.brann } });
  });

  test("an entry of a book the tools don't read is dropped by the id Lumiverse gave it", async () => {
    const host = harbour();
    const tides: RequestMessage = { role: "system", content: "High water at the point comes an hour after the harbour's.", source: { kind: "lore", entryId: "ext-tides" } };
    const { run, messages } = await turn({ host, active: (h) => [{ entryId: "ext-tides", bookId: "book-elsewhere", title: "Tide tables", content: tides.content }, activated(h, ID.okoro)], messages: (h) => [...h.requestOf(CHAT, 12, null), tides, h.loreMessage(ID.okoro)] });
    expect(await planWriterLore(run, { add: ["ext-tides"], drop: ["[ext-tides]"] })).toEqual({ added: [], dropped: [{ entryId: "ext-tides", bookId: "book-elsewhere", title: "Tide tables", chars: 58 }], refused: [{ entryId: "ext-tides", reason: "no lore entry goes by that id" }] });
    expect(writerLore(run, messages).messages).toEqual([...messages.slice(0, 12), host.loreMessage(ID.okoro)]);
  });

  test("a reply that names nothing reads no lore, plans nothing, and leaves the request as it came", async () => {
    const { host, run, messages } = await turn();
    expect(await planWriterLore(run, { add: undefined, drop: [] })).toEqual(NOTHING);
    expect(run.writer).toBeNull();
    expect(host.loreReads).toBe(0);
    const sent = writerLore(run, messages);
    expect(sent).toEqual({ messages, beside: [] });
    expect(sent.messages.every((m, i) => m === messages[i])).toBe(true);
    // A run none of whose agents asked for the lore has no view of it at all.
    expect(writerLore(undefined, messages)).toEqual({ messages, beside: [] });
    // Everything named was refused: there is still no plan.
    expect((await planWriterLore(run, { add: ["99999999"], drop: "22222222-b" })).refused).toHaveLength(2);
    expect(run.writer).toBeNull();
  });

  test("a later call of the same run plans anew", async () => {
    const { host, run, messages } = await turn();
    await planWriterLore(run, { add: ["22222222-b"], drop: ["11111111-b"] });
    expect(writerLore(run, messages).messages).toHaveLength(14);
    expect(await planWriterLore(run, { add: [], drop: [] })).toEqual(NOTHING);
    expect(run.writer).toBeNull();
    expect(writerLore(run, messages)).toEqual({ messages, beside: [] });
    expect(await Recall.of(host).last(CHAT)).toMatchObject({ added: [], dropped: [] });
  });

  test("where the books can't be read, everything named is refused with that, and the reply goes on", async () => {
    const { host, run, messages } = await turn();
    if (!host.recall?.lore) throw new Error("the fixture's host has no lore port");
    host.recall.lore.read = async () => {
      throw new Error("the books are away");
    };
    const reason = "the lore couldn't be read (the books are away)";
    expect(await planWriterLore(run, { add: ["22222222-b"], drop: ["11111111-b"] })).toEqual({ added: [], dropped: [], refused: [{ entryId: "22222222-b", reason }, { entryId: "11111111-b", reason }] });
    expect(run.writer).toBeNull();
    expect(writerLore(run, messages)).toEqual({ messages, beside: [] });
  });
});
