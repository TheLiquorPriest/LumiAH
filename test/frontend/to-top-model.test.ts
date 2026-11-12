// When a transcript's "Back to top" shows: only where its panel can scroll, and only once the panel
// is a screen and a half down from its top.

import { describe, expect, test } from "bun:test";
import { showsToTop, TO_TOP_SCREENS } from "../../src/extension/frontend/to-top-model";

describe("Back to top", () => {
  test("shows once the panel is a screen and a half down, at a phone's height and a desktop's", () => {
    for (const height of [560, 900]) {
      expect(showsToTop({ top: height * TO_TOP_SCREENS, height, scrollable: true })).toBe(true);
      expect(showsToTop({ top: height * 4, height, scrollable: true })).toBe(true);
    }
  });

  test("stays away nearer the top, and goes again on the way back up", () => {
    expect(showsToTop({ top: 0, height: 600, scrollable: true })).toBe(false);
    expect(showsToTop({ top: 600, height: 600, scrollable: true })).toBe(false);
    expect(showsToTop({ top: 899, height: 600, scrollable: true })).toBe(false);
  });

  test("never shows where the panel can't scroll", () => {
    expect(showsToTop({ top: 2000, height: 600, scrollable: false })).toBe(false);
    expect(showsToTop({ top: 0, height: 600, scrollable: false })).toBe(false);
  });

  test("never shows for a panel that isn't showing", () => {
    expect(showsToTop({ top: 0, height: 0, scrollable: true })).toBe(false);
    expect(showsToTop({ top: 500, height: 0, scrollable: true })).toBe(false);
  });
});
