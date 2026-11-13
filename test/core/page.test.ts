// What the pages read and do through the harness (DESIGN §12, §13, §5, §20), each as one call with
// a JSON answer: guidance at its levels, every definition with its source, a rollback and an asked
// summary, spend with its caps, and what is stored. Each area's own behaviour has its own test file;
// these check the calls a page makes, end to end, on a harness that has run turns.

import { describe, expect, test } from "bun:test";
import { createHarness } from "../../src/core/harness";
import { HarnessRefusal } from "../../src/core/refusal";
import { defaultSettings, type Settings } from "../../src/core/settings";
import type { StoredDefinitions } from "../../src/core/definitions";
import { type Answer, call, idle, MemoryHost, runTurn, type Script, until } from "./support/host";

const CHAT = "chat-1";
const USAGE = { prompt_tokens: 1000, completion_tokens: 100 };

/** A turn's worth of answers: the main agent hands over a brief, the writer writes; each call reports what it used and the model that answered. */
const TURN: Script = (request) =>
  request.tools?.some((t) => t.name === "write_reply") ? { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "c1")], usage: USAGE, model: "model-main" } : { content: "The door opens.", usage: USAGE, model: "model-writer" };

function rig(script: Script = TURN, change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  host.script = script;
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I walk down to the lighthouse and knock.");
  const stored: { values: Settings; texts: Record<string, string>; definitions?: StoredDefinitions } = { values: defaultSettings(), texts: {} };
  change(stored.values);
  const harness = createHarness(host, { settings: async () => structuredClone(stored) });
  const turn = async (said?: string) => {
    if (said !== undefined) host.say(CHAT, "user", said);
    return runTurn(host, harness, CHAT, {});
  };
  return { host, harness, stored, turn };
}

/** The refusal a call was answered with: its code and its words. */
async function refused(work: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await work;
  } catch (error) {
    if (error instanceof HarnessRefusal) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("the call was not refused");
}

describe("guidance, on the page", () => {
  test("the user's level and the chat's are read and written as versioned files, and the next turn's agents are told them", async () => {
    const r = rig();
    const empty = await r.harness.guidance.get({ chatId: CHAT });
    expect(empty.levels.map((l) => [l.id, l.text, l.hash, l.editable])).toEqual([
      ["user", "", null, true],
      ["chat", "", null, true],
    ]);
    expect(empty.limit).toBe(8000);
    const first = await r.harness.guidance.set({ chatId: CHAT, level: "user", text: "Keep replies under a hundred words.", base: null });
    const user = first.levels.find((l) => l.id === "user");
    expect(user).toMatchObject({ text: "Keep replies under a hundred words.", by: { who: "user" }, path: "~/GUIDANCE.md" });
    await r.harness.guidance.set({ chatId: CHAT, level: "chat", text: "Okoro never raises his voice.", base: null });
    // A second write based on the version before it is refused, with nothing changed.
    const stale = await refused(r.harness.guidance.set({ chatId: CHAT, level: "user", text: "Something else.", base: null }));
    expect(stale.code).toBe("conflict");
    const again = await r.harness.guidance.set({ chatId: CHAT, level: "user", text: "Keep replies under eighty words.", base: user?.hash ?? null });
    expect(again.levels.find((l) => l.id === "user")?.text).toBe("Keep replies under eighty words.");
    await r.turn();
    // The main agent is told both, the user's before the chat's: later wins where they disagree.
    const system = r.host.calls[0]?.messages[0]?.content ?? "";
    expect(system).toContain("[Guidance from the user, for every chat. Follow it.]\nKeep replies under eighty words.");
    expect(system).toContain("[Guidance for this chat. Follow it.]\nOkoro never raises his voice.");
    expect(system.indexOf("Keep replies under eighty words.")).toBeLessThan(system.indexOf("Okoro never raises his voice."));
    // The writer's call is the request as Lumiverse assembled it with the brief put in (§3.2): nothing of LumiAH's is added to it.
    expect(JSON.stringify(r.host.calls[1]?.messages)).not.toContain("Keep replies under eighty words.");
  });

  test("a chat with a character has a level between them, kept with the user's files by the character's id", async () => {
    const r = rig();
    r.host.infos.set(CHAT, { characterId: "char-okoro", characterName: "Okoro" });
    const view = await r.harness.guidance.get({ chatId: CHAT });
    expect(view.levels.map((l) => l.id)).toEqual(["user", "middle", "chat"]);
    const set = await r.harness.guidance.set({ chatId: CHAT, level: "middle", text: "Okoro speaks in short sentences.", base: null });
    expect(set.levels.find((l) => l.id === "middle")).toMatchObject({ path: "~/characters/char-okoro/GUIDANCE.md", text: "Okoro speaks in short sentences." });
    // About no chat there is the user's level alone, and no other can be written.
    expect((await r.harness.guidance.get({ chatId: null })).levels.map((l) => l.id)).toEqual(["user"]);
    expect((await refused(r.harness.guidance.set({ chatId: null, level: "chat", text: "x", base: null }))).code).toBe("not_found");
  });
});

describe("definitions, on the page", () => {
  test("every agent, skill and tool is listed with where it comes from, with the form an agent's settings take", async () => {
    const r = rig();
    const answer = await r.harness.definitions.get({ chatId: CHAT });
    // The three a turn can't do without lead, as built-ins; the core's other workers follow them.
    expect(answer.agents.map((a) => [a.id, a.source, a.off]).slice(0, 3)).toEqual([
      ["main", "builtin", false],
      ["writer", "builtin", false],
      ["summarizer", "builtin", false],
    ]);
    expect(answer.agents.every((a) => a.source === "builtin" && !a.off)).toBe(true);
    expect(answer.skills.every((s) => s.source === "builtin")).toBe(true);
    const tools = new Map(answer.tools.map((t) => [t.name, t]));
    expect(tools.get("workspace_write")).toMatchObject({ family: "workspace", tier: "write", runs: "runtime", source: "builtin", off: false });
    expect(tools.get("chat_search")?.description.length).toBeGreaterThan(20);
    // What a new agent starts from is valid under the schema the page builds its form from.
    expect(answer.agentSchema).toMatchObject({ type: "object" });
    expect(Object.keys(answer.agentSchema.properties as object)).toEqual(expect.arrayContaining(["connectionId", "model", "tools", "toolCalls", "budget"]));
    expect(answer.agentDefaults).toMatchObject({ connectionId: null, model: null, toolCalls: "auto" });
    expect(answer.agentDefaults.tools).toContain("chat_read");
    expect(answer.agentDefaults.tools).not.toContain("workspace_write");
  });

  test("the user's own definitions stand beside the built-ins or over them, and what they switch off is offered to no agent", async () => {
    const r = rig();
    const writer = defaultSettings().agents.writer;
    if (!writer) throw new Error("no writer in the defaults");
    r.stored.definitions = {
      agents: { scout: { id: "scout", name: "Scout", description: "Reads ahead along the shore and says what it found.", instructions: "You scout the shore.", given: "task", ...writer, tools: ["chat_read"] } },
      skills: { tides: { id: "tides", name: "Tides", description: "How to read the tide table.", body: "High water comes twice a day." } },
      off: { tools: ["chat_grep"] },
    };
    const answer = await r.harness.definitions.get({ chatId: CHAT });
    expect(answer.agents.find((a) => a.id === "scout")).toMatchObject({ source: "user", off: false, instructions: "You scout the shore." });
    expect(answer.skills.find((s) => s.id === "tides")).toMatchObject({ source: "user", off: false });
    expect(answer.tools.find((t) => t.name === "chat_grep")).toMatchObject({ off: true });
    await r.turn();
    const offered = r.host.calls[0]?.tools?.map((t) => t.name) ?? [];
    expect(offered).not.toContain("chat_grep");
    expect(offered).toContain("chat_search");
    // A skill there is to load brings the tool that loads it, and its name into the prompt.
    expect(offered).toContain("skill_load");
    expect(r.host.calls[0]?.messages[0]?.content).toContain("tides");
    // The user's agent is one the main agent may delegate to.
    expect(JSON.stringify(r.host.calls[0]?.tools?.find((t) => t.name === "delegate"))).toContain("scout");
  });

  test("the list of skills in an agent's prompt keeps to Skill list length: even the first is named no further than the room goes", async () => {
    const r = rig();
    // The user's two skills are the only ones here: the core's own are switched off, so the first listed is the user's long one.
    r.stored.definitions = {
      skills: {
        tides: { id: "tides", name: "Tides", description: `How to read the tide table. ${"Twice a day the water comes in. ".repeat(20)}`, body: "High water comes twice a day." },
        lamps: { id: "lamps", name: "Lamps", description: "How to trim a lamp.", body: "Trim the wick each dusk." },
      },
      off: { skills: r.harness.skills.all().map((skill) => skill.id) },
    };
    r.stored.values.skills.listChars = 120;
    await r.turn();
    const system = r.host.calls[0]?.messages[0]?.content ?? "";
    const listed = system.split("\n").filter((line) => line.startsWith("- tides"));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.length).toBeLessThanOrEqual(120);
    expect(listed[0]).toEndWith("…");
    // The one that didn't fit is counted, and skill_load without a skill lists them all.
    expect(system).not.toContain("- lamps");
    expect(system).toContain("(1 more aren't listed here, past Skill list length (Settings → Skills): skill_load with no skill lists them all.)");
  });
});

describe("a job's news", () => {
  test("a job that stops while a turn is starting is told to that turn's main agent, and never again to the next", async () => {
    const tidy = "The notes are tidy: three files, nothing stale.";
    const r = rig((request) => {
      if (request.tools?.some((t) => t.name === "write_reply")) return { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "c1")] };
      return request.tools === undefined ? "The door opens." : tidy;
    });
    await r.turn();
    const { job } = await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: "Tidy the notes.", when: "now" });
    // The job runs and ends just after the next turn has begun, before that turn looks which jobs stopped.
    const path = r.host.chat.path;
    let during = true;
    r.host.chat.path = async (chatId) => {
      if (during) {
        during = false;
        r.host.clock.advance(1000);
        await r.harness.jobs.run({ id: job.id }, new AbortController().signal);
        r.host.clock.advance(1000);
      }
      return path(chatId);
    };
    const told = (): string => r.host.calls.findLast((made) => made.tools?.some((t) => t.name === "write_reply"))?.messages.at(-1)?.content ?? "";
    await r.turn("I knock again.");
    expect(told()).toContain(tidy);
    r.host.clock.advance(1000);
    await r.turn("I knock a third time.");
    expect(told()).not.toContain(tidy);
  });
});

describe("the session, on the page", () => {
  test("a rollback that would change nothing is refused in words, and an asked summary is noted for the next turn", async () => {
    const r = rig();
    await r.turn();
    const reply = r.host.last(CHAT);
    const none = await refused(r.harness.session.rollback({ chatId: CHAT, messageId: reply.id, swipe: reply.swipeId }));
    expect(none.code).toBe("conflict");
    expect(none.message.length).toBeGreaterThan(20);
    const asked = await r.harness.session.summarize({ chatId: CHAT });
    expect(asked.asked).toBe(r.host.clock.now());
  });
});

describe("spend, on the page", () => {
  test("every call is counted by day, chat, agent, connection and model, with its cost from the user's prices", async () => {
    const r = rig(TURN, (s) => {
      s.prices = { "model-main": { in: 2, cachedIn: 0, out: 10 } };
      // The writer on a connection of its own, whose model has no price.
      (s.agents.writer as NonNullable<typeof s.agents.writer>).connectionId = "conn-writer";
    });
    await r.turn();
    const spend = await r.harness.spend.get({ days: 1 });
    expect(spend.total).toMatchObject({ calls: 2, in: 2000, out: 200 });
    expect(spend.agents.map((row) => [row.key, row.calls, row.in, row.out]).sort()).toEqual([
      ["main", 1, 1000, 100],
      ["writer", 1, 1000, 100],
    ]);
    expect(spend.chats.map((row) => [row.key, row.calls])).toEqual([[CHAT, 2]]);
    // The main agent's model has a price: 1000 in at $2 a million and 100 out at $10 a million. The writer's has none, and is said to have none.
    const main = spend.models.find((row) => row.key === "model-main");
    expect(main?.cost).toBeCloseTo(0.003, 6);
    expect(spend.models.find((row) => row.key === "model-writer")).toMatchObject({ cost: 0, unpriced: 1 });
    expect(spend.caps.map((cap) => [cap.setting.join("."), cap.limit, cap.reached])).toEqual([
      ["spend.tokensPerDay", null, false],
      ["spend.costPerDay", null, false],
      ["jobs.tokensPerDay", 12_000_000, false],
    ]);
  });

  test("a daily cap that is reached stops the next turn's main agent before its first call, in words that name the setting, and the reply is still written; a day later the day counts nothing of it", async () => {
    const r = rig(TURN, (s) => {
      s.spend = { ...s.spend, tokensPerDay: 2000 };
    });
    expect((await r.turn()).result.status).toBe("done");
    const calls = r.host.calls.length;
    const capped = await r.turn("I knock again.");
    // A cap stops agents' work, never the reply the user waits for: the writer writes from the request alone, and that one call is made and counted.
    expect(capped.result.status).toBe("done");
    expect(r.host.calls.length).toBe(calls + 1);
    expect(r.host.calls.at(-1)?.tools).toBeUndefined();
    expect(capped.sink.progressLines.join("\n")).toContain("Tokens per day");
    const cap = (await r.harness.spend.get({ days: 1 })).caps[0];
    expect(cap).toMatchObject({ limit: 2000, reached: true });
    expect(cap?.used).toBeGreaterThanOrEqual(2200);
    // A day later nothing of it counts any more.
    r.host.clock.advance(25 * 3_600_000);
    expect((await r.harness.spend.get({ days: 1 })).caps[0]).toMatchObject({ used: 0, reached: false });
    expect((await r.turn("I knock a third time.")).result.status).toBe("done");
  });
});

describe("talking to a run, on the page", () => {
  test("a note said once the writer is writing the reply is refused in words: nobody would read it", async () => {
    const gate = Promise.withResolvers<void>();
    const r = rig(async (request) => {
      if (request.tools?.some((t) => t.name === "write_reply")) return { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "c1")] };
      await gate.promise;
      return "The door opens.";
    });
    const turn = r.turn();
    // The writer's call is under way: the main agent is in no round.
    await until(() => r.host.calls.length === 2);
    const run = r.host.traced[0]?.turn ?? "";
    const late = await refused(r.harness.say({ run, text: "Make it rain." }));
    expect(late.code).toBe("conflict");
    expect(late.message).toContain("The reply is being written now");
    gate.resolve();
    expect((await turn).result.status).toBe("done");
    // Nothing of the note reached a model, and once the run is over there is nobody to tell.
    expect(JSON.stringify(r.host.calls)).not.toContain("Make it rain.");
    expect((await refused(r.harness.say({ run, text: "Too late." }))).code).toBe("not_found");
  });

  test("a pause holds a turn's agents at their next round, a sub-agent's with the main agent's, and a resume lets the turn go on to its reply", async () => {
    const first = Promise.withResolvers<Answer>();
    const sub = Promise.withResolvers<Answer>();
    const isMain = (request: { tools?: { name: string }[] }): boolean => request.tools?.some((t) => t.name === "write_reply") === true;
    let mains = 0;
    let subs = 0;
    const r = rig((request) => {
      if (isMain(request)) return ++mains === 1 ? first.promise : { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "c9")] };
      // The sub-agent holds tools of its own; the writer holds none.
      if (request.tools?.length) return ++subs === 1 ? sub.promise : "Okoro keeps it.";
      return "The door opens.";
    });
    const turn = r.turn();
    await until(() => r.host.calls.length === 1);
    const run = r.host.traced[0]?.turn ?? "";
    // The main agent hands a task on, and the user holds the turn while the sub-agent's first call is out.
    first.resolve({ toolCalls: [call("delegate", { agent: "summarizer", task: "Say who keeps the lighthouse." }, "c1")] });
    await until(() => r.host.calls.length === 2);
    expect(await r.harness.pause({ run })).toEqual({ paused: true });
    sub.resolve({ toolCalls: [call("chat_read", { from: 0 }, "s1")] });
    await idle();
    // The sub-agent's round ran its tool, and it made no further call; nor did anybody else.
    expect(r.host.calls).toHaveLength(2);
    // Held, the turn still takes a note: its main agent reads it once it is let go.
    expect(await r.harness.say({ run, text: "He is slow to the door." })).toEqual({ said: true });
    expect(await r.harness.resume({ run })).toEqual({ paused: false });
    const { result } = await turn;
    expect(result).toMatchObject({ status: "done", reply: "The door opens." });
    const events = r.host.traced.filter((record) => record.turn === run).map((record) => record.event.kind);
    expect(events.filter((kind) => kind === "turn_paused" || kind === "turn_resumed")).toEqual(["turn_paused", "turn_resumed"]);
    expect(JSON.stringify(r.host.calls.findLast(isMain)?.messages)).toContain("[The user says, while you work:]\\nHe is slow to the door.");
    // Once the turn is over there is nothing to hold.
    for (const late of [r.harness.pause({ run }), r.harness.resume({ run })]) expect((await refused(late)).code).toBe("not_found");
  });
});

describe("a file's history, on the page", () => {
  test("lists its versions, reads any of them to compare, and restores one as a new version based on the file as it stands", async () => {
    const r = rig();
    const at = { chatId: CHAT, area: "learned" as const, path: "who.md" };
    const first = (await r.harness.workspace.write({ ...at, text: "Okoro keeps the lighthouse.", base: null })).file;
    r.host.clock.advance(1000);
    const second = (await r.harness.workspace.write({ ...at, text: "Ilse keeps the lighthouse.", base: first.hash })).file;
    const { versions } = await r.harness.workspace.history(at);
    expect(versions.map((v) => [v.hash, v.by])).toEqual([
      [second.hash, { who: "user" }],
      [first.hash, { who: "user" }],
    ]);
    // Two reads compare two versions; the file as it stands comes with each.
    const now = await r.harness.workspace.read(at);
    const was = await r.harness.workspace.read({ ...at, version: first.hash.slice(0, 12) });
    expect([now.text, now.version.hash]).toEqual(["Ilse keeps the lighthouse.", second.hash]);
    expect([was.text, was.version.hash, was.file.hash]).toEqual(["Okoro keeps the lighthouse.", first.hash, second.hash]);
    // Restoring is a versioned write of the earlier text, based on the file as it stands: nothing is lost, the version restored from stays in the history.
    const restored = (await r.harness.workspace.write({ ...at, text: was.text, base: was.file.hash })).file;
    expect(restored.hash).toBe(first.hash);
    expect((await r.harness.workspace.read(at)).text).toBe("Okoro keeps the lighthouse.");
    expect((await r.harness.workspace.history(at)).versions.map((v) => v.hash)).toEqual([first.hash, second.hash, first.hash]);
    // A version the file doesn't keep is refused in words, and so is one that isn't a version at all.
    expect((await refused(r.harness.workspace.read({ ...at, version: "0".repeat(64) }))).code).toBe("not_found");
    expect((await refused(r.harness.workspace.read({ ...at, version: 7 as unknown as string }))).code).toBe("bad_request");
  });
});

describe("what is stored, on the page", () => {
  test("a count names each kind a turn stored, and a sweep removes only what nothing refers to, once the grace time has passed", async () => {
    const r = rig();
    await r.turn();
    // A regenerated reply: the first swipe's record is kept with the swipe; nothing is loose yet.
    await runTurn(r.host, r.harness, CHAT, { kind: "regenerate" });
    const counted = await r.harness.upkeep.get();
    const kinds = new Map(counted.kinds.map((k) => [k.kind, k.count]));
    expect(kinds.get("segment")).toBeGreaterThan(0);
    expect(kinds.get("transcript")).toBeGreaterThan(0);
    expect(kinds.get("prompt")).toBeGreaterThan(0);
    // The user writes a file twice: the first version is history the workspace keeps, so its text stays. The list of files as it stood between the two writes is nobody's any more.
    const first = await r.harness.workspace.write({ chatId: CHAT, area: "learned", path: "who.md", text: "Okoro keeps the lighthouse.", base: null });
    const second = await r.harness.workspace.write({ chatId: CHAT, area: "learned", path: "who.md", text: "Okoro keeps the lighthouse, and its lamp.", base: first.file.hash });
    const before = r.host.blobStore.size;
    // A blob nothing refers to: within the grace time a sweep leaves it, as it leaves everything that young.
    const loose = "0".repeat(64);
    await r.host.blobs.put(loose, "left over by a run that never finished");
    const early = await r.harness.upkeep.sweep();
    expect(early.lastSweep?.removed).toBe(0);
    expect(r.host.blobStore.has(loose)).toBe(true);
    // Past it, the sweep removes that blob and the superseded list of files, and nothing else.
    r.host.clock.advance(25 * 3_600_000);
    const swept = await r.harness.upkeep.sweep();
    expect(swept.lastSweep?.removed).toBe(2);
    expect(r.host.blobStore.has(loose)).toBe(false);
    expect(r.host.blobStore.size).toBe(before - 1);
    // The file reads as it stands, and the version before it is still there to go back to.
    expect((await r.harness.workspace.read({ chatId: CHAT, area: "learned", path: "who.md" })).text).toBe("Okoro keeps the lighthouse, and its lamp.");
    expect(r.host.blobStore.get(first.file.hash)).toBe("Okoro keeps the lighthouse.");
    expect((await r.harness.workspace.history({ chatId: CHAT, area: "learned", path: "who.md" })).versions.map((v) => v.hash)).toEqual(expect.arrayContaining([first.file.hash, second.file.hash]));
    // Everything the chat needs is still there: the next turn's main agent goes on from its notes, which hold the brief of the turn before.
    const next = await r.turn("I knock again.");
    expect(next.result.status).toBe("done");
    expect(JSON.stringify(r.host.calls.findLast((made) => made.tools?.some((t) => t.name === "write_reply"))?.messages.slice(0, -1))).toContain("Okoro opens the door.");
  });
});
