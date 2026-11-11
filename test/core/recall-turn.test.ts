// Lore and history through a whole turn and through the pages (DESIGN §24): which tools an agent is
// offered, the lore `write_reply` adds to and drops from what the writer is sent, the chronicle
// pinned for the main agent, search in a script written without spaces and by meaning, what the
// pages read (`harness.recall`), and how long an index over a long chat takes.

import { describe, expect, test } from "bun:test";
import { createHarness } from "../../src/core/harness";
import type { JsonObject, ModelRequest, RequestMessage, TraceEvent, TurnRequest } from "../../src/core/ports";
import { citeDoc } from "../../src/core/recall/chat";
import { storyEstimate } from "../../src/core/recall/page";
import { Recall, recallOf } from "../../src/core/recall/recall";
import { recallAgents } from "../../src/core/recall/definitions";
import { ADDED_TOOLS, CORE_TOOLS, defaultSettings, MAIN_TOOLS, type Settings, SUMMARIZER_TOOLS } from "../../src/core/settings";
import { BASE_TOOLS } from "../../src/core/tools/base";
import { CHAT_TOOLS } from "../../src/core/tools/chat";
import { LORE_TOOLS } from "../../src/core/tools/lore";
import { CHAT, FakeDatabanks, FakeEmbedder, FakeMemory, FakeWeb, harbour, RecallHost, START, toolRig } from "./recall-support";
import { type Answer, call, Sink } from "./support/host";

const OKORO = "22222222-aaaa-4000-8000-000000000004";
const BRANN = "22222222-bbbb-4000-8000-000000000005";
const LIGHTHOUSE = "11111111-bbbb-4000-8000-000000000002";
const CUSTOMS = "11111111-aaaa-4000-8000-000000000001";

const contentOf = (host: RecallHost, id: string): string => host.entries.find((e) => e.id === id)?.content ?? "";

/** Lumiverse activated these, and put each in the prompt as a message of its own. */
function activate(host: RecallHost, ...ids: string[]): RequestMessage[] {
  host.activatedLore = ids.map((id) => {
    const entry = host.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`no entry ${id}`);
    return { entryId: id, bookId: entry.bookId, title: entry.title, content: entry.content };
  });
  return ids.map((id) => host.loreMessage(id));
}

let generation = 1;

/** A harness over a host, and one turn of it whose request is `messages` (left out: the chat's latest messages, flagged as history). */
function rig(host: RecallHost, script: Answer[], change: (s: Settings) => void = () => undefined) {
  host.script = script;
  const stored = { values: defaultSettings(), texts: {} as Record<string, string> };
  change(stored.values);
  const harness = createHarness(host, { settings: async () => structuredClone(stored) });
  const turn = async (messages?: RequestMessage[]) => {
    const path = await host.chat.path(CHAT);
    const request: TurnRequest = { userId: "user-1", chatId: CHAT, generationId: `gen-recall-${generation++}`, kind: "new", target: { messageId: null, swipeId: 0 }, presetId: null, messages: messages ?? host.requestOf(CHAT, path.length, null).slice(-6), params: {}, maxTokens: 400 };
    const result = await harness.answer(request, new Sink(), new AbortController().signal);
    return { request, result };
  };
  return { host, harness, stored, turn };
}

const offered = (request: ModelRequest | undefined): string[] => (request?.tools ?? []).map((t) => t.name);
const events = (host: RecallHost): TraceEvent[] => host.traced.map((t) => t.event);
const brief = (args: Record<string, unknown> = {}): Answer => ({ toolCalls: [call("write_reply", { brief: "Okoro is at the mill tonight.", ...args }, "w1")] });

describe("the tools an agent is offered", () => {
  test("rest on what the host and the user have: no port, or nothing set up, and the tool isn't offered; web_search only by name", async () => {
    // A host with the lore and chat ports alone.
    const plain = rig(harbour(), [brief(), "The reply."]);
    await plain.turn();
    const base = offered(plain.host.calls[0]);
    expect(base).toEqual(expect.arrayContaining(["chat_outline", "chat_about", "chat_search", "chat_grep", "chat_read", "chat_around", "lore_index", "lore_search", "lore_grep", "lore_read", "lore_related", "lore_about", "active_lore", "chronicle_check", "skill_load"]));
    expect(base.filter((name) => /^(memory|databank)_|^web_search$/.test(name))).toEqual([]);

    // Every port mounted and set up: the Memory Cortex's and the databanks' tools are offered, web_search still isn't.
    const full = harbour();
    const memory = new FakeMemory();
    const banks = new FakeDatabanks();
    banks.banks = [{ id: "bank-1", name: "Charts", description: "", scope: "chat", documents: 1 }];
    banks.add("bank-1", "doc-1", "Tide table", "High water at the point comes twice a day.");
    full.recall = { ...full.recall, memory, databanks: banks, web: new FakeWeb() };
    const all = rig(full, [brief(), "The reply."]);
    await all.turn();
    expect(offered(all.host.calls[0])).toEqual(expect.arrayContaining(["memory_search", "memory_entity", "memory_arcs", "databank_list", "databank_search", "databank_read"]));
    expect(offered(all.host.calls[0])).not.toContain("web_search");

    // The user switched the Cortex off and has no databank: neither is offered, though the host has the ports.
    const off = harbour();
    const cortex = new FakeMemory();
    cortex.on = false;
    off.recall = { ...off.recall, memory: cortex, databanks: new FakeDatabanks(), web: new FakeWeb() };
    const none = rig(off, [brief(), "The reply."]);
    await none.turn();
    expect(offered(none.host.calls[0]).filter((name) => /^(memory|databank)_|^web_search$/.test(name))).toEqual([]);

    // web_search is held by an agent the user gave it to, by name.
    const named = harbour();
    named.recall = { ...named.recall, web: new FakeWeb() };
    const given = rig(named, [brief(), "The reply."], (s) => s.agents.main?.tools.push("web_search"));
    await given.turn();
    expect(offered(given.host.calls[0])).toContain("web_search");
  });

  test("a side session about no chat is offered none of the tools that read a chat, its lore, its chronicle, its memories or its databanks, whatever the host has", async () => {
    // Every port mounted and set up: nothing but the missing chat keeps these tools away.
    const host = harbour();
    const banks = new FakeDatabanks();
    banks.banks = [{ id: "bank-1", name: "Charts", description: "", scope: "global", documents: 1 }];
    banks.add("bank-1", "doc-1", "Tide table", "High water at the point comes twice a day.");
    host.recall = { ...host.recall, memory: new FakeMemory(), databanks: banks, web: new FakeWeb() };
    const r = rig(host, ["Ask away."]);
    const { side } = await r.harness.sides.start({ chatId: null });
    const result = await r.harness.side({ session: side.id, generationId: "side-recall-1", text: "What can you do here?" }, new Sink(), new AbortController().signal);
    expect(result.status).toBe("done");
    // The session is told "there is no chat or lore to read": no tool may then offer to read one.
    expect(offered(host.calls[0]).filter((name) => /^(chat|lore|memory|databank|chronicle)_|^active_lore$/.test(name))).toEqual([]);
    // It was a real offer, with the tools a chat-less session does keep: an empty list would prove nothing.
    expect(offered(host.calls[0])).toEqual(expect.arrayContaining(["workspace_list", "skill_load"]));
  });
});

describe("the tools the core registers and the tools its settings name", () => {
  test("agree: every name an agent is given by default is a tool or a family the core registers, and every tool it registers is one Settings can give", () => {
    const registered = new Set(BASE_TOOLS.map((tool) => tool.name));
    const families = new Set(BASE_TOOLS.map((tool) => `@${tool.family}`));
    const known = (name: string): boolean => registered.has(name) || families.has(name) || name === ADDED_TOOLS;
    const named: Record<string, readonly string[]> = { MAIN_TOOLS, SUMMARIZER_TOOLS, CORE_TOOLS, ...Object.fromEntries(recallAgents().map((agent) => [`the definition of ${agent.id}`, agent.tools])) };
    for (const [id, agent] of Object.entries(defaultSettings().agents)) named[`the settings of ${id}`] = agent?.tools ?? [];
    // A name no tool answers to would be offered on the settings page and given to no model.
    expect(Object.entries(named).flatMap(([list, names]) => names.filter((name) => !known(name)).map((name) => `${list}: ${name}`))).toEqual([]);
    // The other way: a tool the core registers that Settings can't name could be given to no agent.
    expect([...registered].filter((name) => !CORE_TOOLS.includes(name))).toEqual([]);
    // One definition a name.
    expect(BASE_TOOLS.length).toBe(registered.size);
    // web_search reaches outside the user's own data: it is nobody's until the user gives it by name, and no family an agent holds by default brings it.
    expect(registered.has("web_search")).toBe(true);
    const web = BASE_TOOLS.find((tool) => tool.name === "web_search");
    expect(Object.entries(named).filter(([list]) => list !== "CORE_TOOLS").flatMap(([list, names]) => (names.includes("web_search") || names.includes(`@${web?.family}`) ? [list] : []))).toEqual([]);
  });
});

describe("the lore the writer sees", () => {
  test("write_reply adds an entry beside the world info already there and drops one, without the main agent retyping either", async () => {
    const host = harbour();
    const lore = activate(host, OKORO, LIGHTHOUSE);
    const r = rig(host, [brief({ add: ["22222222-b"], drop: ["11111111-b"] }), "Okoro waits by the millrace."]);
    const { result } = await r.turn([{ role: "system", content: "Write in the present tense." }, ...lore, ...host.requestOf(CHAT, 12, null).slice(8)]);
    expect(result).toMatchObject({ status: "done", reply: "Okoro waits by the millrace." });
    // The main agent was offered both arguments, with the cap said.
    const tool = host.calls[0]?.tools?.find((t) => t.name === "write_reply");
    expect(Object.keys((tool?.parameters.properties ?? {}) as object)).toEqual(["brief", "add", "drop"]);
    expect(JSON.stringify(tool?.parameters)).toContain("At most 8 entries and 12000 characters in all");
    // The writer's request: Okoro's entry as it came, the Lighthouse's gone, Brann's own text right after the last world-info message, then the chat and the brief.
    const sent = (host.calls[1]?.messages ?? []).map((m) => m.content);
    expect(sent.slice(0, 3)).toEqual(["Write in the present tense.", contentOf(host, OKORO), contentOf(host, BRANN)]);
    expect(sent).not.toContain(contentOf(host, LIGHTHOUSE));
    expect(sent.some((text) => text.includes("Okoro is at the mill tonight."))).toBe(true);
    // The trace says what was added and dropped, on the call's result.
    const written = events(host).flatMap((e) => (e.kind === "agent_entry" && e.entry.kind === "result" && e.entry.name === "write_reply" ? [e.entry] : []));
    expect(written[0]?.lore).toEqual({ added: [{ entryId: BRANN, bookId: "book-people", title: "Brann", chars: contentOf(host, BRANN).length }], dropped: [{ entryId: LIGHTHOUSE, bookId: "book-coast", title: "The Lighthouse", chars: contentOf(host, LIGHTHOUSE).length }], refused: [] });
    // And how the chat's lore stood at this turn says so too: what the Lore page shows.
    expect(await Recall.of(host).last(CHAT)).toMatchObject({ added: [BRANN], dropped: [LIGHTHOUSE] });
    const listing = await r.harness.recall.lore({ chatId: CHAT });
    expect(Object.fromEntries(listing.entries.map((e) => [e.title, e.state]))).toEqual({ "The Customs House": "not_in_prompt", "The Lighthouse": "dropped", "The Mill": "off", Okoro: "in_prompt", Brann: "added", Ilse: "not_in_prompt" });
    expect(listing.entries.find((e) => e.title === "Okoro")?.why).toEqual({ by: "constant" });
  });

  test("where the request has no world info, an added entry's text goes before the brief, in the brief's own message", async () => {
    const host = harbour();
    const r = rig(host, [brief({ add: [BRANN] }), "The reply."]);
    await r.turn();
    const last = host.calls[1]?.messages.findLast((m) => m.content.includes("Okoro is at the mill tonight."));
    expect(last?.content.indexOf(contentOf(host, BRANN))).toBeGreaterThanOrEqual(0);
    expect(last?.content.indexOf(contentOf(host, BRANN))).toBeLessThan(last?.content.indexOf("Okoro is at the mill tonight.") ?? -1);
  });

  test("what it can't do never holds the reply: it is listed with why, and the rest is done", async () => {
    const host = harbour();
    const lore = activate(host, OKORO);
    const r = rig(host, [brief({ add: ["no-such-entry", "22222222-b"], drop: ["22222222-c"] }), "The reply."]);
    const { result } = await r.turn([...lore, ...host.requestOf(CHAT, 12, null).slice(8)]);
    expect(result.status).toBe("done");
    const written = events(host).flatMap((e) => (e.kind === "agent_entry" && e.entry.kind === "result" && e.entry.name === "write_reply" ? [e.entry] : []));
    expect(written[0]?.lore?.added.map((e) => e.title)).toEqual(["Brann"]);
    expect(written[0]?.lore?.refused).toEqual([
      { entryId: "no-such-entry", reason: "no lore entry goes by that id" },
      { entryId: "22222222-c", reason: "it isn't in the prompt, so there is nothing to take out" },
    ]);
  });

  test("with both switches off write_reply takes a brief alone, and names given anyway change nothing", async () => {
    const host = harbour();
    const lore = activate(host, OKORO);
    const r = rig(host, [brief({ add: [BRANN], drop: [OKORO] }), "The reply."], (s) => (s.recall.writer = { ...s.recall.writer, add: false, drop: false }));
    await r.turn([...lore, ...host.requestOf(CHAT, 12, null).slice(8)]);
    const tool = host.calls[0]?.tools?.find((t) => t.name === "write_reply");
    expect(Object.keys((tool?.parameters.properties ?? {}) as object)).toEqual(["brief"]);
    const sent = (host.calls[1]?.messages ?? []).map((m) => m.content);
    expect(sent).toContain(contentOf(host, OKORO));
    expect(sent.join("\n")).not.toContain(contentOf(host, BRANN));
  });
});

describe("the chronicle in a turn", () => {
  test("its top is given to the main agent with the request, without the lines that fail the check, and with one line on its upkeep", async () => {
    const host = harbour();
    const r = rig(host, [brief(), "The reply.", brief(), "The reply.", brief(), "The reply."]);
    const chat = await recallOf((await toolRig(host, [])).env).chat();
    const cite = (n: number): string => citeDoc(chat.messages[n]!);
    await r.harness.workspace.write({ chatId: CHAT, area: "learned", path: "chronicle/facts.md", base: null, text: [`- Mara holds the brass key. ${cite(0)}`, `- The strongbox takes two keys turned at once. ${cite(7)}`, `- Brann's debt is the longest page of the ledger. ${cite(9)}`, "- Okoro sank the Heron himself."].join("\n") });
    await r.turn();
    const first = host.calls[0]?.messages.at(-1)?.content ?? "";
    expect(first).toContain("[The chronicle: what this chat has established, kept in learned/chronicle/.");
    expect(first).toContain("It reaches message #9; the chat is at #11, 2 messages past it.");
    expect(first).toContain(`- Mara holds the brass key. ${cite(0)}`);
    expect(first).toContain(`- Brann's debt is the longest page of the ledger. ${cite(9)}`);
    // A line that cites nothing was never checked: it is not given (H5).
    expect(first).not.toContain("Okoro sank the Heron");
    // Jobs can run here and no chronicler job is under way: the line says nothing is due, when a job is worth it, and the whole of how to start one beside write_reply. No skill is named: none needs loading.
    expect(first).toContain("[Upkeep: nothing is due. Start a job only if this turn changes something the chronicle states. Call job_start in the same answer as write_reply, never in a round of its own: agent chronicler, task “Bring the chronicle up to date from message #10.”]");
    expect(first).not.toContain("chronicle-keep");
    // The main agent's own instructions say the same rule, so it holds on a turn whose note has no room for the line.
    expect(host.calls[0]?.messages.some((m) => m.content.includes("then call job_start in the same answer as write_reply") && m.content.includes("never in a round of its own") && m.content.includes("No skill needs loading for it."))).toBe(true);

    // The user edits message #7: the line that rests on it is left out of the next turn's, and the others stay.
    host.edit(CHAT, chat.messages[7]!.id, "\"The ledger was burned,\" Okoro says.");
    await r.turn();
    const second = host.calls[2]?.messages.at(-1)?.content ?? "";
    expect(second).toContain(`- Mara holds the brass key. ${cite(0)}`);
    expect(second).not.toContain("The strongbox takes two keys turned at once.");
    expect(second).toContain("(2 lines left out: they cite nothing, or cite what no message reads as; chronicle_check lists them)");

    // A chronicler job of this chat that waits to run: the next turn's line says so, and says to start no other.
    await r.harness.jobs.start({ chatId: CHAT, agent: "chronicler", task: "Bring the chronicle up to date from message #10.", when: "now" });
    await r.turn();
    const third = host.calls[4]?.messages.at(-1)?.content ?? "";
    expect(third).toContain("[Upkeep: a chronicler job is waiting to run for this chat. Start no other.]");
    expect(third).not.toContain("Call job_start");
  });

  test("a chat without one says so once it is longer than Settings' tail, with how to have one begun; it says nothing before that, nor once Settings don't ask", async () => {
    // Twelve messages and a tail of twenty: nothing is said of a chronicle the chat doesn't need yet.
    const short = rig(harbour(), [brief(), "The reply."]);
    await short.turn();
    expect(short.host.calls[0]?.messages.at(-1)?.content).not.toContain("chronicle");
    const asked = rig(harbour(), [brief(), "The reply."], (s) => (s.recall.chronicle.tail = 5));
    await asked.turn();
    const said = asked.host.calls[0]?.messages.at(-1)?.content ?? "";
    expect(said).toContain("[This chat has no chronicle yet (learned/chronicle/)");
    expect(said).toContain("[Upkeep: have one begun. Call job_start in the same answer as write_reply, never in a round of its own: agent chronicler, task “Bring the chronicle up to date from message #0.”]");
    const quiet = rig(harbour(), [brief(), "The reply."], (s) => Object.assign(s.recall.chronicle, { tail: 5, remind: false }));
    await quiet.turn();
    expect(quiet.host.calls[0]?.messages.at(-1)?.content).not.toContain("chronicle");
    // A host that can't run jobs: the main agent is told of no upkeep it couldn't start.
    const host = harbour();
    delete host.jobs;
    const jobless = rig(host, [brief(), "The reply."], (s) => (s.recall.chronicle.tail = 5));
    await jobless.turn();
    expect(jobless.host.calls[0]?.messages.at(-1)?.content).not.toContain("Upkeep");
  });
});

describe("search in a script written without spaces", () => {
  test("a Japanese clause is found by a word inside it, in the chat and in the lore, and a long query never overruns the answer", async () => {
    const host = harbour();
    // "Mara hid the brass key under the floor of the lighthouse." / an entry: "The brass key opens the strongbox of the customs house."
    host.sayAt(CHAT, "user", "マラは真鍮の鍵を灯台の床下に隠した。", START + 9 * 86_400_000, "Mara");
    host.addEntry("book-coast", "33333333-aaaa-4000-8000-000000000007", "真鍮の鍵", ["鍵"], "真鍮の鍵は税関の金庫を開ける。");
    const tools = await toolRig(host, [...CHAT_TOOLS, ...LORE_TOOLS], { settings: (s) => (s.tools.pageChars = 900) });
    const inChat = await tools.run("chat_search", { queries: ["床下"] });
    expect(inChat.text).toContain("[#12 ");
    expect(inChat.text).toContain("床下に隠した");
    const inLore = await tools.run("lore_search", { queries: ["金庫"] });
    expect(inLore.text).toContain("[33333333] 真鍮の鍵");
    // 5,000 characters of a script with no space, as a query, as a name and as a grep.
    const long = "真鍮の鍵はどこにあるのか".repeat(420);
    const asks: [string, JsonObject][] = [["chat_search", { queries: [long] }], ["lore_search", { queries: [long, long.slice(1)] }], ["chat_about", { names: [long] }], ["chat_grep", { text: long }], ["lore_grep", { text: long }], ["lore_about", { name: long }]];
    for (const [name, args] of asks) {
      const answer = await tools.run(name, args);
      expect({ name, length: answer.text.length <= 900 ? "within" : answer.text.length }).toEqual({ name, length: "within" });
      // Nothing is cut inside a character.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(answer.text)).toBe(false);
    }
  });
});

describe("search by meaning", () => {
  /** Words that mean the same, as the fake embedder knows them. */
  const CONCEPTS = [
    ["boat", "vessel", "skiff", "heron"],
    ["debt", "owes", "owed", "arrears", "ledger"],
    ["lamp", "lantern", "beacon", "lighthouse"],
  ];

  test("finds a paraphrase that shares no word with the query, in the lore and in the chat, once its text is embedded; without an embedder search says once that it is by word", async () => {
    const host = harbour();
    const embedder = new FakeEmbedder(CONCEPTS);
    host.recall = { ...host.recall, embeddings: embedder };
    // Search by meaning is off until the user switches it on: here they have.
    const on = (s: Settings): void => void (s.recall.meaning.enabled = true);
    const tools = await toolRig(host, [...CHAT_TOOLS, ...LORE_TOOLS], { settings: on });
    // No word of the query stands in any entry or message: by word alone it finds nothing.
    const before = await tools.run("lore_search", { queries: ["arrears"] });
    expect(before.text).toContain("No lore entry matches “arrears”");
    // The first search had the texts embedded in the background; the next one finds by meaning.
    await Recall.of(host).meaning.settled();
    const after = await tools.run("lore_search", { queries: ["arrears"] });
    expect(after.text).toContain("matched by meaning");
    expect(after.text).toMatch(/\[22222222-[abc]\]/);
    await tools.run("chat_search", { queries: ["beacon"] });
    await Recall.of(host).meaning.settled();
    const chat = await tools.run("chat_search", { queries: ["beacon"] });
    // Message #4 rows out to the lighthouse; message #5 trims the lamp.
    expect(chat.text).toMatch(/\[#[45] /);
    expect(chat.text).toContain("by meaning");
    // Each text was embedded once, however many searches there were.
    const stored = embedder.stored;
    expect(new Set(stored).size).toBe(stored.length);
    await tools.run("lore_search", { queries: ["vessel"] });
    await Recall.of(host).meaning.settled();
    expect(embedder.stored.length).toBe(stored.length);

    // Switched on, on a host with no embedder: search is by word, and says so once in a run.
    const plain = await toolRig(harbour(), [...CHAT_TOOLS, ...LORE_TOOLS], { settings: on });
    const said = "[Search is by word here: no embedding connection is set up in Lumiverse";
    expect((await plain.run("lore_search", { queries: ["key"] })).text).toContain(said);
    expect((await plain.run("lore_search", { queries: ["lamp"] })).text).not.toContain(said);
    expect((await plain.run("chat_search", { queries: ["key"] })).text).not.toContain(said);
  });

  test("the daily cap holds: what is past it waits for the next day, and the page says how much is embedded", async () => {
    const host = harbour();
    const embedder = new FakeEmbedder(CONCEPTS);
    host.recall = { ...host.recall, embeddings: embedder };
    // Room for a handful of the chat's twelve messages and the six entries, at 3.2 characters a token.
    const r = rig(host, [], (s) => Object.assign(s.recall.meaning, { enabled: true, tokensPerDay: 120 }));
    const started = await r.harness.recall.embed({ chatId: CHAT, start: true });
    expect(started.embedding).toMatchObject({ enabled: true, connection: { id: "embed-1", model: "fake-embed" }, lore: { total: 6 }, messages: { total: 12 } });
    await Recall.of(host).meaning.settled();
    const capped = (await r.harness.recall.embed({ chatId: CHAT, start: false })).embedding;
    const done = capped.lore.embedded + capped.messages.embedded;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(18);
    expect(capped.today.tokens).toBeLessThanOrEqual(120);
    expect(capped.pending).toBe(18 - done);
    // A day later the rest fits.
    host.clock.advance(25 * 3_600_000);
    r.stored.values.recall.meaning.tokensPerDay = null;
    await r.harness.recall.embed({ chatId: CHAT, start: true });
    await Recall.of(host).meaning.settled();
    const all = (await r.harness.recall.embed({ chatId: CHAT, start: false })).embedding;
    expect([all.lore.embedded, all.messages.embedded, all.pending]).toEqual([6, 12, 0]);
    expect(embedder.stored.length).toBe(18);
  });
});

describe("the chat's books", () => {
  test("a book that applies to the chat from two places is one book: its entries are listed once and found once", async () => {
    const host = harbour();
    // As a host lists a book that is both the character's and the chat's.
    const coast = host.books[0];
    if (!coast) throw new Error("the harbour has no book");
    host.books.push({ ...coast });
    const r = rig(host, []);
    const listing = await r.harness.recall.lore({ chatId: CHAT });
    expect(listing.books.map((book) => [book.id, book.entries])).toEqual([["book-coast", 3], ["book-people", 3]]);
    expect(listing.entries.length).toBe(6);
    const tools = await toolRig(host, [...LORE_TOOLS]);
    expect((await tools.run("lore_search", { queries: ["strongbox"] })).text).toContain("“strongbox”: 1 entry found");
  });
});

describe("what the pages read", () => {
  test("a chat's lore with each entry's state, an entry whole, the agents' own search, the chronicle's check, cited messages and the story's learning", async () => {
    const host = harbour();
    const lore = activate(host, OKORO);
    const r = rig(host, [brief(), "The reply."]);
    // Before any turn no entry is in a prompt.
    const fresh = await r.harness.recall.lore({ chatId: CHAT });
    expect(fresh.last).toBeNull();
    expect(fresh.books).toEqual([
      { id: "book-coast", name: "The Coast", description: "Places along the shore.", entries: 3 },
      { id: "book-people", name: "People", description: "", entries: 3 },
    ]);
    expect(fresh.entries.map((e) => e.state)).toEqual(["not_in_prompt", "not_in_prompt", "off", "not_in_prompt", "not_in_prompt", "not_in_prompt"]);
    expect(fresh.embedding).toMatchObject({ connection: null, lore: { embedded: 0, total: 6 } });
    const { request } = await r.turn([...lore, ...host.requestOf(CHAT, 12, null).slice(8)]);
    const after = await r.harness.recall.lore({ chatId: CHAT });
    expect(after.last?.generationId).toBe(request.generationId);
    expect(after.entries.find((e) => e.entryId === OKORO)).toMatchObject({ short: "22222222-a", state: "in_prompt", constant: true, why: { by: "constant" }, chars: contentOf(host, OKORO).length });

    expect(await r.harness.recall.entry({ chatId: CHAT, entryId: "22222222-b" })).toMatchObject({ entry: { entryId: BRANN, title: "Brann" }, text: contentOf(host, BRANN) });
    await expect(r.harness.recall.entry({ chatId: CHAT, entryId: "nothing" })).rejects.toMatchObject({ code: "not_found" });

    // Settings as a new user has them: search by meaning is off, so the search is by word.
    const search = await r.harness.recall.search({ chatId: CHAT, queries: ["strongbox", "nothing-at-all"], limit: 2 });
    expect(search.meaning).toBe("off");
    expect(search.queries.map((q) => [q.query, q.total])).toEqual([["strongbox", 1], ["nothing-at-all", 0]]);
    expect(search.queries[0]?.hits[0]).toMatchObject({ entryId: CUSTOMS, short: "11111111-a", book: "The Coast", state: "not_in_prompt", by: ["word"], fields: ["key", "text"], words: ["strongbox"] });
    expect(search.queries[0]?.hits[0]?.lines[0]).toEqual({ line: 2, text: "Its strongbox takes two keys turned at once: the brass key and the keeper's." });

    // The chronicle: none yet, then one whose second line cites what no message reads as.
    expect(await r.harness.recall.chronicle({ chatId: CHAT })).toEqual({ files: [], failures: [], moved: [], uncited: [] });
    const chat = await recallOf((await toolRig(host, [], { runId: "page-test" })).env).chat();
    const cite = citeDoc(chat.messages[3]!);
    await r.harness.workspace.write({ chatId: CHAT, area: "learned", path: "chronicle/outline.md", base: null, text: `- #0–#3 · At the harbour: Mara shows Joss the brass key. ${citeDoc(chat.messages[0]!)} ${cite}\n- #4–#7 · At the lighthouse: Okoro names the ledger. [#4 00000000] [#7 00000000]` });
    const check = await r.harness.recall.chronicle({ chatId: CHAT });
    expect(check.files).toEqual([{ path: "learned/chronicle/outline.md", chars: expect.any(Number) as unknown as number, lines: 2, cited: 2, failed: 1 }]);
    expect(check.failures.map((f) => [f.path, f.line, f.citation, f.why])).toEqual([
      ["learned/chronicle/outline.md", 2, "[#4 00000000]", "changed"],
      ["learned/chronicle/outline.md", 2, "[#7 00000000]", "changed"],
    ]);

    // A citation of another message's text at a wrong number is read at the one message that reads as cited; four hex characters are no citation.
    const { cited } = await r.harness.recall.cited({ chatId: CHAT, citations: [cite, "[#3 00000000]", "[#99 abcd0123]", "nonsense", `[#9 ${chat.messages[3]!.hash.slice(0, 8)}]`, "[#3 a3f9]"] });
    expect(cited.map((c) => [c.index, c.ok, c.why ?? null, c.now ?? null, c.message?.name ?? null])).toEqual([
      [3, true, null, null, "Joss"],
      [3, false, "changed", null, "Joss"],
      [99, false, "gone", null, null],
      [-1, false, "gone", null, null],
      [9, false, "moved", 3, "Joss"],
      [-1, false, "gone", null, null],
    ]);
    expect(cited[0]?.message).toMatchObject({ index: 3, role: "assistant", text: chat.messages[3]!.text });

    // Learning the story: nothing planned yet, the outline spans eight of the chat's twelve messages, what the four left are reckoned to take, and what the page offers to start with.
    const path = await host.chat.path(CHAT);
    const left = path.slice(8).reduce((n, m) => n + m.chars, 0);
    const tokens = left / r.stored.values.loop.charsPerToken;
    const reckoned = { messages: 4, chars: left, stretches: 1, promptTokens: Math.ceil(tokens * 4), cachedTokens: 0, writtenTokens: Math.ceil(tokens * 0.25), weighedTokens: Math.ceil(tokens * 4), toolTurns: 4 };
    expect(await r.harness.recall.story({ chatId: CHAT })).toEqual({ plan: null, messages: path.length, covered: 8, estimate: { ...reckoned, usd: null }, suggested: { task: "Learn this chat's story and build its chronicle in learned/chronicle/. Load the skill story-learn first and follow it.", agent: "chronicler" }, refused: null });
    // The chronicler runs where the main agent does: once the user has a price for that model, the estimate has a cost.
    r.stored.values.prices["model-main"] = { in: 2, cachedIn: 0.2, out: 8 };
    expect((await r.harness.recall.story({ chatId: CHAT })).estimate.usd).toBeCloseTo((reckoned.promptTokens * 2 + reckoned.writtenTokens * 8) / 1_000_000, 12);
    await r.harness.workspace.write({ chatId: CHAT, area: "learned", path: "chronicle/plan.md", base: null, text: "- [ ] #0–#11, read closely" });
    expect((await r.harness.recall.story({ chatId: CHAT })).plan).toBe("learned/chronicle/plan.md");
    await expect(r.harness.recall.lore({ chatId: "" })).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("what learning a story is reckoned to take", () => {
  /** `count` messages from number `from`, each `chars` long. */
  const messages = (from: number, count: number, chars: number): { index: number; chars: number }[] => Array.from({ length: count }, (_, i) => ({ index: from + i, chars }));

  test("a plain reckoning from the messages still uncovered and Settings' figures; the cost where the model has a price", () => {
    const settings = defaultSettings();
    Object.assign(settings.loop, { charsPerToken: 4 });
    // 150 uncovered messages of 600 characters: 90,000 characters, 22,500 tokens of chat, three stretches of sixty messages at most.
    const rest = messages(0, 150, 600);
    expect(storyEstimate(rest, [0], settings, null)).toEqual({ messages: 150, chars: 90_000, stretches: 3, promptTokens: 90_000, cachedTokens: 0, writtenTokens: 5625, weighedTokens: 90_000, toolTurns: 12, usd: null });
    // The figures are settings: a job that sends less and writes more comes out so.
    Object.assign(settings.recall.chronicle, { estimateSent: 2.5, estimateWritten: 0.5, estimateRounds: 3 });
    expect(storyEstimate(rest, [0], settings, null)).toMatchObject({ promptTokens: 56_250, writtenTokens: 11_250, weighedTokens: 56_250, toolTurns: 9 });
    // A price for the model the chronicler runs on gives the cost: prompt and written tokens at the user's price a million, nothing taken as read from a cache.
    settings.prices["model-main"] = { in: 2, cachedIn: 0.2, out: 8 };
    expect(storyEstimate(rest, [0], settings, "model-main").usd).toBeCloseTo((56_250 * 2 + 11_250 * 8) / 1_000_000, 12);
    // A model the user has no price for, by any name it starts with: no cost.
    expect(storyEstimate(rest, [0], settings, "another-model").usd).toBeNull();
  });

  test("nothing left is all zeros; two runs with covered messages between them are never counted as one stretch", () => {
    const settings = defaultSettings();
    expect(storyEstimate([], [], settings, "model-main")).toEqual({ messages: 0, chars: 0, stretches: 0, promptTokens: 0, cachedTokens: 0, writtenTokens: 0, weighedTokens: 0, toolTurns: 0, usd: 0 });
    // Ten messages left before a covered part and ten after it: two stretches, though twenty messages would fit one.
    const rest = [...messages(0, 10, 100), ...messages(500, 10, 100)];
    expect(storyEstimate(rest, [0, 500], settings, null)).toMatchObject({ messages: 20, chars: 2000, stretches: 2, toolTurns: 8 });
    expect(storyEstimate(messages(0, 20, 100), [0], settings, null).stretches).toBe(1);
  });
});

describe("a long chat", () => {
  /** Invented words a long story is made of: enough of them that no two messages read alike. */
  const WORDS = "harbour lamp tide ledger key strongbox mill wheel flood quay net float rope oar skiff keeper debt page salt gull fog bell stair cellar lantern chart reef storm cargo crate barrel anchor chain mast sail hull deck plank tar pitch brine kelp shoal buoy wharf crane hook rope coil knot splice".split(" ");
  const NAMES = ["Mara", "Joss", "Ilse", "Brann", "Okoro"];
  const sentence = (seed: number): string => {
    const out: string[] = [];
    for (let i = 0; i < 12; i++) out.push(WORDS[(seed * 31 + i * 17 + ((seed >> 3) % 7)) % WORDS.length] ?? "tide");
    return `${NAMES[seed % NAMES.length]} ${out.join(" ")}.`;
  };

  test("5,000 messages and 500 entries are indexed and searched within bounds that a quadratic index would break", async () => {
    const host = new RecallHost();
    for (let i = 0; i < 5000; i++) host.sayAt(CHAT, i % 2 === 0 ? "user" : "assistant", [sentence(i), sentence(i * 7 + 1), sentence(i * 13 + 5), i === 4321 ? "The brass sextant lay under the cellar stair." : sentence(i * 3 + 2)].join(" "), START + i * 60_000, NAMES[i % NAMES.length]);
    host.addBook("book-big", "The Coast");
    for (let i = 0; i < 500; i++) host.addEntry("book-big", `${String(i).padStart(8, "0")}-aaaa-4000-8000-000000000000`, `Entry ${i} ${WORDS[i % WORDS.length]}`, [WORDS[(i * 7) % WORDS.length] ?? "tide", `key${i}`], [sentence(i + 11), sentence(i + 23), i === 432 ? "The brass sextant belongs to the keeper." : sentence(i + 37)].join("\n"));
    const tools = await toolRig(host, [...CHAT_TOOLS, ...LORE_TOOLS], { turn: null });
    const timed = async <T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> => {
      const from = performance.now();
      const value = await work();
      return { ms: performance.now() - from, value };
    };
    // The first search of each builds its index: bounded at five seconds for the chat and two for the lore, far above what a linear build takes and far below a quadratic one.
    const chatBuild = await timed(() => tools.run("chat_search", { queries: ["brass sextant"] }));
    expect(chatBuild.value.text).toContain("[#4321 ");
    expect(chatBuild.ms).toBeLessThan(5000);
    const loreBuild = await timed(() => tools.run("lore_search", { queries: ["brass sextant"] }));
    expect(loreBuild.value.text).toContain("[00000432] Entry 432");
    expect(loreBuild.ms).toBeLessThan(2000);
    // Once built, a call of several queries is answered in well under half a second, and so are a trail, an outline and a grep over the whole chat.
    const again = await timed(async () => [await tools.run("chat_search", { queries: ["brass sextant", "ledger flood", "Okoro lantern", "cellar stair"] }), await tools.run("lore_search", { queries: ["sextant", "keeper", "flood", "reef storm"] })]);
    expect(again.ms).toBeLessThan(500);
    const trail = await timed(() => tools.run("chat_about", { names: ["sextant", "Okoro"] }));
    expect(trail.value.text).toContain("“sextant” appears in one message");
    expect(trail.ms).toBeLessThan(500);
    const outline = await timed(() => tools.run("chat_outline", {}));
    expect(outline.value.error).toBeUndefined();
    expect(outline.ms).toBeLessThan(500);
    const grep = await timed(() => tools.run("chat_grep", { text: "brass sextant" }));
    expect(grep.value.text).toContain("[#4321 ");
    expect(grep.ms).toBeLessThan(500);
    const related = await timed(() => tools.run("lore_about", { name: "sextant" }));
    expect(related.ms).toBeLessThan(500);
    // A later run of the same chat reads no message again: the index is kept.
    const reads = host.messageReads;
    const later = await toolRig(host, [...CHAT_TOOLS], { turn: null, runId: "job-later" });
    const second = await timed(() => later.run("chat_search", { queries: ["brass sextant"] }));
    expect(host.messageReads).toBe(reads);
    expect(second.ms).toBeLessThan(500);
  }, 30_000);
});
