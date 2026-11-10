// The request, read two ways (DESIGN §3.1, §3.2): as the document the main agent reads, and as the
// writer's conversation with the brief put in; and the agent definitions that run them.

import { describe, expect, test } from "bun:test";
import { AgentRegistry, baseAgents } from "../../src/core/agents";
import type { PathMessage, PresetBlock, RequestMessage } from "../../src/core/ports";
import { requestDocument, writerMessages } from "../../src/core/request";
import { defaultSettings } from "../../src/core/settings";
import { Texts } from "../../src/core/texts";

const texts = new Texts();

const BLOCKS: PresetBlock[] = [
  { id: "b-main", name: "Main prompt", role: "system", kind: "instruction", marker: null, content: "Write in the present tense.", enabled: true },
  { id: "b-char", name: "Character", role: "system", kind: "marker", marker: "char_description", content: "", enabled: true },
];

const PATH: PathMessage[] = [
  { id: "m1", index: 0, role: "assistant", name: "Joss", swipeId: 0, chars: 5, hash: "", anchor: null },
  { id: "m2", index: 1, role: "user", name: "Mara", swipeId: 0, chars: 5, hash: "", anchor: null },
];

const MESSAGES: RequestMessage[] = [
  { role: "system", content: "Write in the present tense.", source: { kind: "block", blockId: "b-main" } },
  { role: "system", content: "Joss keeps the ferry.", source: { kind: "block", blockId: "b-char" } },
  { role: "system", content: "A note from a block the preset no longer has.", source: { kind: "block", blockId: "b-gone" } },
  { role: "assistant", content: "The ferry is in.", source: { kind: "history", messageId: "m1", index: 0 } },
  { role: "user", content: "I step aboard.", parts: [{ type: "text", text: "I step aboard." }, { type: "media", media: "image", data: "…", mimeType: "image/png" }], source: { kind: "history", messageId: "m2", index: 1 } },
  { role: "system", content: "Stay in the scene." },
];

describe("the request as a document", () => {
  test("numbers each message, says where it came from, and marks the preset's instructions", () => {
    const document = requestDocument(MESSAGES, BLOCKS, PATH, texts);
    expect(document.text).toBe(
      [
        "[1] system · preset instruction “Main prompt”: the reply must achieve this\nWrite in the present tense.",
        "[2] system · char_description, placed by “Character”\nJoss keeps the ferry.",
        "[3] system · preset block b-gone\nA note from a block the preset no longer has.",
        "[4] assistant · chat message #0, Joss\nThe ferry is in.",
        "[5] user · chat message #1, Mara\nI step aboard.\n[image attached]",
        "[6] system\nStay in the scene.",
      ].join("\n\n"),
    );
    expect(document).toMatchObject({ messages: 6, last: 1 });
  });

  test("without the preset nothing is marked, and an empty request says so", () => {
    expect(requestDocument(MESSAGES.slice(0, 1), [], PATH, texts).text).toBe("[1] system · preset block b-main\nWrite in the present tense.");
    expect(requestDocument([], BLOCKS, PATH, texts)).toEqual({ text: "(the request holds no messages)", messages: 0, last: null });
  });
});

describe("the writer's conversation", () => {
  const reply = defaultSettings().reply;
  const plain = MESSAGES.map(({ source: _source, ...m }) => m);
  const brief = { role: "system" as const, content: texts.render("writer.brief", { brief: "The ferry leaves at six." }) };

  test("is the request's messages as they came, without a brief", () => {
    expect(writerMessages(MESSAGES, null, reply, texts)).toEqual(plain);
  });

  test("puts the brief before the user's last chat message, at the end or at the start, as whose Settings say", () => {
    expect(writerMessages(MESSAGES, "The ferry leaves at six.", reply, texts)).toEqual([...plain.slice(0, 4), brief, ...plain.slice(4)]);
    expect(writerMessages(MESSAGES, "The ferry leaves at six.", { briefAt: "end", briefRole: "user" }, texts)).toEqual([...plain, { ...brief, role: "user" }]);
    expect(writerMessages(MESSAGES, "The ferry leaves at six.", { briefAt: "start", briefRole: "system" }, texts)).toEqual([brief, ...plain]);
  });

  test("where no message is traced to the chat, the last user message stands for it; where there is none, the end", () => {
    const untraced: RequestMessage[] = [{ role: "system", content: "Rules." }, { role: "user", content: "First." }, { role: "assistant", content: "Then." }, { role: "user", content: "Last." }, { role: "assistant", content: "A prefill" }];
    expect(writerMessages(untraced, "x", reply, texts).map((m) => m.content.split("\n").at(-1))).toEqual(["Rules.", "First.", "Then.", "x", "Last.", "A prefill"]);
    expect(writerMessages([{ role: "system", content: "Rules." }], "x", reply, texts)).toHaveLength(2);
  });
});

describe("agent definitions", () => {
  test("the core ships the main agent, the writer and the summarizer, each run as the user's settings say", () => {
    const agents = new AgentRegistry();
    agents.register(...baseAgents());
    const settings = defaultSettings();
    settings.agents.main = { ...settings.agents.main!, connectionId: "conn-a", model: "model-a", effort: "high" };
    expect(agents.ids()).toEqual(["main", "writer", "summarizer"]);
    expect(agents.resolve("main", settings)).toMatchObject({ connectionId: "conn-a", model: "model-a", effort: "high", tools: settings.agents.main.tools });
    expect(agents.resolve("writer", settings)).toMatchObject({ connectionId: null, model: null, tools: [] });
    expect(agents.resolve("nobody", settings)).toBeUndefined();
  });

  test("the summarizer runs where the main agent does until it is given a connection of its own", () => {
    const agents = new AgentRegistry();
    agents.register(...baseAgents());
    const settings = defaultSettings();
    settings.agents.main = { ...settings.agents.main!, connectionId: "conn-a", model: "model-a" };
    expect(agents.resolve("summarizer", settings)).toMatchObject({ connectionId: "conn-a", model: "model-a" });
    settings.agents.summarizer = { ...settings.agents.summarizer!, model: "model-small" };
    expect(agents.resolve("summarizer", settings)).toMatchObject({ connectionId: "conn-a", model: "model-small" });
    settings.agents.summarizer = { ...settings.agents.summarizer!, connectionId: "conn-b", model: null };
    expect(agents.resolve("summarizer", settings)).toMatchObject({ connectionId: "conn-b", model: null });
  });

  test("an extension's definition joins them, with defaults of its own until the user sets it up", () => {
    const agents = new AgentRegistry();
    agents.register(...baseAgents(), { id: "scout", label: "Scout", instructions: "main.system", defaults: { ...defaultSettings().agents.writer!, effort: "low" } });
    expect(agents.resolve("scout", defaultSettings())).toMatchObject({ effort: "low" });
    expect(agents.extra()).toEqual([{ id: "scout", label: "Scout", note: "", defaults: { ...defaultSettings().agents.writer!, effort: "low" } }]);
  });
});
