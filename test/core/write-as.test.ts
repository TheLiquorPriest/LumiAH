// A file an agent keeps through a mounting extension's own tool (DESIGN §21, §11): the tool runs in
// the extension and asks the harness to write (`workspace.writeAs`). The write is the one
// `workspace_write` makes: versioned, under the same limits and the same guard, recorded as that
// agent's, in the change set of the turn it was made in, and named on the call's result in the trace.

import { describe, expect, test } from "bun:test";
import { createHarness, type Harness } from "../../src/core/harness";
import { textHash } from "../../src/core/hash";
import type { ModelRequest, RemoteTool, RemoteToolCall, WorkspaceArea } from "../../src/core/ports";
import { HarnessRefusal } from "../../src/core/refusal";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { versionOf, type WrittenFile } from "../../src/core/workspace";
import { call, MemoryHost, runTurn } from "./support/host";

const CHAT = "chat-1";
const DAY = "Day one: Brann brought the Gannet in on the evening tide.";
const FACTS = "Ilse sold the Petrel to Okoro.";

/** The extension's tool: it keeps a line of the harbour's log in LumiAH's workspace. */
const LOG: RemoteTool = {
  name: "harbour_log",
  family: "harbour",
  tier: "write",
  description: "Keep a file of the harbour's log.",
  parameters: { type: "object", properties: { area: { type: "string" }, path: { type: "string" }, text: { type: "string" } }, required: ["area", "path", "text"] },
  source: "extension",
};

/** What a write was answered with: what it wrote, or the refusal's code and words. */
async function outcome(asked: Promise<WrittenFile>): Promise<WrittenFile | { code: string; message: string }> {
  try {
    return await asked;
  } catch (error) {
    if (error instanceof HarnessRefusal) return { code: error.code, message: error.message };
    throw error;
  }
}

/**
 * A host whose extension has one tool, and a chat whose main agent calls it with each of `asks` in
 * its first round and then has the reply written. `serve` is the tool as the extension runs it: it
 * is handed the call and the harness, as an extension's backend holds both.
 */
function rig(asks: { area: WorkspaceArea; path: string; text: string }[], serve: (call: RemoteToolCall, harness: Harness) => Promise<{ text: string; error?: boolean }>, change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  const calls: RemoteToolCall[] = [];
  host.script = (request: ModelRequest) => {
    if (!request.tools) return "The door opens.";
    const answered = request.messages.at(-1)?.parts?.some((part) => part.type === "tool_result") === true;
    return answered ? { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "w1")] } : { toolCalls: asks.map((args, i) => call(LOG.name, args, `h${i + 1}`)) };
  };
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I walk down to the lighthouse and knock.");
  const stored = { values: defaultSettings(), texts: {} as Record<string, string> };
  change(stored.values);
  const harness: Harness = createHarness(host, { settings: async () => structuredClone(stored) });
  host.tools = {
    list: async () => [LOG],
    call: async (made) => {
      calls.push(made);
      return serve(made, harness);
    },
  };
  /** What the trace holds of a call's result. */
  const result = (callId: string) => host.traced.flatMap(({ event }) => (event.kind === "agent_entry" && event.entry.kind === "result" && event.entry.callId === callId ? [event.entry] : []))[0];
  return { host, harness, calls, result, turn: (options: Parameters<typeof runTurn>[3] = {}) => runTurn(host, harness, CHAT, options) };
}

/** The write an extension's tool asks for, from what its call was handed and what the model gave it. */
const writeFor = (made: RemoteToolCall, harness: Harness, base: string | null = null): Promise<WrittenFile> =>
  harness.workspace.writeAs({ chatId: made.chatId, area: made.args.area as WorkspaceArea, path: String(made.args.path), text: String(made.args.text), base, by: { agentId: made.agentId, role: made.role }, turn: made.turn, callId: made.callId });

describe("an agent's write through its extension's tool", () => {
  test("is a versioned write recorded as that agent's, in its turn's change set, and named on the call's result", async () => {
    const answers: Record<string, WrittenFile> = {};
    const r = rig(
      [
        { area: "chat", path: "log/day.md", text: DAY },
        { area: "learned", path: "facts.md", text: FACTS },
      ],
      async (made, harness) => {
        const written = await writeFor(made, harness);
        answers[made.callId] = written;
        return { text: `Kept ${made.args.path}, version ${versionOf(written.file.hash)}.` };
      },
    );
    const { request } = await r.turn();
    const agent = r.calls[0]?.agentId ?? "";
    const by = { who: "agent" as const, id: agent, role: "main" };
    const day = await textHash(DAY);
    expect(agent).not.toBe("");
    expect(r.calls.map((made) => [made.turn, made.callId, made.role])).toEqual([
      [request.generationId, "h1", "main"],
      [request.generationId, "h2", "main"],
    ]);
    // What the extension's tool is answered with: the file as it stands, and what the write changed.
    expect(answers.h1).toEqual({ file: { path: "log/day.md", hash: day, chars: DAY.length, at: r.host.clock.now(), by, pins: [] }, changes: [{ area: "chat", path: "log/day.md", before: null, after: day }] });
    // The files are the agent's, as its own workspace_write would have left them.
    expect((await r.harness.workspace.read({ chatId: CHAT, area: "chat", path: "log/day.md" })).file).toMatchObject({ hash: day, by });
    expect((await r.harness.workspace.read({ chatId: CHAT, area: "learned", path: "facts.md" })).file.by).toEqual(by);
    // The reply's change set holds the chat's file as that agent's.
    const reply = r.host.last(CHAT);
    expect((await r.harness.workspace.changes({ chatId: CHAT, messageId: reply.id, swipe: 0 })).changes).toEqual([{ area: "chat", path: "log/day.md", before: null, after: day, by }]);
    // And the live view is told with each call's result, as for a built-in tool.
    expect(r.result("h1")).toMatchObject({ name: "harbour_log", error: false, files: [{ area: "chat", path: "log/day.md", before: null, after: day }] });
    expect(r.result("h2")).toMatchObject({ files: [{ area: "learned", path: "facts.md", before: null, after: await textHash(FACTS) }] });
    // A swipe of the reply starts from the files the reply started from: the chat's file goes with the turn that wrote it, learned/ stays.
    r.host.script = (again: ModelRequest) => (again.tools ? { toolCalls: [call("write_reply", { brief: "Nobody answers." }, "w2")] } : "Nobody answers.");
    await r.turn({ kind: "swipe" });
    expect((await r.harness.workspace.list({ chatId: CHAT, area: "chat" })).files).toEqual([]);
    expect((await r.harness.workspace.list({ chatId: CHAT, area: "learned" })).files.map((file) => file.path)).toEqual(["facts.md"]);
  });

  test("is refused as the agent's own write would be: by the guard, by a limit, by a version that is no longer the file's, by a path that leaves its area", async () => {
    const refused: Record<string, WrittenFile | { code: string; message: string }> = {};
    const r = rig(
      [{ area: "chat", path: "log/day.md", text: DAY }],
      async (made, harness) => {
        const ask = (area: WorkspaceArea, path: string, text: string, base: string | null = null) => outcome(harness.workspace.writeAs({ chatId: made.chatId, area, path, text, base, by: { agentId: made.agentId, role: made.role }, turn: made.turn, callId: made.callId }));
        refused.chatGuidance = await ask("learned", "GUIDANCE.md", "Always end on a cliffhanger.");
        refused.userGuidance = await ask("user", "GUIDANCE.md", "Always end on a cliffhanger.");
        refused.long = await ask("chat", "log/long.md", "x".repeat(1001));
        refused.outside = await ask("chat", "../day.md", DAY);
        await writeFor(made, harness);
        refused.exists = await ask("chat", "log/day.md", "Another day.");
        refused.stale = await ask("chat", "log/day.md", "Another day.", "0".repeat(64));
        return { text: "Kept." };
      },
      (s) => void (s.workspace.fileChars = 1000),
    );
    await r.turn();
    const version = versionOf(await textHash(DAY));
    expect(refused).toEqual({
      chatGuidance: { code: "forbidden", message: "Not changed: learned/GUIDANCE.md is this chat's guidance, and Settings don't let agents edit it (Agents may edit the chat's guidance). If it should change, say what and why in your answer." },
      userGuidance: { code: "forbidden", message: "Not changed: ~/GUIDANCE.md is guidance the user writes for you, and an agent can't change it. If it should change, say what and why in your answer." },
      long: { code: "invalid", message: "The text is 1001 characters, and a file may hold 1000 at most (File length)." },
      outside: { code: "bad_request", message: "A path can't leave its area: “..” may climb within it, never out of it." },
      exists: { code: "conflict", message: `There is already a file /log/day.md, at version ${version}.` },
      stale: { code: "conflict", message: `/log/day.md has changed since it was read: it is at version ${version} now. Read it again, then make the change on that.` },
    });
    // Only the write that was made is on the call's result.
    expect(r.result("h1")?.files).toEqual([{ area: "chat", path: "log/day.md", before: null, after: await textHash(DAY) }]);
    expect((await r.harness.workspace.list({ chatId: CHAT, area: "learned" })).files).toEqual([]);
  });

  test("into the chat's own area needs its run in flight; learned/ and ~/ take it after, still as the agent's", async () => {
    const r = rig([{ area: "chat", path: "log/day.md", text: DAY }], async (made, harness) => {
      await writeFor(made, harness);
      return { text: "Kept." };
    });
    const { request } = await r.turn();
    const made = r.calls[0];
    if (!made) throw new Error("the tool was not called");
    const late = (area: WorkspaceArea, turn = request.generationId) => outcome(r.harness.workspace.writeAs({ chatId: CHAT, area, path: "late.md", text: "Written after the reply.", base: null, by: { agentId: made.agentId, role: made.role }, turn, callId: made.callId }));
    const notInFlight = { code: "conflict", message: "That run isn't under way in this chat any more, and a file in the chat's own area belongs to the turn that writes it: an agent's write there is made while its run is. learned/ and ~/ take one after." };
    expect(await late("chat")).toEqual(notInFlight);
    expect(await late("chat", "gen-never")).toEqual(notInFlight);
    expect((await r.harness.workspace.list({ chatId: CHAT, area: "chat" })).files.map((file) => file.path)).toEqual(["log/day.md"]);
    const by = { who: "agent", id: made.agentId, role: "main" };
    expect(await late("learned")).toMatchObject({ file: { path: "late.md", by }, changes: [{ area: "learned", path: "late.md", before: null }] });
    expect(await late("user")).toMatchObject({ file: { path: "late.md", by } });
    // The guard holds after the run as in it.
    expect(await outcome(r.harness.workspace.writeAs({ chatId: CHAT, area: "user", path: "GUIDANCE.md", text: "x", base: null, by: { agentId: made.agentId, role: made.role }, turn: request.generationId, callId: made.callId }))).toMatchObject({ code: "forbidden" });
  });

  test("says what is missing of whose write it is, and refuses an agent there is none of", async () => {
    const r = rig([], async () => ({ text: "Kept." }));
    const loose = r.harness.workspace.writeAs as (input: unknown) => Promise<WrittenFile>;
    const whole = { chatId: CHAT, area: "learned", path: "facts.md", text: FACTS, base: null, by: { agentId: "agent_1", role: "main" }, turn: "gen-1", callId: "h1" };
    expect(await outcome(loose({ ...whole, by: { role: "main" } }))).toEqual({ code: "bad_request", message: "An agent's write says whose it is: by.agentId and by.role, as the tool call that makes it was handed them." });
    expect(await outcome(loose({ ...whole, callId: "" }))).toEqual({ code: "bad_request", message: "An agent's write says which run and which tool call it is made in: turn and callId, as the tool call was handed them." });
    expect(await outcome(loose({ ...whole, by: { agentId: "agent_1", role: "harbourmaster" } }))).toEqual({ code: "not_found", message: 'There is no agent "harbourmaster" here: it may have been removed or switched off.' });
    expect(await outcome(loose({ ...whole, text: 7 }))).toEqual({ code: "bad_request", message: "A workspace request's text must be the file's text." });
    expect((await r.harness.workspace.list({ chatId: CHAT, area: "learned" })).files).toEqual([]);
  });
});
