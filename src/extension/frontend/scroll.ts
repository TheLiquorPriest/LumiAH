// Scrolling inside the extension without moving the host around it. `scrollIntoView` scrolls every
// ancestor that can scroll, the host's drawer frame and the page included, which pushes the host's
// tab row and header out of sight. These move only the scroller the pages sit in: in the drawer,
// the host's panel content, which our root sits inside rather than fills. Moved from LumiRPEngine.

import type { App } from "./app";
import { createStore, type Store } from "./store";

/** The nearest ancestor that can scroll vertically. */
export function scrollParent(el: Element): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return node;
  }
  return null;
}

/** A scroller as a reveal measures it, in the window's pixels: its box's top, its top border, the height it shows, and its top padding. */
export interface ScrollerBox {
  top: number;
  clientTop: number;
  clientHeight: number;
  paddingTop: number;
}

/**
 * How far to scroll `scroller` (positive: down) so a box shows as `block` asks: "center" in the
 * middle of what shows, "start" with its top where a box brought to the top comes to rest,
 * "nearest" moved as little as needed. That rest is below the scroller's top border and its top
 * padding, which a sticky part's `top` is measured from too, by the box's `scroll-margin-top`
 * (`marginTop`), written as such a `top` is (the styles: under the page bar, and under a host's bar
 * above it). Pure, so it is tested without a browser.
 */
export function revealDelta(box: { top: number; bottom: number }, scroller: ScrollerBox, marginTop: number, block: "center" | "start" | "nearest"): number {
  const top = scroller.top + scroller.clientTop + scroller.paddingTop + marginTop;
  const bottom = scroller.top + scroller.clientTop + scroller.clientHeight;
  if (block === "center") return (box.top + box.bottom) / 2 - (top + bottom) / 2;
  if (block === "start" || box.top < top) return box.top - top;
  if (box.bottom > bottom) return Math.min(box.bottom - bottom, box.top - top);
  return 0;
}

/** Brings `el` into view by scrolling its scroll parent only, as `revealDelta` says. */
export function revealInScroller(el: Element | null, block: "center" | "start" | "nearest" = "nearest"): void {
  if (!el) return;
  const scroller = scrollParent(el);
  if (!scroller) return;
  const port = scroller.getBoundingClientRect();
  const measured = { top: port.top, clientTop: scroller.clientTop, clientHeight: scroller.clientHeight, paddingTop: parseFloat(getComputedStyle(scroller).paddingTop) || 0 };
  const delta = revealDelta(el.getBoundingClientRect(), measured, parseFloat(getComputedStyle(el).scrollMarginTop) || 0, block);
  if (delta !== 0) scroller.scrollTop += delta;
}

/** Whether a scroller shows its foot: within a pixel, as rounding leaves it. */
export function atFoot(scroller: HTMLElement): boolean {
  return Math.ceil(scroller.scrollTop + scroller.clientHeight) >= scroller.scrollHeight - 1;
}

const MEASURED = new WeakMap<App, Store<boolean>>();

/**
 * Whether the shell has measured its page bar (`--lah-bar-h`, and where the bar sticks) since it was
 * mounted. A page's own effects run before the shell's, so a reveal a freshly mounted page makes at
 * once would land under a bar of no height: it waits for this.
 */
export function barMeasured(app: App): Store<boolean> {
  let measured = MEASURED.get(app);
  if (measured === undefined) {
    measured = createStore(false);
    MEASURED.set(app, measured);
  }
  return measured;
}
