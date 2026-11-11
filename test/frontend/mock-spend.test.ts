// The stand-in backend's spend and storage (DESIGN §20): each request answers, the figures add up
// whichever way they are grouped, a cap follows its setting, a sweep takes a while and leaves less
// stored, and what the real backend would refuse is refused.

import { describe, expect, test } from "bun:test";
import { type MockCtx, MOCK_AGENTS, Refusal } from "../../dev/preview/mock/ctx";
import { HISTORY_DAYS, MOST_DAYS, spendMock, SWEEP_MS } from "../../dev/preview/mock/spend";
import { type JsonObject, type JsonValue, type SettingPath, type SpendRow, type SpendView, UI_VERSION, type UiRequest, type UiState, type UpkeepView } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const DAY = 86_400_000;

const limit = { type: ["integer", "null"] };

/** Settings shaped as LumiAH's own are where the mock looks: the caps and the keep times, each at its default. */
const ownSettings = (): { values: JsonObject; schema: JsonObject } => ({
  values: { core: { spend: { tokensPerDay: null, costPerDay: null }, jobs: { tokensPerDay: null }, keep: { promptDays: 30, transcriptDays: 90, spanDays: null } } },
  schema: {
    type: "object",
    properties: {
      core: {
        type: "object",
        properties: {
          spend: { type: "object", properties: { tokensPerDay: limit, costPerDay: { type: ["number", "null"] } } },
          jobs: { type: "object", properties: { tokensPerDay: limit } },
          keep: { type: "object", properties: { promptDays: limit, transcriptDays: limit, spanDays: limit } },
        },
      },
    },
  },
});

/** The preview's made-up settings: none of LumiAH's own is among them. */
const sampleSettings = (): { values: JsonObject; schema: JsonObject } => ({ values: { sample: { size: 3 } }, schema: { type: "object", properties: { sample: { type: "object", properties: { size: { type: "integer" } } } } } });

/** A request with no body, as it crosses. Its type says it holds nothing beside its envelope, which no object written out with one satisfies, so it is told so here once. */
const bare = <K extends "lah.upkeep.get" | "lah.upkeep.sweep">(type: K) => ({ lah: UI_VERSION, type, reqId: "r" }) as unknown as Extract<UiRequest, { type: K }>;

/** A mock part's surroundings built by hand: a clock the test turns, settings that keep what is set, and the rest refusing to be used, since spend and storage use none of it. */
function world(over: { ready?: boolean; settings?: { values: JsonObject; schema: JsonObject } } = {}) {
  let now = T0;
  let timers: { at: number; fn: () => void }[] = [];
  const settings = over.settings ?? ownSettings();
  const unused = (): never => {
    throw new Error("spend and storage don't use this");
  };
  const put = (path: SettingPath, value: JsonValue): void => {
    let at: JsonValue | undefined = settings.values;
    for (const key of path.slice(0, -1)) at = typeof at === "object" && at !== null && !Array.isArray(at) ? at[key] : undefined;
    const last = path.at(-1);
    if (last === undefined || typeof at !== "object" || at === null || Array.isArray(at)) throw new Refusal("invalid", "No such setting.");
    at[last] = value;
  };
  // The mock reads the state's chats and settings only; the rest of a state is left out.
  const state = { rev: 1, chats: [{ chatId: "chat-mara", name: "Mara at the harbour", on: true, since: T0, connection: null }], settings: { values: settings.values, defaults: {}, schema: settings.schema } } as unknown as UiState;
  const ctx: MockCtx = {
    now: () => now,
    later: (fn, ms) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
    ready: over.ready ?? true,
    state: () => state,
    push: unused,
    blobs: { put: unused, set: unused, get: unused },
    play: unused,
    stop: unused,
    pause: unused,
    settings: (set) => {
      for (const s of set) put(s.path, s.value);
    },
    keep: unused,
  };
  const mock = spendMock(ctx);
  /** Turns the clock on by `ms`, running what falls due in order, with promises settled between. */
  const pass = async (ms = 0): Promise<void> => {
    const until = now + ms;
    for (;;) {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = Math.max(now, due.at);
      due.fn();
    }
    now = until;
  };
  return {
    pass,
    put,
    settings,
    spend: (days: number): SpendView | Promise<SpendView> => mock["lah.spend.get"]({ lah: UI_VERSION, type: "lah.spend.get", reqId: "r", days }),
    stored: (): UpkeepView | Promise<UpkeepView> => mock["lah.upkeep.get"](bare("lah.upkeep.get")),
    sweep: (): UpkeepView | Promise<UpkeepView> => mock["lah.upkeep.sweep"](bare("lah.upkeep.sweep")),
  };
}

/** What a request was refused with; null when it wasn't. */
function refused(ask: () => unknown): Refusal | null {
  try {
    ask();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  return null;
}

const FIGURES = ["calls", "in", "cachedIn", "out", "unpriced"] as const;

/** Rows added up: whole figures exactly, the cost to a millionth of a cent. */
function sumOf(rows: readonly SpendRow[]): Omit<SpendRow, "key" | "label"> {
  const sum = { calls: 0, in: 0, cachedIn: 0, out: 0, cost: 0, unpriced: 0 };
  for (const r of rows) {
    for (const f of FIGURES) sum[f] += r[f];
    sum.cost += r.cost;
  }
  return sum;
}

function expectSums(rows: readonly SpendRow[], total: SpendRow): void {
  const sum = sumOf(rows);
  for (const f of FIGURES) expect(sum[f]).toBe(total[f]);
  expect(sum.cost).toBeCloseTo(total.cost, 8);
}

describe("spend", () => {
  test("a period has a row a day, oldest first, today the last", async () => {
    const w = world();
    const view = await w.spend(30);
    expect(view.days.length).toBe(30);
    expect(view.days.at(-1)?.key).toBe("2026-11-10");
    expect(view.days[0]?.key).toBe(new Date(T0 - 29 * DAY).toISOString().slice(0, 10));
    expect(view.days.map((d) => d.key)).toEqual([...view.days.map((d) => d.key)].sort());
    expect(view.total.calls).toBeGreaterThan(0);
  });

  test("the days, the chats, the agents, the connections and the models each add up to the total", async () => {
    const w = world();
    for (const days of [7, 30, 90]) {
      const view = await w.spend(days);
      for (const rows of [view.days, view.chats, view.agents, view.connections, view.models]) expectSums(rows, view.total);
    }
  });

  test("a longer period holds a shorter one, and nothing was spent before the story began", async () => {
    const w = world();
    const week = await w.spend(7);
    const month = await w.spend(30);
    const quarter = await w.spend(HISTORY_DAYS);
    const longer = await w.spend(HISTORY_DAYS + 30);
    expect(month.total.calls).toBeGreaterThan(week.total.calls);
    expect(quarter.total.calls).toBeGreaterThan(month.total.calls);
    expect(month.days.slice(-7)).toEqual(week.days);
    expect(longer.total.calls).toBe(quarter.total.calls);
    expect(longer.days.length).toBe(HISTORY_DAYS + 30);
    expect(longer.days.slice(0, 30).every((d) => d.calls === 0 && d.cost === 0)).toBe(true);
  });

  test("the rows are the story's chats, agents, connections and models, by name", async () => {
    const view = await world().spend(90);
    expect(view.chats.map((r) => r.key).sort()).toEqual(["chat-brann", "chat-mara", "chat-okoro"]);
    expect(view.chats.find((r) => r.key === "chat-mara")?.label).toBe("Mara at the harbour");
    expect(view.agents.every((r) => MOCK_AGENTS.some((a) => a.id === r.key && a.name === r.label))).toBe(true);
    expect(view.agents.length).toBe(MOCK_AGENTS.length);
    expect(view.connections.map((r) => `${r.key}=${r.label}`).sort()).toEqual(["conn-deepseek=Deepseek", "conn-local=Local llama"]);
    expect(view.models.map((r) => r.key).sort()).toEqual(["deepseek-v4-flash", "deepseek-v4-pro", "llama-local"]);
  });

  test("some calls had no price: a local model's all, the total's some", async () => {
    const view = await world().spend(30);
    const local = view.models.find((r) => r.key === "llama-local");
    expect(local?.unpriced).toBe(local?.calls ?? -1);
    expect(local?.cost).toBe(0);
    expect(view.models.find((r) => r.key === "deepseek-v4-pro")?.unpriced).toBe(0);
    expect(view.total.unpriced).toBeGreaterThan(0);
    expect(view.total.unpriced).toBeLessThan(view.total.calls);
    expect(view.total.cachedIn).toBeLessThan(view.total.in);
  });

  test("the story's caps are written to the settings, and one of them is reached", async () => {
    const w = world();
    await w.pass(0);
    expect(w.settings.values).toMatchObject({ core: { spend: { tokensPerDay: 2_000_000, costPerDay: 0.5 }, jobs: { tokensPerDay: 400_000 } } });
    const { caps, days } = await w.spend(7);
    expect(caps.map((c) => c.path.join("."))).toEqual(["core.spend.tokensPerDay", "core.spend.costPerDay", "core.jobs.tokensPerDay"]);
    const [tokens, cost, jobs] = caps;
    const today = days.at(-1);
    // What a cap counts is today's spend, as the day's row has it.
    expect(tokens?.used).toBe((today?.in ?? 0) + (today?.out ?? 0));
    expect(cost?.used).toBe(today?.cost ?? -1);
    expect(tokens).toMatchObject({ unit: "tokens", limit: 2_000_000, reached: false });
    expect(cost).toMatchObject({ unit: "usd", limit: 0.5, reached: true });
    expect(jobs).toMatchObject({ unit: "tokens", limit: 400_000, reached: false });
    expect(jobs?.used).toBeGreaterThan(0);
    expect(jobs?.used).toBeLessThan(tokens?.used ?? 0);
  });

  test("a cap follows its setting: raised it is no longer reached, cleared it has no limit", async () => {
    const w = world();
    await w.pass(0);
    w.put(["core", "spend", "costPerDay"], 5);
    expect((await w.spend(7)).caps[1]).toMatchObject({ limit: 5, reached: false });
    w.put(["core", "spend", "costPerDay"], null);
    expect((await w.spend(7)).caps[1]).toMatchObject({ limit: null, reached: false });
    // A limit cleared by the user stays cleared: the story's is written once, as the preview starts.
    await w.pass(60_000);
    expect((await w.spend(7)).caps[1]?.limit).toBeNull();
  });

  test("where the settings have no such caps, the story's own limits show and nothing is written", async () => {
    const w = world({ settings: sampleSettings() });
    await w.pass(0);
    expect(w.settings.values).toEqual({ sample: { size: 3 } });
    expect((await w.spend(7)).caps.map((c) => c.limit)).toEqual([2_000_000, 0.5, 400_000]);
  });

  test("a period without end is refused, in words that say what to ask for", () => {
    const w = world();
    const no = refused(() => w.spend(MOST_DAYS + 1));
    expect(no?.code).toBe("invalid");
    expect(no?.message).toBe(`Ask for at most ${MOST_DAYS} days of spend.`);
    expect(no?.problems).toEqual([{ path: ["days"], message: `At most ${MOST_DAYS}.` }]);
    expect(refused(() => w.spend(MOST_DAYS))).toBeNull();
  });

  test("before anything is set up nothing was spent, and no cap is written", async () => {
    const w = world({ ready: false });
    await w.pass(0);
    const view = await w.spend(30);
    expect(view.days.length).toBe(30);
    expect(view.total).toMatchObject({ calls: 0, in: 0, out: 0, cost: 0, unpriced: 0 });
    expect([view.chats, view.agents, view.connections, view.models]).toEqual([[], [], [], []]);
    expect(view.caps.map((c) => [c.limit, c.used, c.reached])).toEqual([
      [null, 0, false],
      [null, 0, false],
      [null, 0, false],
    ]);
  });
});

describe("storage", () => {
  test("each kind says how many, how big, its oldest and how long Settings keep it; the total is their sum", async () => {
    const w = world();
    const view = await w.stored();
    expect(view.kinds.map((k) => k.kind)).toEqual(["prompt", "transcript", "segment", "file", "report"]);
    expect(view.total.count).toBe(view.kinds.reduce((n, k) => n + k.count, 0));
    expect(view.total.bytes).toBe(view.kinds.reduce((n, k) => n + k.bytes, 0));
    expect(view.kinds.every((k) => k.count > 0 && k.bytes > 0 && k.oldestAt !== null && k.oldestAt < T0)).toBe(true);
    expect(view.kinds.map((k) => (k.kept ? `${k.kept.path.join(".")}: ${k.kept.words}` : null))).toEqual(["core.keep.promptDays: 30 days", "core.keep.transcriptDays: 90 days", "core.keep.spanDays: No limit", null, null]);
    expect(view.loose).toMatchObject({ count: 23 });
    expect(view.lastSweep?.removed).toBeGreaterThan(0);
    expect(view.sweeping).toBe(false);
  });

  test("how long a kind is kept follows its setting", async () => {
    const w = world();
    w.put(["core", "keep", "promptDays"], 1);
    w.put(["core", "keep", "transcriptDays"], null);
    const view = await w.stored();
    expect(view.kinds.map((k) => k.kept?.words ?? null)).toEqual(["1 day", "No limit", "No limit", null, null]);
  });

  test("a sweep takes a while, says so meanwhile, and leaves less stored and nothing loose", async () => {
    const w = world();
    const before = await w.stored();
    let after: UpkeepView | null = null;
    void Promise.resolve(w.sweep()).then((view) => {
      after = view;
    });
    await w.pass(SWEEP_MS - 1);
    expect(after).toBeNull();
    expect((await w.stored()).sweeping).toBe(true);
    // A second sweep while one runs is refused.
    const no = refused(() => w.sweep());
    expect(no?.code).toBe("conflict");
    expect(no?.message).toContain("already running");
    await w.pass(1);
    const done: UpkeepView = after ?? before;
    expect(done).not.toBe(before);
    expect(done.sweeping).toBe(false);
    expect(done).toEqual(await w.stored());
    expect(done.loose).toEqual({ count: 0, bytes: 0, at: T0 + SWEEP_MS });
    expect(done.lastSweep).toMatchObject({ at: T0 + SWEEP_MS, ms: SWEEP_MS });
    // What went is what was loose and what was older than its kind is kept.
    expect(done.lastSweep?.removed).toBe(before.total.count - done.total.count + (before.loose?.count ?? 0));
    expect(done.lastSweep?.bytes).toBe(before.total.bytes - done.total.bytes + (before.loose?.bytes ?? 0));
    expect(done.total.count).toBeLessThan(before.total.count);
    const kind = (view: UpkeepView, id: string) => view.kinds.find((k) => k.kind === id);
    expect(kind(done, "prompt")?.count).toBeLessThan(kind(before, "prompt")?.count ?? 0);
    expect(kind(done, "prompt")?.oldestAt).toBe(T0 + SWEEP_MS - 30 * DAY);
    expect(kind(done, "transcript")?.count).toBeLessThan(kind(before, "transcript")?.count ?? 0);
    // What has no keep time, or none set, is left whole.
    for (const id of ["segment", "file", "report"]) expect(kind(done, id)).toEqual(kind(before, id));
  });

  test("a sweep straight after one finds nothing to remove", async () => {
    const w = world();
    void w.sweep();
    await w.pass(SWEEP_MS);
    const first = await w.stored();
    void w.sweep();
    await w.pass(SWEEP_MS);
    const second = await w.stored();
    expect(second.lastSweep).toMatchObject({ removed: 0, bytes: 0 });
    expect(second.total).toEqual(first.total);
  });

  test("before anything is set up nothing is stored, nothing counted, and a sweep removes nothing", async () => {
    const w = world({ ready: false });
    const view = await w.stored();
    expect(view.kinds.length).toBe(5);
    expect(view.kinds.every((k) => k.count === 0 && k.bytes === 0 && k.oldestAt === null)).toBe(true);
    expect(view).toMatchObject({ total: { count: 0, bytes: 0 }, loose: null, lastSweep: null, sweeping: false });
    void w.sweep();
    await w.pass(SWEEP_MS);
    expect(await w.stored()).toMatchObject({ total: { count: 0, bytes: 0 }, loose: { count: 0, bytes: 0 }, lastSweep: { removed: 0, bytes: 0 } });
  });
});

test("the contract's sequence: a month's spend, what is stored, and a sweep that answers within ten seconds", async () => {
  const w = world();
  expect((await w.spend(30)).days.length).toBe(30);
  await w.pass(10_000);
  expect((await w.stored()).kinds.length).toBeGreaterThan(0);
  await w.pass(10_000);
  let answered: UpkeepView | null = null;
  void Promise.resolve(w.sweep()).then((view) => {
    answered = view;
  });
  await w.pass(10_000);
  expect(answered).not.toBeNull();
});
