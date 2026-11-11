// The extension's worker is one process for every account of a Lumiverse (DESIGN §7). What it
// holds in memory for an account is bounded by that account's settings as far as a ceiling no
// setting passes, and for all accounts together by a total that is nobody's setting: an account can
// lower its own bounds, and never raise them past what leaves the others their room.

import { describe, expect, test } from "bun:test";
import type { JobView, RemoteToolCall } from "../../../src/core/ports";
import { createBackend } from "../../../src/extension/backend/backend";
import { LinkRefused } from "../../../src/extension/backend/errors";
import { RemoteTools } from "../../../src/extension/backend/extension";
import { JobsBoard } from "../../../src/extension/backend/jobs";
import type { Mcp } from "../../../src/extension/backend/mcp";
import { StreamRegistry } from "../../../src/extension/backend/streams";
import { LINK, type PartFrame } from "../../../src/link/contract";
import { isRecord } from "../../../src/link/json";
import { CEILINGS, TRANSPORT_DEFAULTS } from "../../../src/link/settings";
import { FakeHost } from "../../support/fake-host";
import { FakeLumiverse, UiFailure } from "../../support/fake-lumiverse";

const USER = "user-mara";
const SESSION = "0123456789abcdef0123456789abcdef";
const MI = 1024 * 1024;

const part = (id: string, index: number, count: number, data: string): PartFrame => ({ link: LINK, type: "part", id, index, count, data });

/** The extension backend over a fake Lumiverse, with a clock the test moves, and a page of Mara's. */
function made(host = new FakeHost()) {
  const lumiverse = new FakeLumiverse(host, USER);
  const clock = { now: 1_000_000 };
  const backend = createBackend(host, { now: () => clock.now, later: () => () => undefined, build: "test-build" });
  const page = lumiverse.page();
  /** What a change of settings was refused for, by each value's path in order; null when it was taken. */
  const refusedAt = async (set: { path: string[]; value: number }[]): Promise<string[] | null> => {
    try {
      await page.request("lah.settings.set", { set, reset: [] });
      return null;
    } catch (error) {
      if (!(error instanceof UiFailure)) throw error;
      return (error.error.problems ?? []).map((p) => p.path.join(".")).sort();
    }
  };
  return { host, clock, backend, page, refusedAt };
}

/** Every setting that bounds what the worker holds for an account, with its ceiling. */
const BOUNDED: [section: string, key: string, ceiling: number][] = [
  ["link", "joinMaxUnits", CEILINGS.joinMaxUnits],
  ["link", "partStaleMs", CEILINGS.partStaleMs],
  ["link", "joinFrames", CEILINGS.joinFrames],
  ["link", "joinHeldUnits", CEILINGS.joinHeldUnits],
  ["streams", "keepMs", CEILINGS.streamKeepMs],
  ["live", "events", CEILINGS.liveEvents],
  ["live", "chats", CEILINGS.liveChats],
  ["tags", "held", CEILINGS.tagsHeld],
  ["tags", "known", CEILINGS.tagsKnown],
  ["anchors", "held", CEILINGS.recordsWaiting],
];

describe("an account's own bounds", () => {
  test("are refused past their ceilings and taken at them, each one", async () => {
    const { refusedAt, backend } = made();
    for (const [section, key, ceiling] of BOUNDED) {
      expect(await refusedAt([{ path: ["transport", section, key], value: ceiling + 1 }])).toEqual([`transport.${section}.${key}`]);
      expect(await refusedAt([{ path: ["transport", section, key], value: ceiling }])).toBeNull();
    }
    const transport = (await backend.settings.transport(USER)) as unknown as Record<string, Record<string, number>>;
    expect(BOUNDED.map(([section, key]) => transport[section]?.[key])).toEqual(BOUNDED.map(([, , ceiling]) => ceiling));
  });

  test("can't be raised to have the extension hold more unfinished frames than it refused a moment ago", async () => {
    const { backend, refusedAt } = made();
    const piece = "x".repeat(400 * 1024);
    // The bound at its least (1 Mi characters): the third unfinished frame is refused.
    expect(await refusedAt([{ path: ["transport", "link", "joinHeldUnits"], value: MI }])).toBeNull();
    for (const id of ["a", "b", "c"]) await backend.server.frame(part(id, 0, 4, piece), USER, SESSION);
    expect(backend.server.joining(USER)).toEqual({ frames: 2, units: 2 * piece.length });

    // The same account asks for what an earlier build's settings took: a gigabyte of characters, 1024 frames, kept an hour.
    expect(
      await refusedAt([
        { path: ["transport", "link", "joinHeldUnits"], value: 1024 * MI },
        { path: ["transport", "link", "joinFrames"], value: 1024 },
        { path: ["transport", "link", "partStaleMs"], value: 60 * 60_000 },
      ]),
    ).toEqual(["transport.link.joinFrames", "transport.link.joinHeldUnits", "transport.link.partStaleMs"]);
    for (let n = 0; n < 12; n++) await backend.server.frame(part(`more-${n}`, 0, 4, piece), USER, SESSION);
    expect(backend.server.joining(USER)).toEqual({ frames: 2, units: 2 * piece.length });
  });

  test("at their ceilings have the extension put together no more frames at once than the ceiling", async () => {
    const { backend, refusedAt, host } = made();
    expect(await refusedAt([{ path: ["transport", "link", "joinFrames"], value: CEILINGS.joinFrames }])).toBeNull();
    for (let n = 0; n < CEILINGS.joinFrames + 6; n++) await backend.server.frame(part(`frame-${n}`, 0, 2, "Low tide "), USER, SESSION);

    expect(backend.server.joining(USER).frames).toBe(CEILINGS.joinFrames);
    // The ones past it were refused as the account's own doing, each in words.
    const refusals = host.sent.flatMap((s) => (isRecord(s.message) && s.message.type === "error" ? [String(s.message.code)] : []));
    expect(refusals).toEqual(new Array(6).fill("too_large"));
  });

  test("stored past a ceiling by an earlier build read as the ceiling, and don't lock the account's settings", async () => {
    const host = new FakeHost();
    // What an earlier build took and wrote: one value of its own, and a group put whole.
    const stored = {
      v: 1,
      rev: 3,
      own: [
        { path: ["transport", "link", "joinHeldUnits"], value: 1024 * MI },
        { path: ["transport", "live"], value: { events: 1_000_000, page: 500, chats: 1024, lostMs: 30_000 } },
      ],
      texts: {},
    };
    await host.storage.write("settings.json", JSON.stringify(stored), USER);
    const { backend, page } = made(host);

    const read = await backend.settings.transport(USER);
    expect(read.link.joinHeldUnits).toBe(CEILINGS.joinHeldUnits);
    expect(read.live).toEqual({ events: CEILINGS.liveEvents, page: 500, chats: CEILINGS.liveChats, lostMs: 30_000 });

    // A change of another setting goes through, and what the page is shown is what stands.
    const changed = await page.request("lah.settings.set", { set: [{ path: ["transport", "history", "count"], value: 12 }], reset: [] });
    expect(changed.settings.values).toMatchObject({ transport: { history: { count: 12 }, link: { joinHeldUnits: CEILINGS.joinHeldUnits }, live: { events: CEILINGS.liveEvents, chats: CEILINGS.liveChats } } });
    await backend.settle();
    expect(host.stored(USER, "settings.json")).toMatchObject({ rev: 4, own: expect.arrayContaining([{ path: ["transport", "link", "joinHeldUnits"], value: CEILINGS.joinHeldUnits }]) });
  });
});

const TUNING = { coalesceMs: 0, keepMs: TRANSPORT_DEFAULTS.streams.keepMs };
const stream = (n: number): string => n.toString(16).padStart(32, "0");

function registry() {
  const clock = { now: 1_000_000 };
  return { clock, streams: new StreamRegistry({ now: () => clock.now, later: () => () => undefined, push: () => false }) };
}

/** What opening a stream was refused with; null when it was opened, or is open already. */
function refusal(open: () => unknown): { code: string; message: string } | null {
  try {
    open();
    return null;
  } catch (error) {
    if (!(error instanceof LinkRefused)) throw error;
    return { code: error.code, message: error.message };
  }
}

describe("the streams held for runtimes", () => {
  test("are no more for one account than its ceiling: the next is refused in words, and another account opens its own", () => {
    const { streams } = registry();
    for (let n = 0; n < CEILINGS.streams; n++) expect(streams.open(USER, "relay-1", stream(n), null, TUNING)).not.toBeNull();

    // Another runtime of the account's opens no more room.
    const refused = refusal(() => streams.open(USER, "relay-2", stream(CEILINGS.streams), null, TUNING));
    expect(refused?.code).toBe("unavailable");
    expect(refused?.message).toContain(`This account already has ${CEILINGS.streams} calls`);
    expect(refused?.message).toContain("Try again once some have ended.");
    expect(streams.size).toBe(CEILINGS.streams);
    // One asked for again is still the call under way, not a refusal.
    expect(streams.open(USER, "relay-1", stream(0), null, TUNING)).toBeNull();

    expect(streams.open("user-joss", "relay-3", stream(0), null, TUNING)).not.toBeNull();
    // One of Mara's is given up: there is room for one more of hers.
    expect(streams.cancel(USER, "relay-1", stream(0), "")).toBe(true);
    expect(streams.open(USER, "relay-2", stream(CEILINGS.streams), null, TUNING)).not.toBeNull();
  });

  test("are no more for all accounts together than the total: the account past it is told the extension is busy", () => {
    const { streams } = registry();
    const each = CEILINGS.streams / 2;
    const accounts = Array.from({ length: CEILINGS.streamsTotal / each }, (_, n) => `user-${n}`);
    for (const account of accounts) for (let n = 0; n < each; n++) streams.open(account, "relay-1", stream(n), null, TUNING);
    expect(streams.size).toBe(CEILINGS.streamsTotal);

    // Brann has none held and is far from his own ceiling.
    const refused = refusal(() => streams.open("user-brann", "relay-1", stream(0), null, TUNING));
    expect(refused?.code).toBe("unavailable");
    expect(refused?.message).toContain("LumiAH is busy");
    expect(refused?.message).toContain("Try again in a moment.");
    expect(streams.size).toBe(CEILINGS.streamsTotal);
  });

  test("keep a finished one whose acknowledgement never came no longer than the ceiling, whatever the account's setting says", () => {
    const { streams, clock } = registry();
    const writer = streams.open(USER, "relay-1", stream(1), null, { coalesceMs: 0, keepMs: 24 * 60 * 60_000 });
    writer?.value({ text: "Okoro keeps it now." });

    clock.now += CEILINGS.streamKeepMs;
    streams.sweep();
    expect(streams.size).toBe(1);
    clock.now += 1;
    streams.sweep();
    expect(streams.size).toBe(0);
  });
});

const job = (id: string, state: JobView["state"], more: Partial<JobView> = {}): JobView => ({ id, chatId: "chat-1", agent: "scribe", task: "Copy the ledger.", state, createdAt: 1, ...more }) as JobView;

/** A jobs board that keeps no notice, and says whose jobs it told the pages had changed. */
function board() {
  const told: string[] = [];
  const jobs = new JobsBoard({ add: async (_userId, notice) => ({ id: "notice-1", at: 0, ...notice }), settle: async () => undefined }, () => 0, async () => TRANSPORT_DEFAULTS.pages.noticeChars);
  jobs.onChange((userId) => told.push(userId));
  const active = (userId: string): string[] => jobs.state(userId, false, false).active.map((j) => j.id);
  return { jobs, told, active };
}

describe("the jobs not yet over that the pages are told of", () => {
  test("are no more for one account than its ceiling: past it the oldest that isn't running is let go, and is heard of again when it changes", async () => {
    const { jobs, active } = board();
    await jobs.took(USER, job("job-running", "running"), "relay-1");
    await jobs.took(USER, job("job-queued", "queued"), "relay-1");
    for (let n = 0; n < CEILINGS.jobsActive - 1; n++) await jobs.took(USER, job(`job-${n}`, "running"), "relay-1");

    expect(active(USER)).toHaveLength(CEILINGS.jobsActive);
    expect(jobs.active(USER, "job-running")).not.toBeNull();
    expect(jobs.active(USER, "job-queued")).toBeNull();
    expect(jobs.runsIn(USER, "job-queued")).toBeNull();

    // It begins: it is among them again, and the account still has no more than the ceiling.
    await jobs.took(USER, job("job-queued", "running"), "relay-1");
    expect(jobs.active(USER, "job-queued")).toMatchObject({ state: "running" });
    expect(active(USER)).toHaveLength(CEILINGS.jobsActive);
  });

  test("are no more for all accounts together than the total: the account with the most gives one up, and its pages are told", async () => {
    const { jobs, told, active } = board();
    const accounts = Array.from({ length: CEILINGS.jobsActiveTotal / CEILINGS.jobsActive }, (_, n) => `user-${n}`);
    for (const account of accounts) for (let n = 0; n < CEILINGS.jobsActive; n++) await jobs.took(account, job(`job-${n}`, "queued"), "relay-1");
    const held = (): number => [...accounts, "user-brann"].reduce((sum, account) => sum + active(account).length, 0);
    expect(held()).toBe(CEILINGS.jobsActiveTotal);
    told.length = 0;

    await jobs.took("user-brann", job("job-brann", "running"), "relay-1");
    expect(held()).toBe(CEILINGS.jobsActiveTotal);
    // Brann's own job is the one just heard of: it stays.
    expect(active("user-brann")).toEqual(["job-brann"]);
    expect(active("user-0")).toHaveLength(CEILINGS.jobsActive - 1);
    expect(told.sort()).toEqual(["user-0", "user-brann"]);
  });
});

describe("what is kept of what a runtime sent", () => {
  test("a notice of a finished job keeps its opening as far as the user's setting, and a short one whole", async () => {
    const { backend, page, refusedAt } = made();
    expect(await refusedAt([{ path: ["transport", "pages", "noticeChars"], value: 40 }])).toBeNull();
    const long = "Ilse closed the lamp room and wrote it in the ledger. ".repeat(400);
    await backend.jobs.took(USER, job("job-long", "done", { opening: long }), "relay-1");
    await backend.jobs.took(USER, job("job-short", "done", { opening: "Okoro keeps it now." }), "relay-1");

    const notices = (await page.request("lah.hello", {})).notices;
    expect(notices.map((n) => [n.jobId, n.text])).toEqual([
      ["job-short", 'The job "Copy the ledger." finished: Okoro keeps it now.'],
      ["job-long", `The job "Copy the ledger." finished: ${long.slice(0, 40).trimEnd()}…`],
    ]);
  });

  test("a tool's name of any length is said back cut, so the refusal held for its runtime stays small", async () => {
    // No tool of the extension's and no MCP tool is asked for: a name that is neither is answered here.
    const tools = new RemoteTools(undefined, {} as Mcp, () => undefined);
    const name = "n".repeat(100_000);
    const call = { name, args: {}, turn: "turn-1", chatId: "", agentId: "main-1", role: "main", callId: "call-1", kind: "new", main: true, above: [] } as RemoteToolCall;

    const out = await tools.call(USER, call, new AbortController().signal);
    expect(out.error).toBe(true);
    expect(out.text).toBe(`There is no tool ${"n".repeat(CEILINGS.nameChars)}… in this extension now. Go on without it.`);
  });
});
