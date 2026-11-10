// Scrolling inside the extension without moving the host around it. `scrollIntoView` scrolls every
// ancestor that can scroll, the host's drawer frame and the page included, which pushes the host's
// tab row and header out of sight. These move only the scroller the pages sit in: in the drawer,
// the host's panel content, which our root sits inside rather than fills. Moved from LumiRPEngine.

/** The nearest ancestor that can scroll vertically. */
export function scrollParent(el: Element): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return node;
  }
  return null;
}

/** Brings `el` into view by scrolling its scroll parent only: "center" puts it in the middle of what shows, "start" puts its top at the top of what shows (under whatever its `scroll-margin-top` says sticks there), "nearest" moves as little as needed. */
export function revealInScroller(el: Element | null, block: "center" | "start" | "nearest" = "nearest"): void {
  if (!el) return;
  const scroller = scrollParent(el);
  if (!scroller) return;
  const covered = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const box = el.getBoundingClientRect();
  const port = scroller.getBoundingClientRect();
  const top = port.top + scroller.clientTop + covered;
  const bottom = port.top + scroller.clientTop + scroller.clientHeight;
  let delta = 0;
  if (block === "center") delta = box.top + box.height / 2 - (top + bottom) / 2;
  else if (block === "start") delta = box.top - top;
  else if (box.top < top) delta = box.top - top;
  else if (box.bottom > bottom) delta = Math.min(box.bottom - bottom, box.top - top);
  if (delta !== 0) scroller.scrollTop += delta;
}

/** Whether a scroller shows its foot: within a pixel, as rounding leaves it. */
export function atFoot(scroller: HTMLElement): boolean {
  return Math.ceil(scroller.scrollTop + scroller.clientHeight) >= scroller.scrollHeight - 1;
}
