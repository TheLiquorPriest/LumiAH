// Where a turn's record lands (DESIGN §5, §7). A record goes on the swipe its turn wrote, and a
// message's swipes are numbered again when one is deleted: a record still to be written moves down
// with its swipe, and one whose own swipe is gone is written nowhere. A record handed over after
// the extension's worker was restarted is still taken, since what says its turn began here is kept
// in the user's storage: it goes on at once when the chat shows its reply saved, instead of waiting
// for an end Lumiverse said while nobody listened. And a record for a turn that never began here is
// taken from nobody.

import { describe, expect, test } from "bun:test";
import type { TurnKind } from "../../../src/core/ports";
import { createBackend } from "../../../src/extension/backend/backend";
import { LinkRefused } from "../../../src/extension/backend/errors";
import { sha256 } from "../../../src/extension/backend/docs";
import type { HostGenerationType } from "../../../src/extension/backend/spindle";
import { TAG_PARAM, type TurnFacts } from "../../../src/link/contract";
import { TRANSPORT_DEFAULTS } from "../../../src/link/settings";
import { type FakeMessage, FakeHost } from "../../support/fake-host";

const USER = "user-mara";
const KEY = "lah_harbour_key";
const LOOPBACK = "conn-loop";

/** A turn's record as the runtime hands one over: what the core checks of it, and no more. */
const record = (generationId: string, kind: TurnKind) => ({ v: 1, generationId, kind, at: 2_000, path: "path-so-far", segment: "a".repeat(64), usage: { calls: 1, toolTurns: 0, in: 120, cachedIn: 0, out: 30, reasoningOut: 0, estimated: false, ms: 40 } });

/** Waits, a turn of the microtask queue at a time, for something the backend does behind an event: the fake Lumiverse answers without timers, so nothing here needs a clock. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (done()) return;
    await Promise.resolve();
  }
  throw new Error(`never happened: ${what}`);
}

/** The extension backend over a fake Lumiverse, the user's loopback key and connection in place, and a chat whose reply has two swipes, each with its turn's record. */
async function start() {
  const host = new FakeHost();
  const clock = { now: 1_000_000 };
  const assemble = () => createBackend(host, { now: () => clock.now, later: () => () => undefined, build: "test-build" });
  const backend = assemble();
  host.addConnection({ id: LOOPBACK, name: "LumiAH", provider: "custom", url: "http://127.0.0.1:7871/v1", model: "lumiah" });
  const hash = await sha256(KEY);
  await backend.registry.change(USER, (registry) => {
    registry.key = { hash, print: "", at: 0 };
  });
  const chat = host.addChat(USER, "Harbour light");
  host.say(chat.id, "user", "Who keeps the harbour light now?");
  const reply = host.say(chat.id, "assistant", "Okoro keeps it.");
  reply.swipes.push("Brann does.");
  await backend.chats.anchor(USER, chat.id, reply.id, 0, record("gen-okoro", "new"));
  await backend.chats.anchor(USER, chat.id, reply.id, 1, record("gen-brann", "swipe"));

  /** Lumiverse starts a generation on the reply (`swipe` null: it already said so), the interceptor tags it and a runtime begins the turn: the turn as the runtime is told. */
  const begin = async (generationId: string, type: HostGenerationType, swipe: number | null): Promise<TurnFacts> => {
    if (swipe !== null) host.emit.started({ generationId, chatId: chat.id, userId: USER, type, targetMessageId: reply.id, targetSwipeId: swipe });
    const interceptor = host.interceptor;
    if (interceptor === null) throw new Error("the backend registered no interceptor");
    const verdict = await interceptor.handler({ chatId: chat.id, userId: USER, generationId, type, dryRun: false, connectionId: LOOPBACK, presetId: null, personaId: null, activated: [], messages: [{ role: "user", text: "Who keeps the harbour light now?", history: true }] });
    return backend.turns.begin(USER, "relay-1", KEY, verdict.parameters?.[TAG_PARAM], `request-${generationId}`);
  };
  /** The user deletes a swipe of the reply, as Lumiverse does it: the later ones move down, and it says so. */
  const deleteSwipe = (swipe: number): void => {
    reply.swipes.splice(swipe, 1);
    if (swipe < reply.swipeId) reply.swipeId--;
    else if (swipe === reply.swipeId) reply.swipeId = Math.min(reply.swipeId, reply.swipes.length - 1);
    host.emit.touched(chat.id);
    host.emit.swipe({ chatId: chat.id, userId: USER, messageId: reply.id, action: "deleted", swipeId: swipe });
  };
  /** Lumiverse starts the extension's worker anew once what the turns begun so far left in storage is there: the backend that worker puts together. */
  const restart = async () => {
    await until(() => host.files.has(`${USER}/turns.json`), "the begun turn to be kept in storage");
    await backend.settle();
    host.reload();
    return assemble();
  };
  return { host, clock, backend, chat, reply, begin, deleteSwipe, restart };
}

/** The generations whose records a message holds, by swipe. */
const held = (message: FakeMessage): Record<string, string> => {
  const own = message.own as { swipes?: Record<string, { generationId: string }> } | null;
  return Object.fromEntries(Object.entries(own?.swipes ?? {}).map(([swipe, r]) => [swipe, r.generationId]));
};

describe("a swipe deleted while a later swipe of the message is being written", () => {
  test("moves the record of the turn writing it down with its swipe", async () => {
    const { host, backend, chat, reply, begin, deleteSwipe } = await start();
    // A third swipe is staged and generates.
    reply.swipes.push("");
    reply.swipeId = 2;
    const facts = await begin("gen-ilse", "swipe", 2);
    expect(facts.target).toEqual({ message: reply.id, swipe: 2 });

    // The first swipe goes meanwhile: the one being written is the second now, and Lumiverse saves it there.
    deleteSwipe(0);
    reply.swipes[reply.swipeId] = "Ilse did, before him.";
    host.emit.ended({ generationId: "gen-ilse", chatId: chat.id, userId: USER, messageId: reply.id, error: null });

    // The runtime hands the record over with the target it was told when the turn began.
    expect(await backend.turns.commit(USER, "gen-ilse", chat.id, facts.target, record("gen-ilse", "swipe"))).toBe("now");
    expect(held(reply)).toEqual({ "0": "gen-brann", "1": "gen-ilse" });
  });

  test("moves a record that already waits for its reply to be saved", async () => {
    const { host, backend, chat, reply, begin, deleteSwipe } = await start();
    reply.swipes.push("");
    reply.swipeId = 2;
    const facts = await begin("gen-ilse", "swipe", 2);
    expect(await backend.turns.commit(USER, "gen-ilse", chat.id, facts.target, record("gen-ilse", "swipe"))).toBe("on_save");

    deleteSwipe(0);
    reply.swipes[reply.swipeId] = "Ilse did, before him.";
    host.emit.ended({ generationId: "gen-ilse", chatId: chat.id, userId: USER, messageId: reply.id, error: null });

    await until(() => held(reply)["1"] === "gen-ilse", "the waiting record to be written on the swipe it moved to");
    expect(held(reply)).toEqual({ "0": "gen-brann", "1": "gen-ilse" });
  });

  test("moves the target of a generation whose turn hasn't begun yet", async () => {
    const { host, backend, chat, reply, begin, deleteSwipe } = await start();
    reply.swipes.push("");
    reply.swipeId = 2;
    // Lumiverse has started the generation, and the swipe goes before any runtime asked for the turn.
    host.emit.started({ generationId: "gen-ilse", chatId: chat.id, userId: USER, type: "swipe", targetMessageId: reply.id, targetSwipeId: 2 });
    deleteSwipe(0);

    const facts = await begin("gen-ilse", "swipe", null);
    expect(facts.target).toEqual({ message: reply.id, swipe: 1 });
    reply.swipes[reply.swipeId] = "Ilse did, before him.";
    host.emit.ended({ generationId: "gen-ilse", chatId: chat.id, userId: USER, messageId: reply.id, error: null });
    expect(await backend.turns.commit(USER, "gen-ilse", chat.id, facts.target, record("gen-ilse", "swipe"))).toBe("now");
    expect(held(reply)).toEqual({ "0": "gen-brann", "1": "gen-ilse" });
  });

  test("writes nowhere the record of a turn whose own swipe was the one deleted, and leaves the others' as they are", async () => {
    const { host, backend, chat, reply, begin, deleteSwipe } = await start();
    // The first swipe is shown and continued; it is deleted under its own generation, which Lumiverse then fails.
    const facts = await begin("gen-more", "continue", 0);
    deleteSwipe(0);
    host.emit.ended({ generationId: "gen-more", chatId: chat.id, userId: USER, messageId: null, error: "The generation's target swipe was deleted" });

    // The swipe that moved into its place is another reply's: the record must not land on it.
    expect(await backend.turns.commit(USER, "gen-more", chat.id, facts.target, record("gen-more", "continue"))).toBe("never");
    await until(() => held(reply)["0"] === "gen-brann", "the later swipe's record to move down");
    expect(held(reply)).toEqual({ "0": "gen-brann" });
    expect(host.logs.some((l) => l.level === "warn" && l.message.includes("was deleted, so its record wasn't written"))).toBe(true);
  });
});

describe("a record handed over after the extension's worker was restarted while its turn ran", () => {
  test("is written at once when the chat shows the reply saved", async () => {
    const { clock, chat, reply, begin, restart } = await start();
    reply.swipes.push("");
    reply.swipeId = 2;
    const facts = await begin("gen-ilse", "swipe", 2);
    // The worker is restarted; the reply is saved, and its end said, while there is none to hear it.
    const backend = await restart();
    reply.swipes[2] = "Ilse did, before him.";

    expect(await backend.turns.commit(USER, "gen-ilse", chat.id, facts.target, record("gen-ilse", "swipe"))).toBe("now");
    expect(held(reply)["2"]).toBe("gen-ilse");
    // Not a moment of the wait for a save went by.
    expect(clock.now).toBe(1_000_000);
  });

  test("still waits for the save when the reply's swipe is empty", async () => {
    const { host, chat, reply, begin, restart } = await start();
    reply.swipes.push("");
    reply.swipeId = 2;
    const facts = await begin("gen-ilse", "swipe", 2);
    const backend = await restart();
    // A swipe staged and not saved yet: its end is still to come, and the new worker hears it.
    expect(await backend.turns.commit(USER, "gen-ilse", chat.id, facts.target, record("gen-ilse", "swipe"))).toBe("on_save");
    expect(held(reply)["2"]).toBeUndefined();
    reply.swipes[2] = "Ilse did, before him.";
    host.emit.ended({ generationId: "gen-ilse", chatId: chat.id, userId: USER, messageId: reply.id, error: null });
    await until(() => held(reply)["2"] === "gen-ilse", "the record to be written once the reply is saved");
  });

  test("waits out the wait for a continue, whose swipe held text before it began", async () => {
    const { clock, chat, reply, begin, restart } = await start();
    const facts = await begin("gen-more", "continue", 1);
    const backend = await restart();
    // A continue's text says nothing of whether it was saved: its record waits, and the tick writes it once the wait is over.
    expect(await backend.turns.commit(USER, "gen-more", chat.id, facts.target, record("gen-more", "continue"))).toBe("on_save");
    expect(held(reply)["1"]).toBe("gen-brann");
    clock.now += TRANSPORT_DEFAULTS.anchors.waitMs + 1;
    await backend.tick();
    await until(() => held(reply)["1"] === "gen-more", "the continue's record to be written after the wait");
  });
});

describe("a record for a turn that never began here", () => {
  test("is taken from nobody: not for a made-up turn, not for a turn of another chat, and nothing is written", async () => {
    const { host, backend, chat, reply, begin } = await start();
    const refusal = (asked: Promise<unknown>) =>
      asked.then(
        () => "taken",
        (error: unknown) => (error instanceof LinkRefused ? error.code : String(error)),
      );
    // No reply by that id was ever asked for here.
    expect(await refusal(backend.turns.commit(USER, "gen-nobody", chat.id, { message: reply.id, swipe: 1 }, record("gen-nobody", "swipe")))).toBe("not_found");
    // A turn that did begin here is one of its own chat alone.
    reply.swipes.push("");
    reply.swipeId = 2;
    const facts = await begin("gen-ilse", "swipe", 2);
    const other = host.addChat(USER, "Brann's ledger");
    const entry = host.say(other.id, "assistant", "Two casks.");
    expect(await refusal(backend.turns.commit(USER, "gen-ilse", other.id, { message: entry.id, swipe: 0 }, record("gen-ilse", "swipe")))).toBe("not_found");
    expect(entry.own).toBeNull();
    expect(held(reply)).toEqual({ "0": "gen-okoro", "1": "gen-brann" });
    // Its own record, for its own chat, is taken as ever.
    expect(await backend.turns.commit(USER, "gen-ilse", chat.id, facts.target, record("gen-ilse", "swipe"))).toBe("on_save");
  });
});
