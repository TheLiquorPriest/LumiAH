// The tab's shell (shell.tsx): the page bar that stays at the top, the page under it, and the
// two-pane frame Sessions and Settings share. The root is a size container, so every layout rule
// asks the root's own width, never the window's (layout.ts says why). The bar sticks at the host
// panel's very top (--lah-stick-top cancels the panel's top padding, which would otherwise show
// what scrolls through it above the bar) and reaches the panel's edges (--lah-bleed-l/-r, the
// panel's side padding); bars under it stick below it by --lah-bar-h. The root fills the height
// the panel shows (--lah-fill-h), so toasts and the follow button sit at its foot. Content keeps
// clear of the host's chat heads only while they overlap it (--lah-gutter-l/-r).
//
// The root's container gives it layout containment, so nothing inside may be position:fixed (it
// would be placed against the root, not the window): what floats here is sticky instead.

import { STACKED_TABS_MAX_PX, WIDE_MIN_PX } from "../layout";

export const SHELL_CSS = `
.lah-root{--lah-gutter-l:0px;--lah-gutter-r:0px;container:lah / inline-size;display:flex;flex-direction:column;min-height:var(--lah-fill-h,100%);padding:0 var(--lah-gutter-r) 0 var(--lah-gutter-l)}
.lah-bar{position:sticky;top:var(--lah-stick-top,0px);z-index:6;margin:0 calc(-1 * (var(--lah-bleed-r,0px) + var(--lah-gutter-r))) 0 calc(-1 * (var(--lah-bleed-l,0px) + var(--lah-gutter-l)));padding:6px calc(var(--lah-bleed-r,0px) + var(--lah-gutter-r)) 6px calc(var(--lah-bleed-l,0px) + var(--lah-gutter-l));background:var(--lah-bar-bg);border-bottom:1px solid var(--lah-hairline)}
.lah-pages{display:flex;gap:2px;padding:2px;border-radius:var(--lah-r-lg);background:var(--lah-well);box-shadow:inset 0 0 0 1px var(--lah-hairline);min-width:0}
.lah-pages>button{flex:1 1 0;min-width:0;min-height:var(--lah-tap);padding:0 var(--lah-s1);display:flex;align-items:center;justify-content:center;gap:6px;position:relative;border:0;border-radius:calc(var(--lah-r-lg) - 2px);background:transparent;color:var(--lah-muted);font-size:var(--lah-fs-sm);font-weight:500;transition:background-color var(--lah-fast),color var(--lah-fast)}
.lah-pages>button:hover{color:var(--lah-fg)}
.lah-pages>button[aria-selected=true]{background:var(--lah-accent-soft);color:var(--lah-accent-text);font-weight:600;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--lah-accent) 35%,transparent)}
.lah-pages>button>span.lah-pages-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lah-pages>button:focus-visible{outline-offset:-2px}
.lah-pages-dot{position:absolute;top:5px;right:6px}
@container lah (max-width:${STACKED_TABS_MAX_PX}px){.lah-pages>button{flex-direction:column;gap:1px;padding:3px 2px;font-size:var(--lah-fs-xs);min-height:max(var(--lah-tap),44px)}.lah-pages-dot{right:calc(50% - 16px)}}
.lah-page{flex:1;display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0;padding:var(--lah-s3) 0 var(--lah-s4)}
.lah-page:focus{outline:none}
.lah-split{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0;flex:1}
.lah-split-list,.lah-split-detail{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
/* A column that scrolls on its own must scroll, not squeeze what it holds. */
.lah-split-list>*,.lah-split-detail>*{flex-shrink:0}
/* Where a pane's head comes to rest when it is brought to the top (scroll.ts): under the page bar, the page's own gap below it. */
.lah-split-detail{scroll-margin-top:calc(var(--lah-bar-h,0px) + var(--lah-s3))}
.lah-split[data-pane=list]>.lah-split-detail{display:none}
.lah-split[data-pane=detail]>.lah-split-list{display:none}
/* A head's title keeps room to be read: what stands beside it (a long-named button, say) goes under it where the two don't fit, rather than squeezing it to a letter a line. */
.lah-pane-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s2);min-width:0}
.lah-pane-head>.lah-pane-title{flex:1 1 10em;min-width:0;display:flex;flex-direction:column}
.lah-navlist{display:flex;flex-direction:column;min-width:0;border:1px solid var(--lah-hairline);border-radius:var(--lah-r-xl);background:var(--lah-card);overflow:hidden}
.lah-navrow{display:flex;align-items:center;gap:var(--lah-s2);width:100%;min-height:max(var(--lah-tap),44px);padding:var(--lah-s2) var(--lah-s3);border:0;border-top:1px solid var(--lah-hairline);border-radius:0;background:transparent;text-align:left;min-width:0;transition:background-color var(--lah-fast)}
.lah-navrow:first-child{border-top:0}
.lah-navrow:hover{background:var(--lah-hover)}
.lah-navrow:focus-visible{outline-offset:-2px}
.lah-navrow[aria-current=true]{background:var(--lah-accent-soft);box-shadow:inset 3px 0 0 var(--lah-accent)}
.lah-navrow[data-part]{padding-left:calc(var(--lah-s3) + var(--lah-s4))}
.lah-navrow-text{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:1px}
.lah-navrow-title{font-weight:500;overflow-wrap:anywhere}
.lah-navrow-sub{font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-navrow>.lah-chev{color:var(--lah-dim)}
.lah-navhead{padding:var(--lah-s2) var(--lah-s3) var(--lah-s1);font-size:var(--lah-fs-xs);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--lah-muted);border-top:1px solid var(--lah-hairline)}
.lah-navhead:first-child{border-top:0}
@container lah (min-width:${WIDE_MIN_PX}px){
.lah-split{display:grid;grid-template-columns:minmax(240px,300px) minmax(0,1fr);align-items:start;gap:var(--lah-s4)}
.lah-split[data-pane]>.lah-split-list,.lah-split[data-pane]>.lah-split-detail{display:flex}
.lah-split-list{position:sticky;top:calc(var(--lah-stick-top,0px) + var(--lah-bar-h,0px) + var(--lah-s3));max-height:calc(var(--lah-fill-h,100vh) - var(--lah-bar-h,0px) - var(--lah-s4));overflow-y:auto;overscroll-behavior:contain;padding-right:2px}
.lah-back{display:none}
.lah-navrow>.lah-chev{display:none}
}
`;
