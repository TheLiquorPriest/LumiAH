// Numbers, times and money as every page says them.

import { describe, expect, test } from "bun:test";
import { ago, compact, count, counted, duration, elapsed, money } from "../../src/extension/frontend/format";
import { createStore } from "../../src/extension/frontend/store";

describe("numbers in words", () => {
  test("a count marks its thousands, and is said shortly where room is tight", () => {
    expect(count(18_830)).toBe("18,830");
    expect([980, 1000, 9_940, 18_830, 1_240_000].map(compact)).toEqual(["980", "1.0k", "9.9k", "19k", "1.2M"]);
  });

  test("a count of things names one thing or several", () => {
    expect(counted(1, "call")).toBe("1 call");
    expect(counted(3, "call")).toBe("3 calls");
    expect(counted(0, "entry", "entries")).toBe("0 entries");
    expect(counted(1200, "step")).toBe("1,200 steps");
  });

  test("a span of time is said in the unit that fits it", () => {
    expect([0, 840, 4200, 192_000, 3_840_000].map(duration)).toEqual(["0 ms", "840 ms", "4.2 s", "3 min 12 s", "1 h 4 min"]);
    // A clock that ran back never shows a time under nought.
    expect(duration(-50)).toBe("0 ms");
    // What is under way counts whole seconds, as its clock ticks.
    expect([0, 999, 42_400, 192_300].map((ms) => elapsed(ms, 0))).toEqual(["0 s", "0 s", "42 s", "3 min 12 s"]);
    expect(elapsed(0, 500)).toBe("0 s");
  });

  test("money shows as many places as a small amount needs", () => {
    expect([0, 0.00065, 0.0042, 0.13, 0.125, 0.5, 2.4, 12].map(money)).toEqual(["$0", "$0.00065", "$0.0042", "$0.13", "$0.125", "$0.50", "$2.40", "$12.00"]);
  });

  test("how long ago is said shortly, and never as a time to come", () => {
    const now = Date.UTC(2026, 10, 10, 9, 0, 0);
    expect(ago(now, now - 12_000)).toBe("12 s ago");
    expect(ago(now, now - 3 * 60_000)).toBe("3 min ago");
    expect(ago(now, now - 2 * 3_600_000)).toBe("2 h ago");
    expect(ago(now, now - 3 * 86_400_000)).toStartWith("on ");
    // The backend's clock a little ahead of the page's.
    expect(ago(now, now + 900)).toBe("0 s ago");
  });
});

describe("a value the pages watch", () => {
  test("tells its listeners when it changes, and only then", () => {
    const store = createStore({ page: "live" });
    const heard: string[] = [];
    const off = store.subscribe((value) => heard.push(value.page));
    const same = store.get();
    store.set(same);
    store.update((current) => ({ ...current, page: "settings" }));
    off();
    store.set({ page: "runtime" });
    expect(heard).toEqual(["settings"]);
    expect(store.get().page).toBe("runtime");
  });

  test("a listener that leaves while the others are being told doesn't stop them hearing", () => {
    const store = createStore(0);
    const heard: number[] = [];
    const off = store.subscribe(() => off());
    store.subscribe((value) => heard.push(value));
    store.set(1);
    store.set(2);
    expect(heard).toEqual([1, 2]);
  });
});
