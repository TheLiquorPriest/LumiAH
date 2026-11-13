// The extension's word on a turn's reply as it crosses the link (DESIGN §21, §25): the backend sends
// what the extension's `releasing` said, and the runtime hands the core what the backend sent. A
// refusal, and a text that goes out in place of what the call carried, arrive as they were given;
// anything else arrives as no word. The call's arguments go with the ask.

import { describe, expect, test } from "bun:test";
import type { ReplyRelease } from "../../src/core/extension";
import { type BackendExtension, callExtension } from "../../src/extension/backend/extension";
import { RUNTIME_DEFAULTS } from "../../src/link/settings";
import { linkExtension } from "../../src/runtime/host";
import type { RuntimeLink } from "../../src/runtime/link";

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
