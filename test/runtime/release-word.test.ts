// The extension's word on a turn's reply as it crosses the link (DESIGN §21, §25): the backend sends
// what the extension's `releasing` said, and the runtime hands the core what the backend sent. A
// refusal, and a text that goes out in place of what the call carried, arrive as they were given;
// anything else arrives as no word. The call's arguments go with the ask. What the agents had ready
// (`unreleased`) crosses the same way. And the core is offered only the members the extension
// offers, so it goes on over the link as it does beside an extension in the same process.

import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../../src/core/agents";
import type { ReplyRelease, ReplyUnreleased } from "../../src/core/extension";
import { createHarness } from "../../src/core/harness";
import { defaultSettings, newAgentSettings } from "../../src/core/settings";
import { type BackendExtension, callExtension, offerOf } from "../../src/extension/backend/extension";
import type { ExtensionMember } from "../../src/link/contract";
import { RUNTIME_DEFAULTS } from "../../src/link/settings";
import { linkExtension } from "../../src/runtime/host";
import type { RuntimeLink } from "../../src/runtime/link";
import { call, MemoryHost, runTurn } from "../core/support/host";

const USER = "user-1";
const RELEASE: ReplyRelease = { userId: USER, chatId: "chat-1", turn: "gen-1", agent: { agentId: "agent_1a2b3c4d", role: "author" }, text: "", args: { pieces: [1, 2] } };
/** Every chat the test asks about is the caller's own. */
const chats = { own: async () => ({}), claimAsk: async () => null } as unknown as Parameters<typeof callExtension>[4];

/** What the backend sends for an extension whose `releasing` answers `verdict`, and what that member was handed. */
async function sent(verdict: unknown) {
  const handed: ReplyRelease[] = [];
  const extension: BackendExtension = { name: "Harbour Play", releasing: async (release) => (handed.push(release), verdict as never) };
  return { answer: await callExtension(extension, "releasing", RELEASE, USER, chats), handed };
}

/** What the runtime's core is given for a backend that answers `releasing` with `value`, and what the link was asked. */
async function taken(value: unknown) {
  const asked: unknown[] = [];
  const link = { request: async (_type: string, fields: unknown) => (asked.push(fields), { supplied: true, value }) } as unknown as RuntimeLink;
  const extension = linkExtension({ link, now: () => 0, tuning: () => RUNTIME_DEFAULTS, offer: () => ({ name: "Harbour Play", members: ["releasing"] }) });
  return { verdict: await extension.releasing?.(RELEASE), asked };
}

describe("the extension's word on the reply, across the link", () => {
  test("the backend sends a text that goes out and a refusal as the extension gave them, and anything else as none; the member is handed the call's arguments", async () => {
    const text = await sent({ text: "The lamp room is cold." });
    expect(text.answer).toEqual({ supplied: true, value: { text: "The lamp room is cold." } });
    expect(text.handed).toEqual([RELEASE]);
    expect((await sent({ refused: "Not that piece." })).answer).toEqual({ supplied: true, value: { refused: "Not that piece." } });
    expect((await sent({ text: 7 })).answer).toEqual({ supplied: true, value: null });
  });

  test("the runtime gives the core a text that goes out and a refusal as the backend sent them, and anything else as none; the ask carries the call's arguments", async () => {
    const text = await taken({ text: "The lamp room is cold." });
    expect(text.verdict).toEqual({ text: "The lamp room is cold." });
    expect(text.asked).toEqual([{ member: "releasing", arg: RELEASE }]);
    expect((await taken({ refused: "Not that piece." })).verdict).toEqual({ refused: "Not that piece." });
    expect((await taken({ text: 7 })).verdict).toBeNull();
  });
});

describe("what the agents had ready, and which members cross the link", () => {
  const ASK: ReplyUnreleased = { userId: USER, chatId: "chat-1", turn: "gen-1", ended: "limit" };
  const READY = { text: "The lamp room is cold." };

  test("what the agents had ready crosses both ways as a text, anything else as none; a member the extension's last hello doesn't offer isn't the core's", async () => {
    const handed: ReplyUnreleased[] = [];
    const extension: BackendExtension = { name: "Harbour Play", unreleased: async (turn) => (handed.push(turn), READY) };
    expect(offerOf(extension)?.members).toEqual(["unreleased"]);
    expect(await callExtension(extension, "unreleased", ASK, USER, chats)).toEqual({ supplied: true, value: READY });
    expect(handed).toEqual([ASK]);
    expect(await callExtension({ name: "Harbour Play", unreleased: async () => ({ text: 7 }) as never }, "unreleased", ASK, USER, chats)).toEqual({ supplied: true, value: null });

    const asked: unknown[] = [];
    let members: ExtensionMember[] = ["unreleased"];
    const link = { request: async (_type: string, fields: unknown) => (asked.push(fields), { supplied: true, value: READY }) } as unknown as RuntimeLink;
    const linked = linkExtension({ link, now: () => 0, tuning: () => RUNTIME_DEFAULTS, offer: () => ({ name: "Harbour Play", members }) });
    expect(await linked.unreleased?.(ASK)).toEqual(READY);
    expect(asked).toEqual([{ member: "unreleased", arg: ASK }]);
    expect(linked.releasing).toBeUndefined();
    // A later hello that no longer offers it takes it from the core.
    members = ["claim"];
    expect(linked.unreleased).toBeUndefined();
  });

  test("a reply tool of the extension's own, from an extension that offers no releasing over the link, isn't offered: reply_write takes the reply's text, and the log says why", async () => {
    const author: AgentDefinition = { ...newAgentSettings(), id: "author", name: "Author", description: "Plays the harbour's story.", instructions: "You are the harbour's author.", given: "task", tools: ["reply_write"], grant: "definition" };
    const replyTool = { description: "Release the reply: the pieces you name, in order.", parameters: { type: "object", properties: { pieces: { type: "array", items: { type: "integer" } } }, required: ["pieces"] } };
    const answers: Record<string, unknown> = { definitions: { agents: [author] }, claim: { mainAgent: "author", reply: "released", replyTool } };
    const link = { request: async (_type: string, fields: { member: string }) => ({ supplied: true, value: answers[fields.member] ?? null }) } as unknown as RuntimeLink;
    const extension = linkExtension({ link, now: () => 0, tuning: () => RUNTIME_DEFAULTS, offer: () => ({ name: "Harbour Play", members: ["definitions", "claim"] }) });
    const host = new MemoryHost();
    host.script = [{ toolCalls: [call("reply_write", { text: "Mara looks up." }, "w1")] }, "Done."];
    host.say("chat-1", "user", "I ask Mara what she saw.");
    const stored = { values: defaultSettings(), texts: {} };
    const harness = createHarness(host, { settings: async () => structuredClone(stored), extension });
    const { result } = await runTurn(host, harness, "chat-1");
    expect(Object.keys((host.calls[0]?.tools?.find((tool) => tool.name === "reply_write")?.parameters.properties ?? {}) as object)).toEqual(["text"]);
    expect(host.logs.some((log) => log.level === "warn" && log.message.includes("reply_write"))).toBe(true);
    expect(result).toMatchObject({ status: "done", reply: "Mara looks up." });
  });
});
