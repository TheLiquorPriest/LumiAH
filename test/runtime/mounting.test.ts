// An extension that builds LumiAH into itself (DESIGN §21), end to end: its backend is LumiAH's
// backend put together with what the extension supplies, the runtime is LumiAH's own and links to it
// by its identifier, and the core's own harness answers. What a test here checks is what the
// extension's author and its user would notice: a chat it claims is answered by its main agent, its
// tool runs in its backend for the user, its definitions and its guidance level are in the run, the
// writer is sent what it rewrote, its hooks hear the turn, and the turn's record sits where its
// anchor puts it. A chat it doesn't claim is LumiAH's as ever.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../../src/core/agents";
import type { ReplyWritten, RunBegan, RunEnded, WriterRequest } from "../../src/core/extension";
import type { JsonObject, JsonValue } from "../../src/core/ports";
import { defaultSettings } from "../../src/core/settings";
import type { BackendOptions } from "../../src/extension/backend/backend";
import { isRecord } from "../../src/link/json";
import { bare, cast, heard, offers, told } from "../support/cast";
import { toolCall } from "../support/fake-host";
import { callsOf, live, startedAs, stepsOf } from "../support/live";
import { type Rig, rig, until, USER } from "../support/rig";

let r: Rig | null = null;
afterEach(() => {
  r?.close();
  r = null;
});

const KEEPER = "You are the lamp room's keeper. Read the lamp log for the day before you brief the writer.";
const HOUSE_RULES = "The lamp is lit at dusk and never before. Nobody but its keeper touches the wick.";
const LOG = "Okoro lit the lamp at dusk. Ilse signed the log after him.";

/** What the sample extension heard and did, for a test to read. */
interface Heard {
  /** Its hooks, in the order they were called, each with the user it was called for. */
  hooks: ({ hook: "began"; run: RunBegan; userId: string } | { hook: "written"; reply: ReplyWritten; userId: string } | { hook: "ended"; run: RunEnded; userId: string })[];
  /** Every call of its tool, as its backend ran it. */
  ran: { name: string; args: JsonObject; chatId: string; role: string; userId: string }[];
  /** Every writer's request it was handed to rewrite. */
  rewrote: WriterRequest[];
}

/**
 * A sample extension that supplies one of each thing §21 names: a main agent for the chats it
 * claims (those named "Harbour light"), a tool that runs in its backend, a skill, a guidance level,
 * the writer's request rewritten, the three hooks, and an anchor of its own: it keeps a record of
 * its own on each reply (`lamp`), with LumiAH's record for each swipe under `turns`.
 */
function lampRoom(): { options: BackendOptions; heard: Heard } {
  const heard: Heard = { hooks: [], ran: [], rewrote: [] };
  const keeper: AgentDefinition = {
    ...(defaultSettings().agents.main as AgentDefinition),
    id: "lamp_keeper",
    name: "Lamp keeper",
    description: "Answers the chats the lamp room keeps.",
    instructions: KEEPER,
    given: "request",
    tools: ["lamp_log", "chat_read", "skill_load", "write_reply"],
  };
  const turnsOf = (own: JsonValue | null): JsonObject => (isRecord(own) && isRecord(own.turns) ? (own.turns as JsonObject) : {});
  return {
    heard,
    options: {
      identity: { identifier: "lamp_room", name: "Lamp Room", connectionName: "Lamp Room loopback" },
      extension: {
        name: "Lamp Room",
        definitions: async () => ({ agents: [keeper], skills: [{ id: "trim_wick", name: "Trimming the wick", description: "How the lamp's wick is trimmed.", body: "Trim it at dusk, a finger's width, with the lamp cold." }] }),
        claim: async (chat) => (chat.name === "Harbour light" ? { mainAgent: "lamp_keeper", guidance: { name: "of the lamp room", text: HOUSE_RULES } } : null),
        // What it prepared goes where the preset's own messages end, before the chat's.
        writerRequest: async (request) => {
          heard.rewrote.push(request);
          return [{ role: "system", content: `[The lamp log] ${LOG}` }, ...request.messages];
        },
        runBegan: async (run, userId) => void heard.hooks.push({ hook: "began", run, userId }),
        replyWritten: async (reply, userId) => void heard.hooks.push({ hook: "written", reply, userId }),
        runEnded: async (run, userId) => void heard.hooks.push({ hook: "ended", run, userId }),
      },
      tools: {
        list: async () => [{ name: "lamp_log", family: "lamp", tier: "read", description: "The lamp room's log for a day.", parameters: { type: "object", properties: { day: { type: "string" } }, required: ["day"] }, source: "extension" }],
        call: async (call, _signal, userId) => {
          heard.ran.push({ name: call.name, args: call.args, chatId: call.chatId, role: call.role, userId });
          return { text: LOG };
        },
      },
      anchor: {
        read: (own, swipe) => (turnsOf(own)[String(swipe)] as JsonValue | undefined) ?? null,
        write: (own, swipe, record) => ({ lamp: "lit", ...(isRecord(own) ? (own as JsonObject) : {}), turns: { ...turnsOf(own), [String(swipe)]: record } }),
        // The lamp room keeps what it wrote of a swipe that is gone: nothing moves.
        swipeDeleted: () => null,
      },
    },
  };
}

describe("an extension that has LumiAH built in", () => {
  test("answers a chat it claims with its own main agent: its tool runs in its backend, its guidance and its skill are in the run, the writer is sent what it rewrote, its hooks hear the turn, and the record sits where its anchor puts it", async () => {
    const sample = lampRoom();
    const it = (r = await rig({ backend: sample.options }));
    const chatId = await it.setUp();
    const play = cast(
      {
        name: "keeper",
        is: told(KEEPER),
        lines: [{ toolCalls: [toolCall("lamp_log", { day: "today" }, "log_1")] }, { toolCalls: [toolCall("write_reply", { brief: "Okoro lit it at dusk; Ilse signed after him." }, "reply_1")] }],
      },
      { name: "writer", is: bare, lines: ["Okoro lit it at dusk, as he always does."] },
    );
    it.host.script = play.script;

    const out = await it.generate(chatId);
    expect(out.error).toBeNull();
    expect(out.content).toBe("Okoro lit it at dusk, as he always does.");

    // Its main agent answered, not LumiAH's: its instructions lead, under its own level of guidance, with its skill to load and its tool to call.
    const [first, second] = play.calls("keeper");
    expect(first?.messages[0]?.role).toBe("system");
    expect(first?.messages[0]?.content).toContain(KEEPER);
    expect(heard(first)).toContain(`[Guidance of the lamp room. Follow it.]\n${HOUSE_RULES}`);
    expect(heard(first)).toContain("- trim_wick: Trimming the wick. How the lamp's wick is trimmed.");
    expect(first?.tools?.map((t) => t.name).sort()).toEqual(["chat_read", "lamp_log", "scratch_read", "skill_load", "write_reply"]);
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");
    const { events } = await live(it, chatId);
    expect(startedAs(events, "main")).toEqual([]);
    const [keeper] = startedAs(events, "lamp_keeper");
    expect(keeper?.system).toContain(KEEPER);

    // Its tool ran in its backend, for the user the runtime serves, and the agent read what it answered.
    expect(sample.heard.ran).toEqual([{ name: "lamp_log", args: { day: "today" }, chatId, role: "lamp_keeper", userId: USER }]);
    expect(callsOf(stepsOf(events, keeper?.id))).toMatchObject([
      { name: "lamp_log", text: LOG, error: false },
      { name: "write_reply", error: false },
    ]);
    expect(heard(second)).toContain(LOG);

    // The writer was sent the request as the extension rewrote it: what it prepared first, then Lumiverse's own messages with the brief.
    expect(sample.heard.rewrote).toMatchObject([{ chatId, generationId: out.generationId, kind: "new", brief: "Okoro lit it at dusk; Ilse signed after him." }]);
    const [writer] = play.calls("writer");
    expect(writer?.messages[0]).toMatchObject({ role: "system", content: `[The lamp log] ${LOG}` });
    expect(writer?.messages.slice(1).map((m) => m.content)).toEqual(sample.heard.rewrote[0]?.messages.map((m) => m.content) ?? []);
    expect(heard(writer)).toContain("Who keeps the harbour light now?");
    expect(heard(writer)).toContain("Okoro lit it at dusk; Ilse signed after him.");

    // Its hooks heard the turn begin, the reply written and the turn end, in that order, each for the user.
    await until(() => sample.heard.hooks.length === 3, "the extension's three hooks");
    expect(sample.heard.hooks.map((h) => [h.hook, h.userId])).toEqual([
      ["began", USER],
      ["written", USER],
      ["ended", USER],
    ]);
    const [began, written, ended] = sample.heard.hooks;
    expect(began).toMatchObject({ run: { chatId, turn: out.generationId, kind: "new" } });
    expect(written).toMatchObject({ reply: { chatId, turn: out.generationId, reply: "Okoro lit it at dusk, as he always does.", finish: "stop" } });
    expect(ended).toMatchObject({ run: { chatId, turn: out.generationId, kind: "new", status: "done", reply: "Okoro lit it at dusk, as he always does.", record: { generationId: out.generationId, kind: "new" } } });

    // The turn's record is in the extension's own record of the reply, where its anchor says, and nowhere else on the message.
    const reply = it.host.message(chatId, out.messageId ?? "");
    await until(() => reply.metadata.lamp_room !== undefined, "the record on the reply");
    expect(reply.metadata).toEqual({ lamp_room: { lamp: "lit", turns: { "0": expect.objectContaining({ v: 1, generationId: out.generationId, kind: "new" }) } } });

    // The next reply resumes the session from that record: the keeper carries what it did.
    it.host.say(chatId, "user", "And who signed the log?");
    it.host.script = cast({ name: "keeper", is: told(KEEPER), lines: [{ toolCalls: [toolCall("write_reply", { brief: "Ilse signed it." }, "reply_2")] }] }, { name: "writer", is: bare, lines: ["Ilse did."] }).script;
    const calls = it.host.calls.length;
    const next = await it.generate(chatId);
    expect(next.content).toBe("Ilse did.");
    const again = it.host.calls[calls];
    expect(again?.kind === "call" ? heard(again.request) : "").toContain("Okoro lit it at dusk; Ilse signed after him.");
  });

  test("lists its definitions on the pages as its own, and leaves a chat it doesn't claim to LumiAH's main agent", async () => {
    const sample = lampRoom();
    const it = (r = await rig({ backend: sample.options }));
    await it.setUp();

    // The Agents, Skills and Tools pages show what it supplies, each marked as the extension's.
    const defs = await it.page.request("lah.defs.get", {});
    expect(defs.agents.find((a) => a.id === "lamp_keeper")).toMatchObject({ name: "Lamp keeper", source: "extension", off: false, instructions: KEEPER });
    expect(defs.skills.find((s) => s.id === "trim_wick")).toMatchObject({ name: "Trimming the wick", source: "extension", off: false });
    expect(defs.tools.find((t) => t.name === "lamp_log")).toMatchObject({ family: "lamp", tier: "read", runs: "extension", source: "extension", off: false });

    // A chat by another name isn't the lamp room's: LumiAH's own main agent answers it, without the lamp room's guidance, and the writer's request still goes by the extension.
    const other = it.host.addChat(USER, "The fish market");
    it.host.say(other.id, "user", "What does Brann sell on market day?");
    await it.page.request("lah.chat.set", { chatId: other.id, on: true, place: "runtime" });
    const play = cast({ name: "main", is: offers("write_reply"), lines: [{ toolCalls: [toolCall("write_reply", { brief: "Brann sells lamp oil." }, "reply_1")] }] }, { name: "writer", is: bare, lines: ["Lamp oil, mostly."] });
    it.host.script = play.script;
    const out = await it.generate(other.id);
    expect(out.error).toBeNull();
    expect(out.content).toBe("Lamp oil, mostly.");
    const [main] = play.calls("main");
    expect(heard(main)).not.toContain(KEEPER);
    expect(heard(main)).not.toContain(HOUSE_RULES);
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");
    const { events } = await live(it, other.id);
    expect(startedAs(events, "main")).toHaveLength(1);
    expect(startedAs(events, "lamp_keeper")).toEqual([]);
  });
});
