// What the Spend and Storage pages say (DESIGN §20): the chart's scale and bars, a table's order,
// a cost whose calls had no price, the period as CSV, a size and an age in words, a cap's bar and
// numbers, and what a sweep will do and did.

import { describe, expect, test } from "bun:test";
import { ago, duration } from "../../src/extension/frontend/format";
import { ageWords, byCost, bytesWords, capView, chartOf, costCell, dayShort, dayWords, fractionOf, lastSweepWords, looseWords, measureWords, percentWords, rowWords, scaleTop, shareOf, spendCsv, spendCsvName, sweepAsk, sweptWords, tokensInWords, unpricedWords } from "../../src/extension/frontend/spend-model";
import type { SpendCap, SpendRow, SpendView, UpkeepView } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const DAY = 86_400_000;
const HOUR = 3_600_000;

const row = (over: Partial<SpendRow>): SpendRow => ({ key: "k", label: "Name", calls: 12, in: 1_204_311, cachedIn: 800_120, out: 3000, cost: 0.42, unpriced: 0, ...over });
const cap = (over: Partial<SpendCap>): SpendCap => ({ path: ["core", "spend", "tokensPerDay"], label: "Tokens a day", unit: "tokens", limit: 2_000_000, used: 1_402_113, reached: false, ...over });
const stored = (over: Partial<UpkeepView>): UpkeepView => ({ kinds: [], total: { count: 0, bytes: 0 }, loose: null, lastSweep: null, sweeping: false, ...over });

describe("the chart", () => {
  test("its scale tops out at a round figure that holds the greatest day", () => {
    expect(scaleTop(0.37)).toBe(0.5);
    expect(scaleTop(1)).toBe(1);
    expect(scaleTop(1.2)).toBe(2);
    expect(scaleTop(2.3)).toBe(2.5);
    expect(scaleTop(7)).toBe(10);
    expect(scaleTop(0.0042)).toBe(0.005);
    expect(scaleTop(1_234_567)).toBe(2_000_000);
  });

  test("with nothing to draw there is no scale", () => {
    expect(scaleTop(0)).toBe(0);
    expect(scaleTop(-3)).toBe(0);
    expect(scaleTop(Number.NaN)).toBe(0);
    const chart = chartOf([row({ key: "2026-11-09", calls: 0, in: 0, cachedIn: 0, out: 0, cost: 0 })], "cost", "en-US");
    expect(chart.top).toBe(0);
    expect(chart.peak).toBeNull();
    expect(chart.bars.map((b) => b.height)).toEqual([0]);
    expect(chart.bars[0]?.words).toBe("Mon, Nov 9: nothing spent");
  });

  test("a bar is as tall as its day's share of the scale, and says its day's figures", () => {
    const days = [row({ key: "2026-11-08", cost: 0.2 }), row({ key: "2026-11-09", cost: 0.37 }), row({ key: "2026-11-10", calls: 0, in: 0, cachedIn: 0, out: 0, cost: 0 })];
    const chart = chartOf(days, "cost", "en-US");
    expect(chart.top).toBe(0.5);
    expect(chart.topWords).toBe("$0.50");
    expect(chart.bars.map((b) => b.key)).toEqual(["2026-11-08", "2026-11-09", "2026-11-10"]);
    expect(chart.bars.map((b) => Number(b.height.toFixed(4)))).toEqual([0.4, 0.74, 0]);
    expect(chart.peak).toBe(1);
    expect(chart.bars[1]?.day).toBe("Mon, Nov 9");
    expect(chart.bars[1]?.words).toBe("Mon, Nov 9: $0.37, 12 calls, 1,204,311 (800,120 cached) tokens in, 3,000 out");
  });

  test("measured in tokens, a day whose calls had no price still shows", () => {
    const chart = chartOf([row({ key: "2026-11-09", cost: 0, unpriced: 12, in: 700_000, cachedIn: 0, out: 100_000 })], "tokens", "en-US");
    expect(chart.top).toBe(1_000_000);
    expect(chart.topWords).toBe("1,000,000 tokens");
    expect(chart.bars[0]?.height).toBe(0.8);
    expect(measureWords(0.25, "cost")).toBe("$0.25");
  });

  test("a day is said with its weekday, shortly on the axis, and a key that is no date as it is", () => {
    expect(dayWords("2026-11-03", "en-US")).toBe("Tue, Nov 3");
    expect(dayShort("2026-11-03", "en-US")).toBe("Nov 3");
    expect(dayWords("total", "en-US")).toBe("total");
    expect(dayShort("", "en-US")).toBe("");
  });
});

describe("a row's figures", () => {
  test("a cost whose calls all had a price is the sum; with some unpriced it is at least that; with none priced there is no price", () => {
    expect(costCell(row({}))).toBe("$0.42");
    expect(costCell(row({ unpriced: 2 }))).toBe("at least $0.42");
    expect(costCell(row({ unpriced: 12, cost: 0 }))).toBe("no price");
    expect(costCell(row({ calls: 0, cost: 0 }))).toBe("$0");
  });

  test("calls without a price are said with what they mean for the total", () => {
    expect(unpricedWords(row({}))).toBeNull();
    expect(unpricedWords(row({ unpriced: 1 }))).toBe("1 call had no price, so the total is at least this.");
    expect(unpricedWords(row({ unpriced: 1204 }))).toBe("1,204 calls had no price, so the total is at least this.");
  });

  test("tokens in say how many were read from the cache, when any were", () => {
    expect(tokensInWords(row({}))).toBe("1,204,311 (800,120 cached)");
    expect(tokensInWords(row({ cachedIn: 0 }))).toBe("1,204,311");
  });

  test("a row in a sentence", () => {
    expect(rowWords(row({ unpriced: 2 }))).toBe("at least $0.42, 12 calls, 1,204,311 (800,120 cached) tokens in, 3,000 out, 2 calls had no price");
    expect(rowWords(row({ unpriced: 12, cost: 0, calls: 12 }))).toBe("no price, 12 calls, 1,204,311 (800,120 cached) tokens in, 3,000 out");
    expect(rowWords(row({ calls: 0 }))).toBe("nothing spent");
  });

  test("a table reads the costliest first, and rows of one cost keep one order", () => {
    const rows = [row({ key: "b", label: "Brann", cost: 0.1 }), row({ key: "m", label: "Mara", cost: 2 }), row({ key: "o", label: "Okoro", cost: 0.1, in: 9_000_000 }), row({ key: "a", label: "Brann", cost: 0.1 })];
    expect(byCost(rows).map((r) => r.key)).toEqual(["m", "o", "a", "b"]);
    expect(byCost([...rows].reverse()).map((r) => r.key)).toEqual(["m", "o", "a", "b"]);
    // The rows given are left as they were.
    expect(rows.map((r) => r.key)).toEqual(["b", "m", "o", "a"]);
  });
});

describe("the period as CSV", () => {
  const view: SpendView = {
    days: [row({ key: "2026-11-09", label: "2026-11-09", calls: 1, in: 10, cachedIn: 4, out: 2, cost: 0.1 }), row({ key: "2026-11-10", label: "2026-11-10", calls: 2, in: 20, cachedIn: 0, out: 4, cost: 0.2, unpriced: 1 })],
    chats: [row({ key: "chat-brann", label: "=SUM(A1)", calls: 1, in: 10, cachedIn: 4, out: 2, cost: 0.1 }), row({ key: "chat-mara", label: 'Mara, "the pilot"', calls: 2, in: 20, cachedIn: 0, out: 4, cost: 0.2, unpriced: 1 })],
    agents: [row({ key: "main", label: "Main agent", calls: 3, in: 30, cachedIn: 4, out: 6, cost: 0.1 + 0.2, unpriced: 1 })],
    connections: [row({ key: "conn-deepseek", label: "Deepseek", calls: 3, in: 30, cachedIn: 4, out: 6, cost: 0.1 + 0.2, unpriced: 1 })],
    models: [row({ key: "deepseek-v4-flash", label: "deepseek-v4-flash", calls: 3, in: 30, cachedIn: 4, out: 6, cost: 0.1 + 0.2, unpriced: 1 })],
    total: row({ key: "total", label: "The last 2 days", calls: 3, in: 30, cachedIn: 4, out: 6, cost: 0.1 + 0.2, unpriced: 1 }),
    caps: [],
  };

  test("has a row for each day, chat, agent, connection and model and one for the total, each named by its group", () => {
    expect(spendCsv(view)).toBe(
      [
        "group,key,name,calls,tokens_in,cached_in,tokens_out,cost_usd,unpriced_calls",
        "day,2026-11-09,2026-11-09,1,10,4,2,0.1,0",
        "day,2026-11-10,2026-11-10,2,20,0,4,0.2,1",
        // The costlier chat first; a name with a comma and quotes is quoted, and one a spreadsheet would run as a formula is led by an apostrophe.
        'chat,chat-mara,"Mara, ""the pilot""",2,20,0,4,0.2,1',
        "chat,chat-brann,'=SUM(A1),1,10,4,2,0.1,0",
        "agent,main,Main agent,3,30,4,6,0.3,1",
        "connection,conn-deepseek,Deepseek,3,30,4,6,0.3,1",
        "model,deepseek-v4-flash,deepseek-v4-flash,3,30,4,6,0.3,1",
        "total,total,The last 2 days,3,30,4,6,0.3,1",
        "",
      ].join("\n"),
    );
  });

  test("its file is named by its days and its last day", () => {
    expect(spendCsvName(view)).toBe("lumiah-spend-2-days-to-2026-11-10.csv");
    expect(spendCsvName({ ...view, days: [] })).toBe("lumiah-spend-0-days.csv");
  });
});

describe("a size and an age in words", () => {
  test("a size is said in the unit that fits it", () => {
    expect(bytesWords(0)).toBe("0 bytes");
    expect(bytesWords(1)).toBe("1 byte");
    expect(bytesWords(812)).toBe("812 bytes");
    expect(bytesWords(1024)).toBe("1 KB");
    expect(bytesWords(1229)).toBe("1.2 KB");
    expect(bytesWords(64_300_000)).toBe("61.3 MB");
    expect(bytesWords(1_116_691_497)).toBe("1.04 GB");
    // What rounds up to a whole unit is said in the unit above.
    expect(bytesWords(1_048_575)).toBe("1 MB");
    expect(bytesWords(-5)).toBe("0 bytes");
  });

  test("an age is said in minutes, hours, then days", () => {
    expect(ageWords(T0, T0 - 5 * 60_000)).toBe("5 min");
    expect(ageWords(T0, T0 - 7 * HOUR)).toBe("7 h");
    expect(ageWords(T0, T0 - 47 * HOUR)).toBe("47 h");
    expect(ageWords(T0, T0 - 41 * DAY - 5 * HOUR)).toBe("41 days");
    expect(ageWords(T0, T0 + HOUR)).toBe("0 min");
  });

  test("a kind's share of what is stored", () => {
    expect(shareOf(25, 100)).toBe(0.25);
    expect(shareOf(5, 0)).toBe(0);
    expect(shareOf(500, 100)).toBe(1);
  });
});

describe("a cap", () => {
  test("its share is never said to be used up before it is", () => {
    expect(fractionOf(1, 4)).toBe(0.25);
    expect(fractionOf(9, 4)).toBe(1);
    expect(fractionOf(0, 0)).toBe(1);
    expect(percentWords(0)).toBe("0%");
    expect(percentWords(0.004)).toBe("<1%");
    expect(percentWords(0.379)).toBe("37%");
    expect(percentWords(0.999)).toBe("99%");
    expect(percentWords(1)).toBe("100%");
    expect(percentWords(1.4)).toBe("100%");
  });

  test("says what was used of its limit, in its own unit", () => {
    const tokens = capView(cap({}));
    expect(tokens.words).toBe("1,402,113 of 2,000,000 tokens used (70%).");
    expect(tokens.reached).toBe(false);
    expect(Number(tokens.fraction?.toFixed(3))).toBe(0.701);
    expect(capView(cap({ unit: "usd", limit: 0.5, used: 0.53, reached: true }))).toEqual({ fraction: 1, reached: true, words: "$0.53 of $0.50 used (100%)." });
    expect(capView(cap({ unit: "calls", limit: 10, used: 3 })).words).toBe("3 of 10 calls used (30%).");
    expect(capView(cap({ unit: "ms", limit: 600_000, used: 90_000 })).words).toBe(`${duration(90_000)} of ${duration(600_000)} used (15%).`);
  });

  test("with no limit set has no bar, and says so", () => {
    expect(capView(cap({ limit: null }))).toEqual({ fraction: null, reached: false, words: "1,402,113 tokens used. No limit is set." });
    expect(capView(cap({ unit: "usd", limit: null, used: 0 })).words).toBe("$0 used. No limit is set.");
  });
});

describe("the sweep", () => {
  test("the blobs nothing refers to are said as last counted", () => {
    const at = T0 - 26 * HOUR;
    expect(looseWords(null, T0)).toBe("Not counted yet: a sweep counts them.");
    expect(looseWords({ count: 0, bytes: 0, at }, T0)).toBe(`None, as counted ${ago(T0, at)}.`);
    expect(looseWords({ count: 23, bytes: 655_000, at }, T0)).toBe(`23 blobs (640 KB), as counted ${ago(T0, at)}.`);
    expect(looseWords({ count: 1, bytes: 12, at: T0 - 120_000 }, T0)).toBe("1 blob (12 bytes), as counted 2 min ago.");
  });

  test("the last sweep says when it ran, what it removed and how long it took", () => {
    const at = T0 - 5 * 60_000;
    expect(lastSweepWords(null, T0)).toBe("No sweep has run yet.");
    expect(lastSweepWords({ at, removed: 318, bytes: 5_450_000, ms: 1840 }, T0)).toBe("The last sweep ran 5 min ago: it removed 318 stored things (5.2 MB), in 1.8 s.");
    expect(lastSweepWords({ at, removed: 0, bytes: 0, ms: 420 }, T0)).toBe("The last sweep ran 5 min ago: it found nothing to remove, in 420 ms.");
  });

  test("a sweep that just ran says what it did", () => {
    expect(sweptWords(stored({ lastSweep: { at: T0, removed: 1372, bytes: 23_700_000, ms: 2000 } }))).toBe("Swept in 2.0 s: removed 1,372 stored things, 22.6 MB.");
    expect(sweptWords(stored({ lastSweep: { at: T0, removed: 1, bytes: 900, ms: 2000 } }))).toBe("Swept in 2.0 s: removed 1 stored thing, 900 bytes.");
    expect(sweptWords(stored({ lastSweep: { at: T0, removed: 0, bytes: 0, ms: 300 } }))).toBe("Swept in 300 ms: there was nothing to remove.");
    expect(sweptWords(stored({}))).toBe("The sweep ran.");
  });

  test("before one runs, the page says what it removes and that it can't be undone", () => {
    const counted = sweepAsk(stored({ loose: { count: 23, bytes: 655_000, at: T0 } }));
    expect(counted).toContain("what Settings no longer keep");
    expect(counted).toContain("the blobs nothing refers to (23 blobs, 640 KB when last counted)");
    expect(counted).toContain("can't be brought back");
    expect(sweepAsk(stored({}))).toContain("the blobs nothing refers to (not counted yet)");
    expect(sweepAsk(stored({ loose: { count: 0, bytes: 0, at: T0 } }))).toContain("the blobs nothing refers to (none when last counted)");
  });
});
