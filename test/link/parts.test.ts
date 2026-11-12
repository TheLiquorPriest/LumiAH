// A frame sent in parts, and what the end that joins it may be made to hold (DESIGN §6, §7). The
// extension joins a frame's parts before it can check any secret, so anyone signed in to Lumiverse
// can send it parts: the joiner takes no more frames at once, and holds no more of them, than its
// limits say, and the extension lets go of what stopped coming on its own tick.

import { describe, expect, test } from "bun:test";
import { createBackend } from "../../src/extension/backend/backend";
import { LINK, type PartFrame } from "../../src/link/contract";
import { isRecord } from "../../src/link/json";
import { PartJoiner } from "../../src/link/parts";
import { CEILINGS, TRANSPORT_DEFAULTS } from "../../src/link/settings";
import { FakeHost } from "../support/fake-host";

const USER = "user-mara";
const SESSION = "0123456789abcdef0123456789abcdef";
const OTHER_SESSION = "fedcba9876543210fedcba9876543210";

const part = (id: string, index: number, count: number, data: string): PartFrame => ({ link: LINK, type: "part", id, index, count, data });

/** One frame's largest size and the wait for its parts, as every joiner has them; a test adds the limits it is about. */
const ROOMY = { maxUnits: 4 * 1024 * 1024, staleMs: 1_000 };

describe("a joiner", () => {
  test("refuses a frame begun past the most it puts together at once, and keeps the ones under way", () => {
    const joiner = new PartJoiner(() => ({ ...ROOMY, maxFrames: 2 }));
    expect(joiner.take(part("a", 0, 2, "Low tide "), 0)).toEqual({ waiting: true });
    expect(joiner.take(part("b", 0, 2, "High tide "), 0)).toEqual({ waiting: true });

    expect(joiner.take(part("c", 0, 2, "Slack water "), 0)).toMatchObject({ id: "c", over: "frames", refused: expect.stringContaining("already putting together 2 frames") });
    expect(joiner.waiting).toBe(2);
    expect(joiner.held).toBe("Low tide ".length + "High tide ".length);

    // The ones under way are whole when their rest comes, and there is room again.
    expect(joiner.take(part("a", 1, 2, "at the quay."), 0)).toEqual({ text: "Low tide at the quay." });
    expect(joiner.take(part("c", 0, 2, "Slack water "), 0)).toEqual({ waiting: true });
    expect(joiner.waiting).toBe(2);
  });

  test("refuses the frame whose part would have it hold too much, and holds nothing of that frame", () => {
    const joiner = new PartJoiner(() => ({ ...ROOMY, maxHeldUnits: 25 }));
    joiner.take(part("a", 0, 2, "0123456789"), 0);
    joiner.take(part("b", 0, 2, "0123456789"), 0);
    expect(joiner.held).toBe(20);

    expect(joiner.take(part("c", 0, 2, "0123456789"), 0)).toMatchObject({ id: "c", over: "held", refused: expect.stringContaining("the most it holds at once") });
    expect(joiner.waiting).toBe(2);
    expect(joiner.held).toBe(20);
    // A frame that ends gives back what it held.
    expect(joiner.take(part("a", 1, 2, "ab"), 0)).toEqual({ text: "0123456789ab" });
    expect(joiner.held).toBe(10);
  });

  test("keeps two senders' frames under one id apart, and lets go of one sender's alone", () => {
    const joiner = new PartJoiner(() => ROOMY);
    joiner.take(part("1", 0, 2, "Mara's "), 0, "mara");
    joiner.take(part("1", 0, 2, "Joss's "), 0, "joss");
    expect(joiner.waiting).toBe(2);

    joiner.clear("mara");
    expect(joiner.waiting).toBe(1);
    expect(joiner.take(part("1", 1, 2, "ledger."), 0, "joss")).toEqual({ text: "Joss's ledger." });
    expect(joiner.held).toBe(0);
  });

  test("lets go of what stopped coming when asked, without waiting for the next part", () => {
    const joiner = new PartJoiner(() => ROOMY);
    joiner.take(part("a", 0, 2, "Low tide "), 0);
    joiner.take(part("b", 0, 2, "High tide "), 600);
    joiner.purge(1_001);
    // Only the frame whose first part is older than the wait.
    expect(joiner.waiting).toBe(1);
    expect(joiner.held).toBe("High tide ".length);
    joiner.purge(1_601);
    expect([joiner.waiting, joiner.held]).toEqual([0, 0]);
  });

  test("takes as many frames as come where no such limit is set, as the runtime's does", () => {
    const joiner = new PartJoiner(() => ROOMY);
    for (let n = 0; n < 40; n++) expect(joiner.take(part(`frame-${n}`, 0, 2, "0123456789"), 0)).toEqual({ waiting: true });
    expect([joiner.waiting, joiner.held]).toEqual([40, 400]);
  });

  test("refuses a frame past what the other joiners leave of a bound they share, as busy and not as too large for its own limits", () => {
    // What the others leave this joiner, as its owner counts it each time.
    const shared = { frames: 2, units: 1_000 };
    const joiner = new PartJoiner(() => ({ ...ROOMY, maxFrames: 8, maxHeldUnits: 1_000, shared }));
    joiner.take(part("a", 0, 2, "0123456789"), 0);
    joiner.take(part("b", 0, 2, "0123456789"), 0);

    expect(joiner.take(part("c", 0, 2, "0123456789"), 0)).toMatchObject({ id: "c", over: "shared", refused: expect.stringContaining("LumiAH is busy") });
    expect([joiner.waiting, joiner.held]).toEqual([2, 20]);

    // Room for the frame, none for what it holds: nothing of it is kept.
    shared.frames = 8;
    shared.units = 25;
    expect(joiner.take(part("c", 0, 2, "0123456789"), 0)).toMatchObject({ id: "c", over: "shared", refused: expect.stringContaining("LumiAH is busy") });
    expect([joiner.waiting, joiner.held]).toEqual([2, 20]);

    // The others finished theirs: the same frame is taken.
    shared.units = 1_000;
    expect(joiner.take(part("c", 0, 2, "0123456789"), 0)).toEqual({ waiting: true });
    expect(joiner.take(part("c", 1, 2, "ab"), 0)).toEqual({ text: "0123456789ab" });
  });
});

/** The extension backend over a fake Lumiverse, with a clock the test moves and no timers. */
async function backendOf(link: Partial<(typeof TRANSPORT_DEFAULTS)["link"]>) {
  const host = new FakeHost();
  const clock = { now: 1_000_000 };
  const backend = createBackend(host, { now: () => clock.now, later: () => () => undefined, build: "test-build" });
  await backend.settings.change(USER, Object.entries(link).map(([key, value]) => ({ path: ["transport", "link", key], value })), []);
  /** The error frames sent back so far, by the id they answer. */
  const refusals = (): { id: unknown; code: unknown; message: string; session: string | undefined }[] =>
    host.sent.flatMap((s) => (isRecord(s.message) && s.message.type === "error" ? [{ id: s.message.id, code: s.message.code, message: String(s.message.message), session: s.session }] : []));
  return { host, clock, backend, refusals };
}

describe("the extension, sent frames in parts", () => {
  test("puts a request together and answers it as one sent whole", async () => {
    const { host, backend } = await backendOf({});
    const whole = JSON.stringify({ link: LINK, type: "register", id: "r1", name: "mara", build: "test-build", host: "harbour-box", listen: "127.0.0.1", port: 7871 });
    const half = Math.ceil(whole.length / 2);
    expect(await backend.server.frame(part("r1", 0, 2, whole.slice(0, half)), USER, SESSION)).toBe(true);
    expect(backend.server.joining(USER)).toEqual({ frames: 1, units: half });
    await backend.server.frame(part("r1", 1, 2, whole.slice(half)), USER, SESSION);

    expect(host.sent.map((s) => s.message)).toMatchObject([{ link: LINK, type: "result", id: "r1", body: { relay: expect.any(String), secret: expect.any(String) } }]);
    expect(backend.server.joining(USER)).toEqual({ frames: 0, units: 0 });
  });

  test("refuses an account past the frames it may have under way, whichever of its sessions sends them, as no room just now (it passes once they are done), and holds no more", async () => {
    const { backend, refusals } = await backendOf({ joinFrames: 2 });
    await backend.server.frame(part("a", 0, 2, "Low tide "), USER, SESSION);
    await backend.server.frame(part("b", 0, 2, "High tide "), USER, SESSION);
    const held = { frames: 2, units: "Low tide ".length + "High tide ".length };
    expect(backend.server.joining(USER)).toEqual(held);

    await backend.server.frame(part("c", 0, 2, "Slack water "), USER, SESSION);
    // A session's id is the sender's to choose: another one opens no more room.
    await backend.server.frame(part("d", 0, 2, "Spring tide "), USER, OTHER_SESSION);
    expect(backend.server.joining(USER)).toEqual(held);
    expect(refusals().map((r) => [r.id, r.code, r.session])).toEqual([
      ["c", "unavailable", SESSION],
      ["d", "unavailable", OTHER_SESSION],
    ]);
    // The words say what holds it up and what to do.
    const words = refusals()[0]?.message ?? "";
    expect(words).toContain("already putting together 2 frames");
    expect(words).toContain("send this one again once they are done");
    expect(words).toContain('raise "Frames joined at once" (LumiAH → Settings → Transport → Link)');

    // Another account has its own room.
    await backend.server.frame(part("a", 0, 2, "Brann's "), "user-brann", SESSION);
    expect(backend.server.joining("user-brann")).toEqual({ frames: 1, units: "Brann's ".length });
    expect(refusals()).toHaveLength(2);
  });

  test("refuses the frame that would have it hold too much of an account's as no room just now, and says which setting that is", async () => {
    const { backend, refusals } = await backendOf({ joinHeldUnits: 1024 * 1024 });
    const piece = "x".repeat(400 * 1024);
    await backend.server.frame(part("a", 0, 4, piece), USER, SESSION);
    await backend.server.frame(part("b", 0, 4, piece), USER, OTHER_SESSION);
    await backend.server.frame(part("c", 0, 4, piece), USER, SESSION);

    expect(backend.server.joining(USER)).toEqual({ frames: 2, units: 2 * piece.length });
    expect(refusals()).toMatchObject([{ id: "c", code: "unavailable", session: SESSION }]);
    expect(refusals()[0]?.message).toContain('raise "Characters held while joining" (LumiAH → Settings → Transport → Link)');
  });

  test("refuses a frame larger than the largest it joins as too large, whatever else is under way, and says which setting that is", async () => {
    const { backend, refusals } = await backendOf({ joinMaxUnits: 1024 * 1024 });
    // Its parts say it is three of 512 Ki characters: past 1 Mi before any of it is held.
    await backend.server.frame(part("a", 0, 3, "x".repeat(512 * 1024)), USER, SESSION);

    expect(backend.server.joining(USER)).toEqual({ frames: 0, units: 0 });
    expect(refusals()).toMatchObject([{ id: "a", code: "too_large", session: SESSION }]);
    expect(refusals()[0]?.message).toContain("That frame is over 1 million characters");
    expect(refusals()[0]?.message).toContain('Raise "Largest frame joined" (LumiAH → Settings → Transport → Link)');
  });

  test("lets go of the parts whose rest never came on its tick, for every session", async () => {
    const { backend, clock } = await backendOf({ joinFrames: 2 });
    await backend.server.frame(part("a", 0, 2, "Low tide "), USER, SESSION);
    await backend.server.frame(part("b", 0, 2, "High tide "), USER, OTHER_SESSION);

    // Not yet stale: a tick leaves them.
    clock.now += TRANSPORT_DEFAULTS.link.partStaleMs;
    await backend.tick();
    expect(backend.server.joining(USER).frames).toBe(2);

    // Neither session sends another part: the tick alone lets them go.
    clock.now += 1;
    await backend.tick();
    expect(backend.server.joining(USER)).toEqual({ frames: 0, units: 0 });
  });

  test("lets go of a session's half-sent frames when the session closes, and of no other's", async () => {
    const { host, backend } = await backendOf({});
    await backend.server.frame(part("a", 0, 2, "Low tide "), USER, SESSION);
    await backend.server.frame(part("b", 0, 2, "High tide "), USER, OTHER_SESSION);
    host.closeSession(SESSION);
    expect(backend.server.joining(USER)).toEqual({ frames: 1, units: "High tide ".length });
    host.closeSession(OTHER_SESSION);
    expect(backend.server.joining(USER)).toEqual({ frames: 0, units: 0 });
  });

  test("holds no more unfinished frames for all accounts together than its own total, and tells the account past it to send again, not to raise a setting", async () => {
    const { host, backend, refusals } = await backendOf({});
    // Each account within its own bound, and enough of them to fill the total.
    const each = TRANSPORT_DEFAULTS.link.joinFrames;
    const accounts = Array.from({ length: CEILINGS.joinFramesTotal / each }, (_, n) => `user-${n}`);
    for (const account of accounts) for (let n = 0; n < each; n++) await backend.server.frame(part(`frame-${n}`, 0, 2, "Low tide "), account, `session-${account}`);
    const held = (): number => accounts.reduce((sum, account) => sum + backend.server.joining(account).frames, 0);
    expect(held()).toBe(CEILINGS.joinFramesTotal);
    expect(refusals()).toEqual([]);

    // Brann has nothing under way and every setting as it ships: it is the others' frames that leave no room.
    await backend.server.frame(part("a", 0, 2, "Brann's "), "user-brann", SESSION);
    expect(backend.server.joining("user-brann")).toEqual({ frames: 0, units: 0 });
    expect(held()).toBe(CEILINGS.joinFramesTotal);
    expect(refusals()).toMatchObject([{ id: "a", code: "unavailable", session: SESSION }]);
    const words = refusals()[0]?.message ?? "";
    expect(words).toContain("LumiAH is busy");
    expect(words).toContain("Send this one again in a moment.");
    expect(words).not.toContain("raise");

    // One account's frames are let go: there is room again, and the same frame is taken.
    host.closeSession("session-user-0");
    await backend.server.frame(part("a", 0, 2, "Brann's "), "user-brann", SESSION);
    expect(backend.server.joining("user-brann")).toEqual({ frames: 1, units: "Brann's ".length });
    expect(refusals()).toHaveLength(1);
  });
});
