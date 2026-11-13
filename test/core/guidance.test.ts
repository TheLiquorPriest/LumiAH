// Guidance (DESIGN §12) through whole turns on an in-memory host: the three levels of a plain chat
// (the user's, the character's, the chat's) lead every agent's instructions in that order, each
// named; a level longer than Guidance length is given cut, with where the whole is; and an agent
// writes the chat's level only while Settings allow, and the user's and the character's never.

import { describe, expect, test } from "bun:test";
import { characterGuidance } from "../../src/core/guidance";
import { createHarness } from "../../src/core/harness";
import type { ModelRequest, ModelToolCall } from "../../src/core/ports";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { renderDefault, TEXT } from "../../src/core/texts";
import { call, MemoryHost, runTurn, type Script } from "./support/host";

const CHAT = "chat-1";
const OKORO = "char-okoro";
const USER = "Keep replies under a hundred words.";
const CHARACTER = "Okoro speaks in short sentences.";
const LEARNED = "Okoro never raises his voice.";

/** A level as an agent's instructions hold it. */
const level = (whose: string, text: string): string => `[Guidance ${whose}. Follow it.]\n${text}`;
const LEVELS = [level("from the user, for every chat", USER), level("from the user, for every chat with Okoro", CHARACTER), level("for this chat", LEARNED)];

const system = (request: ModelRequest | undefined): string => (request?.messages[0]?.role === "system" ? request.messages[0].content : "");
const offered = (request: ModelRequest | undefined): string[] => request?.tools?.map((t) => t.name) ?? [];
/** Which of a run's agents a request is from: the writer takes no tools, and only the agent a run starts with holds write_reply. */
const from = (request: ModelRequest): "writer" | "main" | "sub" => (!request.tools ? "writer" : offered(request).includes("write_reply") ? "main" : "sub");
/** The agent has had a round of tool calls on the message it is working on. */
const worked = (request: ModelRequest): boolean => request.messages.at(-1)?.parts?.some((part) => part.type === "tool_result") === true;

/** A model whose main agent makes `calls` in its first round, then briefs the writer; a sub-agent answers at once. */
const calling = (...calls: ModelToolCall[]): Script => (request) => {
  if (from(request) === "writer") return "The door opens a hand's width.";
  if (from(request) === "sub") return "Okoro keeps it.";
  return calls.length > 0 && !worked(request) ? { toolCalls: calls } : { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "w1")] };
};

/** A chat with Okoro, and a harness whose settings a test changes. */
function rig(script: Script, change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  host.script = script;
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I walk down to the lighthouse and knock.");
  host.infos.set(CHAT, { characterId: OKORO, characterName: "Okoro" });
  const stored = { values: defaultSettings(), texts: {} as Record<string, string> };
  change(stored.values);
  const harness = createHarness(host, { settings: async () => structuredClone(stored) });
  /** Writes each level the test names, as the user on the page. */
  const guide = async (texts: { user?: string; middle?: string; chat?: string }): Promise<void> => {
    for (const [id, text] of Object.entries(texts)) await harness.guidance.set({ chatId: CHAT, level: id as "user" | "middle" | "chat", text, base: null });
  };
  /** What a tool call was answered with, as its model read it in the request that followed. */
  const result = (callId: string): { content: string; failed: boolean } | undefined => {
    for (const request of host.calls) for (const m of request.messages) for (const part of m.parts ?? []) if (part.type === "tool_result" && part.toolUseId === callId) return { content: part.content, failed: part.isError === true };
    return undefined;
  };
  const turn = async (said?: string) => {
    if (said !== undefined) host.say(CHAT, "user", said);
    return runTurn(host, harness, CHAT);
  };
  return { host, harness, stored, guide, result, turn };
}

describe("the three levels", () => {
  test("lead the main agent's instructions and a sub-agent's in order, the user's first and the chat's last, each named; the writer is sent none", async () => {
    const r = rig(calling(call("delegate", { agent: "summarizer", task: "Say who keeps the lighthouse." }, "d1")));
    await r.guide({ user: USER, middle: CHARACTER, chat: LEARNED });
    await r.turn();
    const main = r.host.calls.find((request) => from(request) === "main");
    const sub = r.host.calls.find((request) => from(request) === "sub");
    expect(system(main)).toStartWith(`${LEVELS.join("\n\n")}\n\n${renderDefault(TEXT.main.system)}`);
    expect(system(sub)).toStartWith(`${LEVELS.join("\n\n")}\n\n${renderDefault(TEXT.agents.summarizer)}`);
    // Each level is a file of the workspace, the character's kept with the user's files by the character's id.
    expect((await r.harness.guidance.get({ chatId: CHAT })).levels.map((l) => [l.id, l.path])).toEqual([
      ["user", "~/GUIDANCE.md"],
      ["middle", `~/${characterGuidance(OKORO)}`],
      ["chat", "learned/GUIDANCE.md"],
    ]);
    const writer = r.host.calls.find((request) => from(request) === "writer");
    expect(JSON.stringify(writer?.messages)).not.toContain("[Guidance");
    // The agent that started the run is told which guidance it was given, in its trace.
    const started = r.host.traced.flatMap(({ event }) => (event.kind === "agent_started" && event.agent.role === "main" ? [event.agent.prefix] : []));
    expect(started).toEqual([LEVELS]);
  });

  test("a level nothing is written in is left out, and the others stand in their order", async () => {
    const r = rig(calling());
    await r.guide({ user: USER, middle: "  \n", chat: LEARNED });
    await r.turn();
    expect(system(r.host.calls[0])).toStartWith(`${[LEVELS[0], LEVELS[2]].join("\n\n")}\n\n${renderDefault(TEXT.main.system)}`);
    // With none written at all, the instructions open as they are.
    const bare = rig(calling());
    await bare.turn();
    expect(system(bare.host.calls[0])).toStartWith(renderDefault(TEXT.main.system));
  });

  test("a chat without a character has the user's level and its own, and another chat with the same character shares the character's but not the chat's", async () => {
    const r = rig(calling());
    await r.guide({ user: USER, middle: CHARACTER, chat: LEARNED });
    for (const [chat, character] of [["chat-2", OKORO], ["chat-3", null]] as const) {
      r.host.say(chat, "user", "I wait on the quay.");
      if (character !== null) r.host.infos.set(chat, { characterId: character, characterName: "Okoro" });
    }
    await runTurn(r.host, r.harness, "chat-2");
    expect(system(r.host.calls.findLast((request) => from(request) === "main"))).toStartWith(`${[LEVELS[0], LEVELS[1]].join("\n\n")}\n\n${renderDefault(TEXT.main.system)}`);
    await runTurn(r.host, r.harness, "chat-3");
    expect(system(r.host.calls.findLast((request) => from(request) === "main"))).toStartWith(`${LEVELS[0]}\n\n${renderDefault(TEXT.main.system)}`);
  });
});

describe("Guidance length", () => {
  test("a level longer than the setting is given cut, with how much of it and the file that holds the whole; one within it is given whole", async () => {
    const long = "The lamp is lit at dusk and never before. ".repeat(8);
    const r = rig(calling(), (s) => (s.guidance.chars = 100));
    await r.guide({ user: long, chat: LEARNED });
    expect((await r.harness.guidance.get({ chatId: CHAT })).limit).toBe(100);
    await r.turn();
    const cut = `${long.slice(0, 100)}\n[Cut here, at 100 of ${long.length} characters, as far as Guidance length (Settings → Guidance) goes. The whole is the workspace file ~/GUIDANCE.md.]`;
    expect(system(r.host.calls[0])).toStartWith(`${level("from the user, for every chat", cut)}\n\n${LEVELS[2]}\n\n`);
    // The page still holds the whole text: the setting bounds what an agent is given, not the file.
    expect((await r.harness.guidance.get({ chatId: CHAT })).levels.find((l) => l.id === "user")?.text).toBe(long);
    // A larger setting takes effect on the next turn.
    r.stored.values.guidance.chars = long.length;
    await r.turn("I knock again.");
    expect(system(r.host.calls.findLast((request) => from(request) === "main"))).toStartWith(`${level("from the user, for every chat", long)}\n\n${LEVELS[2]}\n\n`);
  });
});

describe("an agent and the guidance files", () => {
  const NEW = "Okoro owes the chandler for oil.";
  const write = (path: string, id: string): ModelToolCall => call("workspace_write", { path, content: NEW, base: "new" }, id);
  const user = "is guidance the user writes for you, and an agent can't change it. If it should change, say what and why in your answer.";

  test("as it ships, an agent writes none of the three levels: each write is refused in words that say whose the file is, and nothing is changed", async () => {
    const r = rig(calling(write("learned/GUIDANCE.md", "g1"), write("~/GUIDANCE.md", "g2"), write(`~/${characterGuidance(OKORO)}`, "g3"), write("learned/notes.md", "g4")));
    await r.turn();
    expect(r.result("g1")).toEqual({ content: "Not changed: learned/GUIDANCE.md is this chat's guidance, and Settings don't let agents edit it (Agents may edit the chat's guidance). If it should change, say what and why in your answer.", failed: true });
    expect(r.result("g2")).toEqual({ content: `Not changed: ~/GUIDANCE.md ${user}`, failed: true });
    expect(r.result("g3")).toEqual({ content: `Not changed: ~/${characterGuidance(OKORO)} ${user}`, failed: true });
    // Any other file of learned/ is the agent's to write.
    expect(r.result("g4")?.failed).toBe(false);
    const view = await r.harness.guidance.get({ chatId: CHAT });
    expect(view.agentsEdit).toBe(false);
    expect(view.levels.map((l) => l.text)).toEqual(["", "", ""]);
  });

  test("with Agents may edit the chat's guidance on, an agent writes the chat's level, recorded as its own, and the next turn's agents are given it; the user's and the character's stay the user's", async () => {
    const r = rig(calling(write("learned/GUIDANCE.md", "g1"), write("~/GUIDANCE.md", "g2"), write(`~/${characterGuidance(OKORO)}`, "g3")), (s) => (s.guidance.agentsEdit = true));
    await r.turn();
    expect(r.result("g1")?.failed).toBe(false);
    expect(r.result("g2")).toEqual({ content: `Not changed: ~/GUIDANCE.md ${user}`, failed: true });
    expect(r.result("g3")?.failed).toBe(true);
    const view = await r.harness.guidance.get({ chatId: CHAT });
    expect(view.agentsEdit).toBe(true);
    expect(view.levels.map((l) => [l.id, l.text])).toEqual([
      ["user", ""],
      ["middle", ""],
      ["chat", NEW],
    ]);
    expect(view.levels.find((l) => l.id === "chat")?.by).toMatchObject({ who: "agent", role: "main" });
    await r.turn("I knock again.");
    expect(system(r.host.calls.findLast((request) => from(request) === "main"))).toStartWith(`${level("for this chat", NEW)}\n\n`);
  });

  test("a file can't be moved onto a level the agent may not write, nor a level moved away or deleted", async () => {
    const r = rig((request) => {
      if (from(request) === "writer") return "The door opens.";
      const rounds = request.messages.filter((m) => m.parts?.some((part) => part.type === "tool_result")).length;
      if (rounds === 0) return { toolCalls: [write("learned/notes.md", "n1")] };
      if (rounds === 1) {
        const version = /version ([0-9a-f]{12})/.exec(r.result("n1")?.content ?? "")?.[1] ?? "";
        const guidance = /"hash":"([0-9a-f]{12})/.exec(JSON.stringify(levels))?.[1] ?? "";
        return { toolCalls: [call("workspace_move", { from: "learned/notes.md", to: "learned/GUIDANCE.md", base: version }, "m1"), call("workspace_move", { from: "~/GUIDANCE.md", to: "~/old.md", base: guidance }, "m2"), call("workspace_delete", { path: "~/GUIDANCE.md", base: guidance }, "m3")] };
      }
      return { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "w1")] };
    });
    await r.guide({ user: USER });
    const levels = (await r.harness.guidance.get({ chatId: CHAT })).levels;
    await r.turn();
    for (const id of ["m1", "m2", "m3"]) expect([id, r.result(id)?.failed, r.result(id)?.content.startsWith("Not changed: ")]).toEqual([id, true, true]);
    expect((await r.harness.guidance.get({ chatId: CHAT })).levels.map((l) => l.text)).toEqual([USER, "", ""]);
    expect((await r.harness.workspace.list({ chatId: CHAT, area: "learned" })).files.map((file) => file.path)).toEqual(["notes.md"]);
  });
});
