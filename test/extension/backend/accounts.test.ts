// Two accounts on one Lumiverse (DESIGN §7): the interceptor's bookkeeping is each account's own.
// What one account's settings let go of is that account's own turns and waiting records, never
// another's, so nothing an account does (or sets its limits to) costs another account a reply or
// a record. The live buffer's half of this is in live.test.ts.

import { describe, expect, test } from "bun:test";
import type { TurnKind } from "../../../src/core/ports";
import { createBackend } from "../../../src/extension/backend/backend";
import { sha256 } from "../../../src/extension/backend/docs";
import { TAG_PARAM } from "../../../src/link/contract";
import { FakeHost } from "../../support/fake-host";

const MARA = "user-mara";
const JOSS = "user-joss";
const KEY = "lah_harbour_key";
const LOOPBACK = "conn-loop";

/** A turn's record as a runtime hands one over: what the core checks of it, and no more. */
const record = (generationId: string, kind: TurnKind = "new") => ({ v: 1, generationId, kind, at: 2_000, path: "path-so-far", segment: "a".repeat(64), usage: { calls: 1, toolTurns: 0, in: 120, cachedIn: 0, out: 30, reasoningOut: 0, estimated: false, ms: 40 } });

/** Waits, a turn of the microtask queue at a time, for something the backend does behind an event: the fake Lumiverse answers without timers. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (done()) return;
    await Promise.resolve();
  }
  throw new Error(`never happened: ${what}`);
}

/** The extension backend over a fake Lumiverse with a loopback connection, a loopback key in place for each account (the same words, as two users may well choose), and a chat of each account's that generates on the loopback. */
async function start() {
  const host = new FakeHost();
  const backend = createBackend(host, { now: () => 1_000_000, later: () => () => undefined, build: "test-build" });
  host.addConnection({ id: LOOPBACK, name: "LumiAH", provider: "custom", url: "http://127.0.0.1:7871/v1", model: "lumiah" });
  const hash = await sha256(KEY);
  for (const userId of [MARA, JOSS]) {
    await backend.registry.change(userId, (registry) => {
      registry.key = { hash, print: "", at: 0 };
    });
  }
  const hers = host.addChat(MARA, "Harbour light");
  host.say(hers.id, "user", "Who keeps the harbour light now?");
  const his = host.addChat(JOSS, "Joss's nets");
  host.say(his.id, "user", "Are the nets dry?");
  const interceptor = host.interceptor;
  if (interceptor === null) throw new Error("the backend registered no interceptor");
  /** Lumiverse starts a new reply in a chat and its prompt comes to the interceptor: the tag the generation was given. */
  const tagged = async (userId: string, chatId: string, generationId: string): Promise<unknown> => {
    host.emit.started({ generationId, chatId, userId, type: "normal", targetMessageId: null, targetSwipeId: null });
    const verdict = await interceptor.handler({ chatId, userId, generationId, type: "normal", dryRun: false, connectionId: LOOPBACK, presetId: null, personaId: null, activated: [], messages: [{ role: "user", text: "Who keeps the harbour light now?", history: true }] });
    return verdict.parameters?.[TAG_PARAM];
  };
  return { host, backend, hers, his, tagged };
}

describe("two accounts on one server, in the interceptor's bookkeeping", () => {
  test("one account's 'Tags remembered' lets go of its own oldest turns alone: another account's tagged reply still begins", async () => {
    const { backend, hers, his, tagged } = await start();
    // Joss keeps the fewest turns his Settings allow.
    await backend.settings.change(JOSS, [{ path: ["transport", "tags", "held"], value: 8 }], []);

    // Mara's prompt is tagged and on its way to her runtime; meanwhile Joss asks for nine replies in his own chat.
    const tag = await tagged(MARA, hers.id, "gen-mara");
    for (let n = 0; n < 9; n++) await tagged(JOSS, his.id, `gen-joss-${n}`);

    // Her runtime shows the tag: the turn is hers, and begins.
    expect(await backend.turns.begin(MARA, "relay-1", KEY, tag, "request-1")).toMatchObject({ turn: "gen-mara", user: MARA, chat: hers.id });
    // Joss's own oldest turn is the one his setting let go; his latest eight stand.
    expect(backend.turns.turn("gen-joss-0")).toBeUndefined();
    expect(backend.turns.turn("gen-joss-1")?.userId).toBe(JOSS);
    expect(backend.turns.turn("gen-joss-8")?.userId).toBe(JOSS);
    // And a tag is no tag at all to another account: Joss, with a key of his own, can't begin Mara's turn with it.
    await expect(backend.turns.begin(JOSS, "relay-2", KEY, tag, "request-2")).rejects.toThrow("doesn't know this reply's tag");
  });

  test("one account's 'Records waiting' writes its own oldest record early, and leaves another account's record waiting for its reply", async () => {
    const { host, backend, hers, his, tagged } = await start();
    await backend.settings.change(JOSS, [{ path: ["transport", "anchors", "held"], value: 1 }], []);

    // Mara's turn has ended in her runtime and its record waits for Lumiverse to save her reply, whose message is made only as it is saved.
    const facts = await backend.turns.begin(MARA, "relay-1", KEY, await tagged(MARA, hers.id, "gen-mara"), "request-1");
    expect(facts.target.message).toBeNull();
    expect(await backend.turns.commit(MARA, "gen-mara", hers.id, facts.target, record("gen-mara"))).toBe("on_save");

    // Joss's two turns hand over their records; his setting holds one, so his own older one is written at once, where there is nowhere yet.
    await tagged(JOSS, his.id, "gen-joss-1");
    await tagged(JOSS, his.id, "gen-joss-2");
    expect(await backend.turns.commit(JOSS, "gen-joss-1", his.id, { message: null, swipe: 0 }, record("gen-joss-1"))).toBe("on_save");
    expect(await backend.turns.commit(JOSS, "gen-joss-2", his.id, { message: null, swipe: 0 }, record("gen-joss-2"))).toBe("on_save");
    await until(() => host.logs.some((l) => l.message.includes("gen-joss")), "Joss's older record to be written early");
    expect(host.logs.filter((l) => l.message.includes("gen-mara"))).toEqual([]);

    // Lumiverse saves Mara's reply and says so: her record is on it.
    const reply = host.say(hers.id, "assistant", "Okoro keeps it now.");
    host.emit.ended({ generationId: "gen-mara", chatId: hers.id, userId: MARA, messageId: reply.id, error: null });
    await until(() => reply.own !== null, "the record on Mara's reply");
    expect(reply.own).toMatchObject({ swipes: { "0": { generationId: "gen-mara" } } });
  });

  test("a record is taken for a turn of the caller's own alone: another account's turn is no turn to hand a record over for", async () => {
    const { backend, hers, his, tagged } = await start();
    await tagged(MARA, hers.id, "gen-mara");
    // Joss names Mara's turn, in a chat of his own and in hers: neither is a turn of his.
    await expect(backend.turns.commit(JOSS, "gen-mara", his.id, { message: null, swipe: 0 }, record("gen-mara"))).rejects.toThrow("knows no such turn");
    await expect(backend.turns.commit(JOSS, "gen-mara", hers.id, { message: null, swipe: 0 }, record("gen-mara"))).rejects.toThrow("There is no such chat in this account.");
  });
});
