// Where a box brought into view comes to rest: under the page bar, wherever the bar sticks. In
// LumiAH's own drawer the bar sticks at the top of what shows; inside an extension that shows
// LumiAH's pages under a bar of its own, below that bar. A box's `scroll-margin-top` is written as
// the sticky parts' `top`s are, and a reveal measures it from where they are measured: the
// scroller's padding edge.

import { describe, expect, test } from "bun:test";
import { revealDelta } from "../../src/extension/frontend/scroll";
import { CSS } from "../../src/extension/frontend/styles";

/** The scroller of the made-up hosts: its box at 40 px from the window's top, 600 px shown, a 12 px top padding. */
const SCROLLER = { top: 40, clientTop: 0, clientHeight: 600, paddingTop: 12 };
/** LumiAH's page bar, and the gap a page keeps below it (`--lah-s3`). */
const BAR = 100;
const GAP = 12;

/** Where a box 900 px down the scroller comes to rest when brought to the top, measured from the top of what shows. */
function rest(stickTop: number): number {
  const box = { top: 900, bottom: 960 };
  const scrolled = revealDelta(box, SCROLLER, stickTop + BAR + GAP, "start");
  return box.top - scrolled - SCROLLER.top;
}

describe("a box brought to the top", () => {
  test("rests under LumiAH's own bar, which sticks at the top of what shows (its stick-top takes the panel's padding back)", () => {
    expect(rest(-SCROLLER.paddingTop)).toBe(BAR + GAP);
  });

  test("rests under LumiAH's bar inside an extension whose own bar sticks above it, not under that extension's bar", () => {
    // LumiRPEngine's Harness tab: its mode bar, 61 px, sticks first; LumiAH's stick-top is the panel's padding taken back, plus that bar.
    const modebar = 61;
    expect(rest(-SCROLLER.paddingTop + modebar)).toBe(modebar + BAR + GAP);
  });

  test("a box already in view isn't moved to come nearer, and one past the foot is brought up just enough", () => {
    expect(revealDelta({ top: 300, bottom: 360 }, SCROLLER, BAR + GAP, "nearest")).toBe(0);
    expect(revealDelta({ top: 700, bottom: 760 }, SCROLLER, BAR + GAP, "nearest")).toBe(760 - (SCROLLER.top + SCROLLER.clientHeight));
  });

  test("every scroll margin of the pages is written as the sticky tops are: from where the bar sticks, then the bar", () => {
    const margins = [...CSS.matchAll(/scroll-margin-top:([^;}]+)/g)].map((m) => m[1]);
    const stickyTops = [...CSS.matchAll(/position:sticky;top:([^;}]+)/g)].map((m) => m[1]);
    expect(margins.length).toBeGreaterThanOrEqual(6);
    for (const margin of margins) expect(margin).toStartWith("calc(var(--lah-stick-top,0px) + var(--lah-bar-h,0px)");
    // The sticky parts under the bar are the pattern they follow.
    expect(stickyTops.filter((top) => top?.startsWith("calc(var(--lah-stick-top,0px) + var(--lah-bar-h,0px)")).length).toBeGreaterThan(0);
  });
});
