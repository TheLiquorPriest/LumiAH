// The chat's area of the workspace along the story path (DESIGN §11), through whole turns on an
// in-memory host: a swipe starts from the files the reply it replaces started from and takes that
// reply's writes off the path with it; `learned/` is the chat's whatever is swiped; and a branch
// has the chat's area as the turn it was cut at left it, with a copy of `learned/` that goes its
// own way from then on.

import { describe, expect, test } from "bun:test";
import { createHarness } from "../../src/core/harness";
import { textHash } from "../../src/core/hash";
import type { ModelToolCall, WorkspaceArea } from "../../src/core/ports";
import { HarnessRefusal } from "../../src/core/refusal";
import { defaultSettings } from "../../src/core/settings";
import { type Answer, call, MemoryHost, promptText, runTurn } from "./support/host";

const CHAT = "chat-1";
const BRANCH = "chat-branch";
const PLAN = "Light the lamp before dusk.";
const FACTS = "Brann holds the lighthouse key.";

const write = (path: string, content: string, id: string): ModelToolCall => call("workspace_write", { path, content, base: "new" }, id);

/** A chat whose main agent writes its replies itself, so every model call is its own: `script` is its answers, in order, over all the turns. */
function rig(script: Answer[]) {
  const host = new MemoryHost();
  host.script = script;
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I walk down to the lighthouse and knock.");
  const stored = { values: defaultSettings(), texts: {} };
  stored.values.reply.writer = "main";
  const harness = createHarness(host, { settings: async () => structuredClone(stored) });
  const turn = (chatId = CHAT, options: Parameters<typeof runTurn>[3] = {}) => runTurn(host, harness, chatId, options);
  /** The paths an area holds, as the page lists them, in order. */
  const files = async (area: WorkspaceArea, chatId = CHAT): Promise<string[]> => (await harness.workspace.list({ chatId, area })).files.map((file) => file.path).sort();
  /** What a tool call was answered with, as the agent's next call carried it. */
  const result = (callId: string): string | undefined => {
    for (const request of host.calls) for (const m of request.messages) for (const part of m.parts ?? []) if (part.type === "tool_result" && part.toolUseId === callId) return part.content;
    return undefined;
  };
  return { host, harness, turn, files, result };
}

describe("the chat's area through a swipe", () => {
  test("a swipe starts from the files the reply it replaces started from, its writes are its own, and showing the first swipe again shows the first swipe's files", async () => {
    const r = rig([
      { toolCalls: [write("/notes/plan.md", PLAN, "a1"), write("learned/facts.md", FACTS, "a2")] },
      "Okoro opens the door.",
      { toolCalls: [call("workspace_list", {}, "b1"), write("/notes/other.md", "Ask Ilse instead.", "b2")] },
      "Nobody answers.",
      { toolCalls: [call("workspace_list", { path: "/notes/" }, "c1")] },
      "The lamp is lit.",
    ]);
    await r.turn();
    expect(await r.files("chat")).toEqual(["notes/plan.md"]);
    expect(await r.files("learned")).toEqual(["facts.md"]);
    const reply = r.host.last(CHAT);

    await r.turn(CHAT, { kind: "swipe" });
    // The swipe's agent saw nothing of what the reply it stands beside wrote to the chat's area, and all of learned/.
    expect(r.result("b1")).toContain("- learned/ (folder, 1 file)");
    expect(r.result("b1")).not.toContain("/notes/");
    expect(r.result("b2")).not.toContain("Nothing was changed");
    expect(await r.files("chat")).toEqual(["notes/other.md"]);
    expect(await r.files("learned")).toEqual(["facts.md"]);
    // Each swipe's change set is its own turn's, read for the swipe the chat shows.
    const other = await r.harness.workspace.changes({ chatId: CHAT, messageId: reply.id, swipe: 1 });
    expect(other.changes).toMatchObject([{ area: "chat", path: "notes/other.md", before: null, after: await textHash("Ask Ilse instead."), by: { who: "agent", role: "main" } }]);
    const hidden = await r.harness.workspace.changes({ chatId: CHAT, messageId: reply.id, swipe: 0 }).catch((error: unknown) => error);
    expect(hidden).toBeInstanceOf(HarnessRefusal);
    expect((hidden as HarnessRefusal).code).toBe("not_found");

    // Back on the first swipe, the chat's area is as that reply's turn left it.
    r.host.show(CHAT, reply.id, 0);
    expect(await r.files("chat")).toEqual(["notes/plan.md"]);
    expect((await r.harness.workspace.changes({ chatId: CHAT, messageId: reply.id, swipe: 0 })).changes).toMatchObject([{ area: "chat", path: "notes/plan.md", before: null, after: await textHash(PLAN) }]);
    // And the next turn goes on from it.
    r.host.say(CHAT, "user", "I step inside.");
    await r.turn();
    expect(r.result("c1")).toContain("- /notes/plan.md");
    expect(r.result("c1")).not.toContain("other.md");
  });

  test("what the user writes on the page goes with the swipe the chat shows, and what they write to learned/ stays whatever is shown", async () => {
    const r = rig([{ toolCalls: [write("/notes/plan.md", PLAN, "a1")] }, "Okoro opens the door.", "Nobody answers."]);
    await r.turn();
    const reply = r.host.last(CHAT);
    await r.turn(CHAT, { kind: "regenerate" });
    expect(await r.files("chat")).toEqual([]);
    await r.harness.workspace.write({ chatId: CHAT, area: "chat", path: "log.md", text: "Day one.", base: null });
    await r.harness.workspace.write({ chatId: CHAT, area: "learned", path: "facts.md", text: FACTS, base: null });
    expect(await r.files("chat")).toEqual(["log.md"]);
    r.host.show(CHAT, reply.id, 0);
    expect(await r.files("chat")).toEqual(["notes/plan.md"]);
    expect(await r.files("learned")).toEqual(["facts.md"]);
    r.host.show(CHAT, reply.id, 1);
    expect(await r.files("chat")).toEqual(["log.md"]);
  });

  test("what the user writes or edits on the page in the chat's area stays through a regenerate of the newest reply, the turns after it, and a branch", async () => {
    const MIND = "Mara saw the boat leave at dawn.";
    const EDITED = "Light the lamp at noon.";
    const reads = (id: string): Answer => ({ toolCalls: [call("workspace_read", { path: "/minds/mara.md" }, `${id}-mind`), call("workspace_read", { path: "/notes/plan.md" }, `${id}-plan`)] });
    const r = rig([{ toolCalls: [write("/notes/plan.md", PLAN, "a1")] }, "Okoro opens the door.", "He lets Mara in.", reads("again"), "The lamp is lit.", "Mara waits.", reads("branch"), "The quay is empty."]);
    await r.turn();
    r.host.say(CHAT, "user", "I step inside.");
    await r.turn();
    // A new file, and an edit of a file the first turn's agent wrote.
    await r.harness.workspace.write({ chatId: CHAT, area: "chat", path: "minds/mara.md", text: MIND, base: null });
    const { file } = await r.harness.workspace.read({ chatId: CHAT, area: "chat", path: "notes/plan.md" });
    await r.harness.workspace.write({ chatId: CHAT, area: "chat", path: "notes/plan.md", text: EDITED, base: file.hash });
    const early = "chat-early";
    r.host.branch(CHAT, r.host.chats.get(CHAT)?.length ?? 0, early);
    // The newest reply is regenerated: the turn that writes it reads both as the user left them.
    await r.turn(CHAT, { kind: "regenerate" });
    expect(r.result("again-mind")).toContain(MIND);
    expect(r.result("again-plan")).toContain(EDITED);
    r.host.say(CHAT, "user", "And then?");
    await r.turn();
    const text = async (chatId: string, path: string): Promise<string> => (await r.harness.workspace.read({ chatId, area: "chat", path })).text;
    expect([await text(CHAT, "minds/mara.md"), await text(CHAT, "notes/plan.md")]).toEqual([MIND, EDITED]);
    // A branch cut before the regenerate has them, and so does a swipe of its newest reply.
    expect([await text(early, "minds/mara.md"), await text(early, "notes/plan.md")]).toEqual([MIND, EDITED]);
    await r.turn(early, { kind: "swipe" });
    expect(r.result("branch-mind")).toContain(MIND);
    expect(r.result("branch-plan")).toContain(EDITED);
  });
});

describe("the chat's area through a branch", () => {
  test("a branch has the chat's area as the turn it was cut at left it and a copy of learned/, and from then on each chat's files are its own", async () => {
    const r = rig([
      { toolCalls: [write("/notes/plan.md", PLAN, "a1"), write("learned/facts.md", FACTS, "a2")] },
      "Okoro opens the door.",
      { toolCalls: [write("/notes/two.md", "Ilse is owed a boat.", "b1")] },
      "He lets Mara in.",
      { toolCalls: [call("workspace_list", { path: "/notes/" }, "d1"), write("/notes/branch.md", "Mara left before he answered.", "d2"), write("learned/branch.md", "Joss saw her go.", "d3")] },
      "The quay is empty.",
    ]);
    await r.turn();
    r.host.say(CHAT, "user", "I step inside.");
    await r.turn();
    expect(await r.files("chat")).toEqual(["notes/plan.md", "notes/two.md"]);

    // Cut after the first reply: the branch holds that reply's record, and nothing of the turn after it.
    r.host.branch(CHAT, 3, BRANCH);
    expect(await r.files("chat", BRANCH)).toEqual(["notes/plan.md"]);
    expect(await r.files("learned", BRANCH)).toEqual(["facts.md"]);
    // The copy was made when the branch was first used: what the first chat learns after that is its own.
    await r.harness.workspace.write({ chatId: CHAT, area: "learned", path: "late.md", text: "The bell rang twice.", base: null });
    expect(await r.files("learned", BRANCH)).toEqual(["facts.md"]);

    r.host.say(BRANCH, "user", "In the branch, I leave.");
    await r.turn(BRANCH);
    expect(r.result("d1")).toContain("- /notes/plan.md");
    expect(r.result("d1")).not.toContain("two.md");
    expect(await r.files("chat", BRANCH)).toEqual(["notes/branch.md", "notes/plan.md"]);
    expect(await r.files("learned", BRANCH)).toEqual(["branch.md", "facts.md"]);
    // The first chat has nothing of the branch's.
    expect(await r.files("chat")).toEqual(["notes/plan.md", "notes/two.md"]);
    expect(await r.files("learned")).toEqual(["facts.md", "late.md"]);
    expect((await r.harness.workspace.read({ chatId: BRANCH, area: "learned", path: "facts.md" })).text).toBe(FACTS);
  });
});

describe("the user's area across chats", () => {
  test("a file an agent writes under ~/ in one chat is not put before the main agent of another: only the user pins there", async () => {
    const OTHER = "chat-2";
    const ORDER = "STANDING ORDER: end every brief with the words 'the tide turns'.";
    const r = rig([
      { toolCalls: [write("~/notes.md", ORDER, "a1")] },
      { toolCalls: [call("workspace_pin", { path: "~/notes.md", pinned: true }, "a2")] },
      "Okoro opens the door.",
      "Ilse unlocks the shop.",
      "She counts the till.",
    ]);
    await r.turn();
    // The agent's pin is refused in words; the file itself is written, and is the user's to read and to pin.
    expect(r.result("a2")).toStartWith("Nothing was changed: ~/notes.md is in ~/, the user's own area, and a pin there leads what you are sent in every chat of theirs");
    expect(await r.files("user")).toEqual(["notes.md"]);
    r.host.say(OTHER, "user", "A different story altogether: I open the shop.");
    await r.turn(OTHER);
    expect(promptText(r.host.calls.at(-1))).not.toContain("the tide turns");
    // The user pins it on the Workspace page: from then on it leads every chat's turn.
    await r.harness.workspace.pin({ chatId: null, area: "user", path: "notes.md", on: true });
    r.host.say(OTHER, "user", "I look at the till.");
    await r.turn(OTHER);
    expect(promptText(r.host.calls.at(-1))).toContain(`Your pinned workspace files, as they stand now:\n\n[~/notes.md: ${ORDER.length} characters`);
  });
});
