// A link request names its chat itself, and any account can register a runtime and send one. So
// the chat is checked against the caller's own before a tool or a member of the extension LumiAH is
// built into hears of it (DESIGN §6, §21): another account's chat is refused in the words a chat
// that doesn't exist is, and nothing runs.

import { afterEach, describe, expect, test } from "bun:test";
import type { BackendExtension, BackendTools } from "../../../src/extension/backend/extension";
import { type Rig, rig, until, USER } from "../../support/rig";

const USAGE = { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0 };
const noTurns = () => ({ answer: async () => ({ status: "failed" as const, reason: "no turn is answered in this test", record: null, reply: "", usage: USAGE }) });

/** An extension with LumiAH built in that keeps what it was handed: every tool listing and call, and every member's chat. */
function lantern() {
  const listed: { chatId: string; userId: string }[] = [];
  const ran: { chatId: string; userId: string }[] = [];
  const heard: string[] = [];
  const tools: BackendTools = {
    list: async (chatId, userId) => {
      listed.push({ chatId, userId });
      return [{ name: "last_line", family: "lamp", tier: "read", description: "Reads the chat's last line.", parameters: { type: "object", properties: {} }, source: "extension" }];
    },
    call: async (call, _signal, userId) => {
      ran.push({ chatId: call.chatId, userId });
      return { text: "done" };
    },
  };
  const extension: BackendExtension = {
    name: "Lantern",
    definitions: async (userId, chatId) => {
      heard.push(`definitions ${chatId} for ${userId}`);
      return {};
    },
    claim: async (ask, userId) => {
      heard.push(`claim ${ask.chat.id} "${ask.chat.name}" for ${userId}`);
      return null;
    },
    writerRequest: async (request, userId) => {
      heard.push(`writerRequest ${request.chatId} for ${userId}`);
      return null;
    },
    runBegan: async (run, userId) => {
      heard.push(`runBegan ${run.chatId} for ${userId}`);
    },
    replyWritten: async (reply, userId) => {
      heard.push(`replyWritten ${reply.chatId} for ${userId}`);
    },
    runEnded: async (run, userId) => {
      heard.push(`runEnded ${run.chatId} for ${userId}`);
    },
  };
  return { listed, ran, heard, tools, extension };
}

let r: Rig | null = null;
afterEach(() => {
  r?.close();
  r = null;
});

/** A rig with the extension mounted, a chat of Mara's and a chat of Ilse's, and Mara's runtime registration to send frames with. */
async function mounted() {
  const made = lantern();
  const it = (r = await rig({ harness: noTurns, backend: { identity: { identifier: "lantern_ext", name: "Lantern" }, tools: made.tools, extension: made.extension } }));
  const mine = it.host.addChat(USER, "Harbour light");
  const hers = it.host.addChat("user-ilse", "Ilse's ledger");
  /** One link request from Mara's own registration, as any client holding her secret can send it. */
  const ask = (type: string, fields: Record<string, unknown>) => it.lumiverse.raw({ type, secret: it.registration.secret, ...fields });
  return { it, mine, hers, ask, ...made };
}

const NOT_HERS = { type: "error" as const, code: "not_found", message: "There is no such chat in this account." };
const call = (chatId: string) => ({ name: "last_line", args: {}, turn: "turn-1", chatId, agentId: "main-1", role: "main", callId: "call-1", kind: "new", main: true, above: [] });

describe("a link request that names a chat", () => {
  test("runs no tool of the extension for a chat that isn't the calling account's, and runs it for one that is", async () => {
    const { it, mine, hers, ask, ran } = await mounted();
    const streams = it.backend.streams.size;

    expect(await ask("tool.call", { stream: "a".repeat(32), call: call(hers.id) })).toEqual(NOT_HERS);
    // A chat nobody has is refused in the same words: the answer doesn't say whether the chat exists.
    expect(await ask("tool.call", { stream: "b".repeat(32), call: call("chat-nowhere") })).toEqual(NOT_HERS);
    // The call would run behind the frame's answer: it is given the time one takes.
    await until(() => ran.length > 0, "the tool's run", 50).catch(() => undefined);
    expect(ran).toEqual([]);
    // Nothing is left held for an answer that will never be written.
    expect(it.backend.streams.size).toBe(streams);

    expect(await ask("tool.call", { stream: "c".repeat(32), call: call(mine.id) })).toMatchObject({ type: "result", body: { accepted: true } });
    await until(() => ran.length > 0, "the tool's run");
    expect(ran).toEqual([{ chatId: mine.id, userId: USER }]);
  });

  test("lists no tools of the extension for a chat that isn't the calling account's", async () => {
    const { mine, hers, ask, listed } = await mounted();

    expect(await ask("tools.list", { chat: hers.id })).toEqual(NOT_HERS);
    expect(listed).toEqual([]);

    expect(await ask("tools.list", { chat: mine.id })).toMatchObject({ type: "result", body: { tools: [{ name: "last_line", source: "extension" }] } });
    // A run about no chat lists them too.
    expect(await ask("tools.list", { chat: "" })).toMatchObject({ type: "result", body: { tools: [{ name: "last_line" }] } });
    expect(listed).toEqual([
      { chatId: mine.id, userId: USER },
      { chatId: "", userId: USER },
    ]);
  });

  test("holds no call for the user's word in a chat that isn't the calling account's", async () => {
    const { it, hers, ask } = await mounted();
    const streams = it.backend.streams.size;
    const held = { turn: "turn-1", chatId: hers.id, agentId: "main-1", role: "main", callId: "call-1", tool: "last_line", tier: "read", args: {}, at: 1, until: null };

    expect(await ask("approval.ask", { stream: "a".repeat(32), ask: held })).toEqual(NOT_HERS);
    expect(it.backend.streams.size).toBe(streams);
    expect(it.backend.approvals.waitingRuns(USER).size).toBe(0);
    expect(it.backend.approvals.waitingRuns("user-ilse").size).toBe(0);
  });

  test("hands no member of the extension a chat that isn't the calling account's", async () => {
    const { hers, ask, heard } = await mounted();
    const theirs = { id: hers.id, name: "Ilse's ledger", characterId: null, characterName: null, branchedFrom: null };
    const run = { userId: USER, chatId: hers.id, turn: "turn-1", generationId: "gen-1", kind: "new" };

    expect(await ask("extension.call", { member: "definitions", arg: { userId: USER, chatId: hers.id } })).toEqual(NOT_HERS);
    expect(await ask("extension.call", { member: "claim", arg: { userId: USER, chatId: hers.id, chat: theirs } })).toEqual(NOT_HERS);
    // As a runtime of an earlier build asked it: the chat alone.
    expect(await ask("extension.call", { member: "claim", arg: theirs })).toEqual(NOT_HERS);
    for (const member of ["writerRequest", "runBegan", "replyWritten", "runEnded"]) expect(await ask("extension.call", { member, arg: run })).toEqual(NOT_HERS);
    expect(heard).toEqual([]);
  });

  test("hands the members the calling account's own chat, and `claim` the chat as Lumiverse has it, whatever the request said of it", async () => {
    const { mine, ask, heard } = await mounted();
    const run = { userId: "user-ilse", chatId: mine.id, turn: "turn-1", generationId: "gen-1", kind: "new" };

    expect(await ask("extension.call", { member: "definitions", arg: { userId: USER, chatId: mine.id } })).toMatchObject({ type: "result", body: { supplied: true } });
    // The request describes Mara's chat as another: the member is handed what Lumiverse says of it.
    expect(await ask("extension.call", { member: "claim", arg: { userId: USER, chatId: mine.id, chat: { id: mine.id, name: "Ilse's ledger", characterId: "char-brann", characterName: "Brann", branchedFrom: null } } })).toMatchObject({ type: "result", body: { supplied: true } });
    expect(await ask("extension.call", { member: "runBegan", arg: run })).toMatchObject({ type: "result", body: { supplied: true } });
    // A run about no chat (a side session's) names none, and is told of as it is.
    expect(await ask("extension.call", { member: "runEnded", arg: { ...run, chatId: "" } })).toMatchObject({ type: "result", body: { supplied: true } });

    expect(heard).toEqual([`definitions ${mine.id} for ${USER}`, `claim ${mine.id} "Harbour light" for ${USER}`, `runBegan ${mine.id} for ${USER}`, `runEnded  for ${USER}`]);
  });
});
