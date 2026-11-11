// The Chronicle page's styles (pages/chronicle.tsx): the card for learning the story, the files to
// choose from, and a file's lines. A line that cites messages is a row to press, as tall as any
// pressed thing, with what it cites opening under it. One column on a phone; where there is room,
// the card and the check's summary stand beside the file.

import { WIDE_MIN_PX } from "../layout";

export const CHRONICLE_CSS = `
.lah-chron{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
.lah-chron-col{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
.lah-chron-story,.lah-chron-shown{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;padding:var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-xl);background:var(--lah-card)}
.lah-chron-story-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--lah-s2);min-width:0}
.lah-chron-form{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0;padding-top:var(--lah-s3);border-top:1px solid var(--lah-hairline)}
/* The run follows its newest step by scrolling the nearest box that scrolls: this box, so the page stays where the reader is. Its height is a share of the panel's, never more than the panel shows. What sticks inside it (the run's search bar) sticks to this box's top, not under the page bar, so the two offsets the page gives are none here. */
.lah-chron-run{--lah-stick-top:0px;--lah-bar-h:0px;max-height:min(60vh,32rem);overflow-y:auto;overscroll-behavior:contain;min-width:0;padding:0 var(--lah-s2) var(--lah-s2);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-lg);background:var(--lah-well)}
.lah-chron-files{display:flex;flex-wrap:wrap;gap:var(--lah-s1);min-width:0}
.lah-chron-filehead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--lah-s2);min-width:0}
.lah-chron-filehead>span{flex:1 1 12em;min-width:0;overflow-wrap:anywhere}
.lah-chron-lines{display:flex;flex-direction:column;min-width:0;border:1px solid var(--lah-hairline);border-radius:var(--lah-r-xl);background:var(--lah-card);overflow:hidden}
.lah-chron-hint{padding:var(--lah-s2) var(--lah-s3);border-bottom:1px solid var(--lah-hairline)}
.lah-chron-group{display:flex;flex-direction:column;min-width:0;border-top:1px solid var(--lah-hairline)}
.lah-chron-group:first-child{border-top:0}
.lah-chron-grouphead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--lah-s2);min-width:0;padding:var(--lah-s1) var(--lah-s2) var(--lah-s1) var(--lah-s3);background:var(--lah-well)}
.lah-chron-row{display:flex;flex-direction:column;min-width:0;border-top:1px solid var(--lah-hairline)}
.lah-chron-row:first-child{border-top:0}
.lah-chron-row[data-kind=heading]{background:var(--lah-well);font-weight:600}
.lah-chron-row[data-failed]{box-shadow:inset 3px 0 0 var(--lah-warning)}
.lah-chron-row[data-found]{background:var(--lah-accent-soft)}
.lah-chron-line{display:flex;flex-direction:column;gap:2px;width:100%;min-width:0;padding:var(--lah-s2) var(--lah-s3) var(--lah-s2) calc(var(--lah-s3) + var(--lah-depth,0) * var(--lah-s4));border:0;border-radius:0;background:transparent;color:inherit;font:inherit;text-align:left}
button.lah-chron-line{min-height:max(var(--lah-tap),44px);justify-content:center;transition:background-color var(--lah-fast)}
button.lah-chron-line:hover{background:var(--lah-hover)}
button.lah-chron-line:focus-visible{outline-offset:-2px}
button.lah-chron-line[aria-expanded=true]{background:var(--lah-hover)}
.lah-chron-words{display:flex;gap:var(--lah-s2);min-width:0;overflow-wrap:anywhere}
.lah-chron-words>span:last-child{min-width:0}
.lah-chron-bullet{flex:none;color:var(--lah-dim)}
.lah-chron-cite{margin-left:.25em;padding:0 .3em;border-radius:var(--lah-r);background:var(--lah-accent-soft);color:var(--lah-accent-text);font-size:var(--lah-fs-xs);white-space:nowrap}
.lah-chron-mark{display:flex;align-items:flex-start;gap:var(--lah-s1);min-width:0;font-size:var(--lah-fs-sm);font-weight:400;color:var(--lah-muted)}
.lah-chron-mark>.lah-icon{flex:none;margin-top:2px}
.lah-chron-mark[data-tone=warn]>.lah-icon{color:var(--lah-warn)}
.lah-chron-cited{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0;padding:var(--lah-s2) var(--lah-s3) var(--lah-s3);border-top:1px dashed var(--lah-hairline);background:var(--lah-well);font-weight:400}
.lah-chron-msg{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
.lah-chron-msg-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s2);min-width:0;font-size:var(--lah-fs-sm)}
/* A cited message may be long: it scrolls in its own box, so the line it sits under stays in view. */
.lah-chron-msg-text{margin:0;min-width:0;max-height:16em;overflow-y:auto;overscroll-behavior:contain;padding:var(--lah-s2) var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-lg);background:var(--lah-card);white-space:pre-wrap;overflow-wrap:anywhere}
@container lah (min-width:${WIDE_MIN_PX}px){
.lah-chron{display:grid;grid-template-columns:minmax(280px,380px) minmax(0,1fr);align-items:start;gap:var(--lah-s4)}
}
`;
