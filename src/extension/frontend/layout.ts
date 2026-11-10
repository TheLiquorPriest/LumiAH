// The layout's one rule and its measures. LumiAH's pages sit in whatever room their root has: a
// drawer column (a phone's whole width, a desktop drawer the user can widen), or a panel another
// extension places them in. So the layout follows the root's own width, through CSS container
// queries, and never the window's: Lumiverse scales its UI with CSS zoom, which media queries don't
// see, and a desktop drawer at its default width is as narrow as a phone.

/** A box in the host's layout pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * From this width of the root two panes fit side by side: a list or an outline of at least 240 px
 * beside a reading pane of at least 460 px. The stylesheet's container queries are written from it
 * (styles/shell.ts); CSS can't take a width from a setting, so it is fixed here.
 */
export const WIDE_MIN_PX = 720;

/**
 * Under this width of the root the page bar stacks each tab's icon over its label, so four tabs fit
 * a 360 px phone with their labels whole. Fixed for the same reason as `WIDE_MIN_PX`.
 */
export const STACKED_TABS_MAX_PX = 420;
