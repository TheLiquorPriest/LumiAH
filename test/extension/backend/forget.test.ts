// The chats Lumiverse deleted, handed to the runtime to forget (DESIGN §7), on the whole backend
// over a fake Lumiverse: a chat deleted while no runtime is linked is kept in the user's storage,
// through a restart of the extension's worker, and handed over once one links; one the runtime
// refused while a run in it was still under way is handed over again at its next ping; one the
// runtime forgot leaves the list; and a deletion that names no user is nobody's to forget for.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentUsage } from "../../../src/core/ports";
import { type Rig, type RigOptions, rig, until, USER } from "../../support/rig";

const NO_USAGE: AgentUsage = { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0 };

let open: Rig | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

/**
 * A runtime's core that only forgets: each ask is noted (`forget <chat>`), and the first `refuse` of
 * them are refused as the core refuses one while a reply is worked on in the chat. A reply it is
 * asked for is noted (`answer`) and works until `replying` settles.
 */
function forgetting(seen: string[], refuse = 0, replying: Promise<void> = Promise.resolve()): NonNullable<RigOptions["harness"]> {
  let refused = 0;
  return () => ({
    answer: async () => {
      seen.push("answer");
      await replying;
      return { status: "failed", reason: "no turn is answered in this test", record: null, reply: "", usage: NO_USAGE };
    },
    chats: {
      forget: async ({ chatId }: { chatId: string }) => {
        seen.push(`forget ${chatId}`);
        if (refused++ < refuse) throw Object.assign(new Error("A reply is being worked on in this chat: forget it once that has ended."), { code: "conflict" });
        return { documents: 4, jobs: 1, sides: 0 };
      },
    },
  });
}

/** Lumiverse deletes a chat of the user's (or of nobody it names) and says so to every extension. */
function deleteChat(it: Rig, chatId: string, userId: string | null = USER): void {
  it.host.chatList.delete(chatId);
  it.host.emit.touched(chatId, true, userId);
}

/** The chats the user's storage still keeps for the runtime to forget. */
const waiting = (it: Rig): string[] => Object.keys((it.host.stored(USER, "forget.json") as { chats?: Record<string, number> } | null)?.chats ?? {});

describe("a chat Lumiverse deleted", () => {
  test("while no runtime is linked is kept, through a restart of the extension, and handed over once one links; forgotten there, it leaves the list", async () => {
    const seen: string[] = [];
    const it = (open = await rig({ harness: forgetting(seen) }));
    const ledger = it.host.addChat(USER, "Brann's ledger");
    const nets = it.host.addChat(USER, "Joss's nets");
    deleteChat(it, ledger.id);
    deleteChat(it, nets.id);
    await it.backend.settle();
    expect(waiting(it)).toEqual([ledger.id, nets.id]);
    expect(seen).toEqual([]);

    await it.restart();
    expect(waiting(it)).toEqual([ledger.id, nets.id]);

    // A runtime links: it is handed each, in the order they were deleted.
    await it.setUp();
    await until(() => seen.length === 2 && waiting(it).length === 0, "the runtime to forget both chats");
    expect(seen).toEqual([`forget ${ledger.id}`, `forget ${nets.id}`]);
    await it.backend.settle();
    expect(it.host.stored(USER, "forget.json")).toEqual({ v: 1, chats: {} });
  });

  test("refused by the runtime while a run in it was under way, it is handed over again at the runtime's next ping, and then leaves the list", async () => {
    const seen: string[] = [];
    const reply = Promise.withResolvers<void>();
    const it = (open = await rig({ harness: forgetting(seen, 1, reply.promise) }));
    const chatId = await it.setUp();
    // While it answers a reply the runtime pings every second, naming it.
    await it.backend.settings.change(USER, [{ path: ["transport", "runtime", "probeMs"], value: 1_000 }], []);
    it.backend.relays.onPing(() => void seen.push("ping"));
    const generating = it.generate(chatId).catch(() => null);
    await until(() => seen.includes("answer"), "the reply to be under way");

    const ledger = it.host.addChat(USER, "Brann's ledger");
    deleteChat(it, ledger.id);
    await until(() => seen.filter((event) => event.startsWith("forget")).length === 2 && waiting(it).length === 0, "the runtime to forget the chat at last", 10_000);
    const asked = seen.flatMap((event, at) => (event === `forget ${ledger.id}` ? [at] : []));
    expect(asked).toHaveLength(2);
    // Refused, it was kept, and asked again once the runtime pinged.
    expect(seen.slice(asked[0], asked[1]).includes("ping")).toBe(true);
    reply.resolve();
    await generating;
  });

  test("while a runtime is linked is handed over at once, and leaves the list once forgotten", async () => {
    const seen: string[] = [];
    const it = (open = await rig({ harness: forgetting(seen) }));
    await it.setUp();
    const ledger = it.host.addChat(USER, "Brann's ledger");
    deleteChat(it, ledger.id);
    await until(() => seen.length === 1 && waiting(it).length === 0, "the runtime to forget the chat");
    expect(seen).toEqual([`forget ${ledger.id}`]);
  });

  test("with no user named is nobody's to forget for: nothing is kept and no runtime is asked", async () => {
    const seen: string[] = [];
    const it = (open = await rig({ harness: forgetting(seen) }));
    await it.setUp();
    const stray = it.host.addChat(USER, "A chat nobody claims");
    deleteChat(it, stray.id, null);
    await it.backend.settle();
    expect(waiting(it)).toEqual([]);
    expect(seen).toEqual([]);
  });
});
