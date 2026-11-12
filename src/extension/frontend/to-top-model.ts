// "Back to top" in a turn's transcript (transcript.tsx): on a phone a long turn is many screens of
// thumb-scrolling, so once the panel the transcript sits in is well down, one press brings it back
// to the top. LumiRPEngine's own live views show the same button by the same rule, so the two read
// as one thing. Pure of the page: the transcript hands in where its scroller stands.

/** How far down the panel must be, in heights of what shows, before the button shows: a screen and a half, so a short scroll doesn't bring it up. */
export const TO_TOP_SCREENS = 1.5;

/** Where a scroller stands: how far it is scrolled down (px), how tall its view is (px), and whether it holds more than shows. */
export interface ScrollAt {
  top: number;
  height: number;
  scrollable: boolean;
}

/** Whether "Back to top" shows: only where the view can scroll, once it is a screen and a half from its top; nearer the top it goes again. */
export function showsToTop(at: ScrollAt): boolean {
  // A panel that isn't showing (a closed drawer, another tab) has no height: nothing to bring back.
  return at.scrollable && at.height > 0 && at.top >= at.height * TO_TOP_SCREENS;
}
