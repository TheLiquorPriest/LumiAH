// A turn's transcript (transcript.tsx, transcript-views.tsx), as Live and Sessions show it: its head
// with its figures and actions, its outline and filters (a strip above the feed in one column, a
// column beside it where there is room), the search row that stays in view, the feed (each agent a
// group with a rule down its side in its state's colour; each text a block folded under its first
// line; each tool call a card), the totals as cards in one column and as tables where there is
// room, and the events as traced. Texts are monospace and keep their line breaks; everything wraps.

import { STACKED_TABS_MAX_PX, WIDE_MIN_PX } from "../layout";

export const LIVE_CSS = `
.lah-chatbar{display:flex;align-items:center;gap:var(--lah-s2);min-width:0}
.lah-chatbar>.lah-input{flex:1 1 0}
/* A turn lays itself out by its own width, not the page's: beside the Sessions list it has about half the page, where its two columns would squeeze its steps. Where the two columns show (from ${WIDE_MIN_PX} px, room enough that the side column always takes its widest), --lah-side-w is that column's width. */
.lah-turn{container:lah / inline-size;display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0;flex:1;--lah-side-w:280px}
/* "Back to top" leaves focus on the transcript itself (transcript.tsx): it is no control, so it shows no ring. */
.lah-turn:focus{outline:none}
.lah-turn-head{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;padding:var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-xl);background:var(--lah-card)}
.lah-turn-title{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);min-width:0}
.lah-turn-state{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);min-width:0;overflow-wrap:anywhere}
.lah-stats{display:flex;flex-wrap:wrap;gap:var(--lah-s1) var(--lah-s3);min-width:0;font-size:var(--lah-fs-sm);color:var(--lah-muted);font-variant-numeric:tabular-nums}
.lah-stats>span{white-space:nowrap}
.lah-stats b{color:var(--lah-fg);font-weight:600}
.lah-menu{display:flex;flex-direction:column;gap:var(--lah-s1);padding:var(--lah-s2);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-lg);background:var(--lah-well);min-width:0}
.lah-menu>.lah-btn{justify-content:flex-start;text-align:left}
.lah-menu-note{font-size:var(--lah-fs-sm);color:var(--lah-muted);padding:0 var(--lah-s1);overflow-wrap:anywhere}
.lah-turn-grid{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
.lah-turn-side{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-turn-side>*{flex-shrink:0}
.lah-turn>.lah-seg{align-self:flex-start;width:min(100%,420px)}
.lah-turn-main{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-outline{position:relative;display:flex;gap:var(--lah-s1);overflow-x:auto;scrollbar-width:thin;padding-bottom:2px;min-width:0;overscroll-behavior-x:contain}
.lah-outline-row{flex:0 0 auto;max-width:240px;min-height:var(--lah-tap);padding:var(--lah-s1) var(--lah-s3);display:flex;flex-direction:column;justify-content:center;gap:1px;border:1px solid var(--lah-hairline);border-radius:var(--lah-r-lg);background:var(--lah-card);text-align:left;transition:background-color var(--lah-fast)}
.lah-outline-row:hover{background:var(--lah-hover)}
.lah-outline-row[aria-pressed=true]{border-color:var(--lah-accent);background:var(--lah-accent-soft)}
.lah-outline-name{display:flex;align-items:center;gap:6px;font-weight:600;font-size:var(--lah-fs-sm);min-width:0;white-space:nowrap}
.lah-outline-sub{font-size:var(--lah-fs-xs);color:var(--lah-muted);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.lah-filters{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-filters-body{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-filters-body[data-open=false]{display:none}
.lah-filters-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);min-width:0}
.lah-filters-row>.lah-input{flex:1 1 140px}
.lah-turn-search{position:sticky;top:calc(var(--lah-stick-top,0px) + var(--lah-bar-h,0px) + var(--lah-pin-h,0px));z-index:4;display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1);min-width:0;padding:var(--lah-s1) 0;background:var(--lah-bar-bg)}
.lah-turn-search>.lah-search{flex:1 1 150px}
.lah-turn-matches{display:flex;align-items:center;gap:2px;font-size:var(--lah-fs-sm);font-variant-numeric:tabular-nums;white-space:nowrap}
.lah-filters-toggle{display:flex;align-items:center;gap:var(--lah-s1);min-width:0}
.lah-turn-folds{display:flex;align-items:center;gap:var(--lah-s1)}
.lah-filters-toggle>.lah-turn-folds{margin-left:auto}
.lah-turn-search>.lah-turn-folds{display:none}
.lah-feed{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
.lah-mark{color:var(--lah-muted);font-size:var(--lah-fs-sm);text-align:center;overflow-wrap:anywhere;min-width:0}
.lah-mark.lah-session{text-align:left;padding:var(--lah-s2) var(--lah-s3);border:1px dashed var(--lah-border);border-radius:var(--lah-r-lg);display:flex;flex-direction:column;gap:2px}
.lah-mark.lah-ended{text-align:left;font-weight:600;padding:var(--lah-s2) var(--lah-s3);border-radius:var(--lah-r-lg);background:var(--lah-neutral-soft);color:var(--lah-fg)}
.lah-mark.lah-ended[data-lah-ended=failed],.lah-mark.lah-ended[data-lah-ended=lost]{background:var(--lah-neg-soft);color:var(--lah-neg)}
.lah-mark.lah-ended[data-lah-ended=stopped]{background:var(--lah-warn-soft);color:var(--lah-warn)}
.lah-mark.lah-ended[data-lah-ended=done]{background:var(--lah-pos-soft);color:var(--lah-pos)}
.lah-agent{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0;margin-left:calc(min(var(--lah-depth,0),4) * var(--lah-s3));padding-left:var(--lah-s2);border-left:2px solid var(--lah-border)}
.lah-agent[data-state=working]{border-left-color:var(--lah-accent)}
.lah-agent[data-state=done]{border-left-color:color-mix(in srgb,var(--lah-success) 55%,transparent)}
.lah-agent[data-state=failed]{border-left-color:var(--lah-danger)}
.lah-agent[data-state=stopped]{border-left-color:var(--lah-warning)}
.lah-agent-head{display:flex;align-items:center;gap:var(--lah-s1);min-width:0}
.lah-agent-toggle{flex:1 1 0;min-width:0;min-height:var(--lah-tap);display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);padding:2px var(--lah-s1);border:0;border-radius:var(--lah-r);background:transparent;text-align:left}
.lah-agent-toggle:hover{background:var(--lah-hover)}
.lah-agent-toggle[aria-expanded=true]>.lah-caret{transform:rotate(90deg)}
.lah-agent-task{min-width:0;overflow-wrap:anywhere;color:var(--lah-muted)}
.lah-agent-meta{display:flex;flex-wrap:wrap;gap:0 var(--lah-s2);padding:0 var(--lah-s1);font-size:var(--lah-fs-sm);color:var(--lah-muted);font-variant-numeric:tabular-nums;min-width:0;overflow-wrap:anywhere}
.lah-agent-meta>.lah-model{color:var(--lah-fg);font-weight:600}
.lah-agent-body{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
.lah-line{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);padding:2px var(--lah-s1);font-size:var(--lah-fs-sm);min-width:0;overflow-wrap:anywhere}
.lah-line>.lah-icon{align-self:flex-start;margin-top:2px}
.lah-line>.lah-pulse{align-self:flex-start;margin-top:5px}
/* The words share the line with the mark before them and wrap inside their own room; left to their natural width, a long sentence would drop under its mark. */
.lah-line>span:not([class]){flex:1 1 12em;min-width:0}
.lah-line.lah-is-warn{color:var(--lah-warn)}
.lah-line.lah-is-neg{color:var(--lah-neg)}
.lah-call{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);margin-top:var(--lah-s1);padding:var(--lah-s1) var(--lah-s1) 0;border-top:1px solid var(--lah-hairline);font-size:var(--lah-fs-sm);min-width:0}
.lah-call-name{font-weight:600;white-space:nowrap}
.lah-call-name>.lah-arrow{color:var(--lah-accent)}
.lah-call[data-short=true] .lah-call-finish{color:var(--lah-warn);font-weight:600}
.lah-call>.lah-stats{flex:1 1 200px}
.lah-block{min-width:0;border-radius:var(--lah-r)}
.lah-block>summary{display:flex;align-items:center;gap:var(--lah-s2);min-height:var(--lah-tap-sm);padding:0 var(--lah-s1);cursor:pointer;list-style:none;border-radius:var(--lah-r);min-width:0;font-size:var(--lah-fs-sm)}
.lah-block>summary::-webkit-details-marker{display:none}
.lah-block>summary:hover{background:var(--lah-hover)}
.lah-block-title{flex:none;font-weight:600}
.lah-block-preview{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--lah-muted);font-family:var(--lah-mono)}
.lah-block[open]>summary>.lah-block-preview{visibility:hidden}
.lah-block-meta{flex:none;margin-left:auto;font-size:var(--lah-fs-xs);color:var(--lah-dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.lah-hits{flex:none;padding:0 6px;border-radius:var(--lah-r-pill);background:var(--lah-mark);font-size:var(--lah-fs-xs);font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.lah-block-body{display:flex;flex-direction:column;gap:var(--lah-s1);padding:var(--lah-s2) var(--lah-s3);margin:2px 0 var(--lah-s1);border-radius:var(--lah-r);background:var(--lah-well);min-width:0}
.lah-block-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:var(--lah-s1);min-width:0}
.lah-block[data-kind=thinking] .lah-text{color:var(--lah-muted);font-style:italic}
.lah-block[data-kind=said]>summary>.lah-block-title{color:var(--lah-accent-text)}
.lah-block[data-kind=failed]>summary>.lah-block-title{color:var(--lah-neg)}
.lah-block[data-kind=system]>summary>.lah-block-title{color:var(--lah-warn)}
.lah-block[data-kind=assistant]>summary>.lah-block-title{color:var(--lah-pos)}
.lah-block[data-kind=user]>summary>.lah-block-title{color:var(--lah-accent-text)}
.lah-block[data-lah-here]>summary,.lah-tool[data-lah-here]{box-shadow:inset 3px 0 0 var(--lah-mark-now)}
.lah-tools{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
.lah-tool{border:1px solid var(--lah-border);border-radius:var(--lah-r);background:var(--lah-card);overflow:hidden;min-width:0}
.lah-tool>summary{display:flex;align-items:center;gap:var(--lah-s2);min-height:var(--lah-tap-sm);padding:2px var(--lah-s2);cursor:pointer;list-style:none;min-width:0;font-size:var(--lah-fs-sm)}
.lah-tool>summary::-webkit-details-marker{display:none}
.lah-tool>summary:hover{background:var(--lah-hover)}
.lah-tool[data-state=done]>summary>.lah-caret{color:var(--lah-accent)}
.lah-tool[data-state=error]>summary>.lah-caret,.lah-tool[data-state=error] .lah-tool-state{color:var(--lah-neg)}
.lah-tool[data-state=error]{border-color:color-mix(in srgb,var(--lah-danger) 45%,transparent)}
.lah-tool-name{flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--lah-accent-text)}
.lah-tool-preview{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--lah-muted)}
.lah-tool[open]>summary>.lah-tool-preview{visibility:hidden}
.lah-tool-state{flex:none;font-size:var(--lah-fs-xs);font-weight:600;color:var(--lah-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.lah-tool-body{border-top:1px solid var(--lah-hairline);padding:var(--lah-s2);display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
.lah-tool-body>.lah-text{background:var(--lah-well);border-radius:var(--lah-r-sm);padding:var(--lah-s1) var(--lah-s2)}
.lah-tool-label{display:flex;align-items:center;justify-content:space-between;gap:var(--lah-s2);font-size:var(--lah-fs-xs);font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--lah-muted);min-width:0}
.lah-prompt{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-prompt-facts{font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
/* While a turn runs, its state and what the user can do to it stay at the top of what the panel shows, under the page bar (transcript.tsx measures it as --lah-pin-h for the search row under it): never at the foot, where the drawer lies over Lumiverse's own Send and Stop. */
.lah-pin{position:sticky;top:calc(var(--lah-stick-top,0px) + var(--lah-bar-h,0px));z-index:6;display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
/* What a turn came to for its reply: the brief as prose, the lore by name. */
.lah-brief{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
.lah-brief-text{overflow-wrap:anywhere}
.lah-brief-more{display:flex}
/*
  What stays at the foot of what the panel shows: while a turn runs, the way back to the newest step
  and the calls held for the user's word; in any transcript well down from its top, "Back to top".
  The two ways share one row and wrap onto two where a phone has no room for both, so neither lies
  over the other. It stands in the flow at the transcript's end, so at the very end it covers
  nothing. It rises over what stands at the panel's foot: what the host keeps there
  (--lah-stick-bottom: a host that embeds these pages says how tall that is), or a page's own foot
  under the transcript (--lah-page-foot-h: how far up Talk's box to say more reaches, which talk.tsx
  measures), whichever reaches higher.
*/
.lah-foot{position:sticky;bottom:calc(var(--lah-s2) + max(var(--lah-stick-bottom,0px),var(--lah-page-foot-h,0px)));z-index:5;display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;pointer-events:none}
.lah-foot>*{pointer-events:auto}
.lah-foot>.lah-follow{display:flex;flex-wrap:wrap;justify-content:center;gap:var(--lah-s2);pointer-events:none}
.lah-follow>.lah-btn{pointer-events:auto;box-shadow:var(--lah-shadow-lg)}
/* A plain button's own fill lets what scrolls under it show through, which muddles its words: here it is solid. */
.lah-follow>.lah-btn.lah-is-secondary{background:var(--lah-bar-bg)}
.lah-follow>.lah-btn.lah-is-secondary:hover:not(:disabled){background:linear-gradient(var(--lah-hover),var(--lah-hover)),var(--lah-bar-bg)}
/* A transcript in a box that scrolls on its own (Chronicle's) sticks to that box's foot, where neither the host nor a page keeps anything. */
.lah-chron-run{--lah-stick-bottom:0px;--lah-page-foot-h:0px}
.lah-pinned{display:flex;align-items:center;gap:var(--lah-s2);min-width:0;padding:var(--lah-s1) var(--lah-s1) var(--lah-s1) var(--lah-s3);border:1px solid var(--lah-border);border-radius:var(--lah-r-xl);background:var(--lah-bar-bg);box-shadow:var(--lah-shadow-lg);font-size:var(--lah-fs-sm)}
.lah-pinned-text{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
/* With no buttons beside it the bar's line has the room to say itself whole, on two lines where it must. */
.lah-pinned-text.lah-is-whole{white-space:normal;overflow:visible;padding:var(--lah-s2) var(--lah-s2) var(--lah-s2) 0}
.lah-held{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;max-height:min(60vh,440px);overflow-y:auto;overscroll-behavior:contain}
.lah-held>*{flex-shrink:0}
.lah-heldcall{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;padding:var(--lah-s3);border:1px solid color-mix(in srgb,var(--lah-warning) 55%,transparent);border-radius:var(--lah-r-xl);background:var(--lah-bar-bg);box-shadow:var(--lah-shadow-lg)}
.lah-heldcall-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);min-width:0}
.lah-heldcall-head>.lah-icon{color:var(--lah-warn)}
.lah-heldcall-what{flex:1 1 12em;min-width:0;overflow-wrap:anywhere}
.lah-heldcall-args{max-height:160px;overflow:auto;padding:var(--lah-s2);border-radius:var(--lah-r);background:var(--lah-well)}
.lah-say{display:flex;align-items:flex-end;gap:var(--lah-s2);min-width:0;padding:var(--lah-s2);border:1px solid var(--lah-border);border-radius:var(--lah-r-xl);background:var(--lah-bar-bg);box-shadow:var(--lah-shadow-lg)}
.lah-say>textarea.lah-input{flex:1 1 0;min-height:calc(2 * 1.5em + 2 * var(--lah-s2) + 2px);max-height:30vh}
.lah-say-state{display:flex;align-items:center;gap:var(--lah-s1);min-width:0;padding:var(--lah-s1) var(--lah-s3);border:1px solid color-mix(in srgb,var(--lah-warning) 45%,transparent);border-radius:var(--lah-r-lg);background:var(--lah-bar-bg);font-size:var(--lah-fs-sm);color:var(--lah-warn)}
.lah-changed{display:flex;flex-direction:column;gap:2px;min-width:0;margin:0;padding:0;list-style:none}
.lah-changed-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);min-width:0;padding:2px var(--lah-s1);font-size:var(--lah-fs-sm)}
.lah-changed-path{flex:0 1 auto;min-width:0}
.lah-changed-row[data-change=added]>.lah-icon{color:var(--lah-pos)}
.lah-changed-row[data-change=dropped]>.lah-icon{color:var(--lah-muted)}
.lah-changed-row[data-change=refused]{color:var(--lah-warn)}
.lah-lorechange{display:flex;flex-direction:column;gap:2px;min-width:0}
.lah-heldprompt{min-width:0}
.lah-heldprompt-sizes{color:var(--lah-muted)}
.lah-heldprompt>.lah-disclosure-body{gap:var(--lah-s3)}
.lah-heldprompt-part{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
.lah-entryrows{display:flex;flex-direction:column;min-width:0}
.lah-entryrow{display:flex;align-items:center;gap:var(--lah-s2);width:100%;min-width:0;min-height:var(--lah-tap);padding:var(--lah-s1) var(--lah-s2);border:0;border-radius:var(--lah-r);background:none;text-align:left}
.lah-entryrow:hover{background:var(--lah-hover)}
.lah-entryrow>.lah-icon{flex:0 0 auto;color:var(--lah-muted)}
.lah-entryrow-text{flex:1 1 0;min-width:0;display:flex;flex-direction:column}
.lah-entryrow-title{font-weight:600;color:var(--lah-fg);overflow-wrap:anywhere}
.lah-entryrow-note{font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
/* On a phone the bar has no room for its controls' words beside the state: they were cut to a letter, so there the controls show their icons alone. */
@container lah (max-width:${STACKED_TABS_MAX_PX}px){.lah-pinned-word{display:none}}
.lah-tool[data-state=held]>summary>.lah-tool-state{color:var(--lah-warn);font-weight:600}
.lah-statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,132px),1fr));gap:var(--lah-s2);min-width:0}
.lah-statcard{display:flex;flex-direction:column;gap:2px;min-width:0;padding:var(--lah-s2) var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-lg);background:var(--lah-card)}
.lah-statcard-label{font-size:var(--lah-fs-xs);font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--lah-muted)}
.lah-statcard-value{font-size:var(--lah-fs-lg);font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.lah-statcard-sub{font-size:var(--lah-fs-xs);color:var(--lah-muted);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.lah-table{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-thead{display:none}
.lah-trow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--lah-s1) var(--lah-s3);padding:var(--lah-s2) var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-lg);background:var(--lah-card);min-width:0}
.lah-trow.lah-is-sum{background:var(--lah-accent-soft);border-color:color-mix(in srgb,var(--lah-accent) 30%,transparent)}
.lah-tcell{display:flex;flex-direction:column;min-width:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;font-size:var(--lah-fs-sm)}
.lah-tcell::before{content:attr(data-label);font-size:var(--lah-fs-xs);color:var(--lah-muted)}
.lah-tcell.lah-is-lead{grid-column:1 / -1;font-weight:600;font-size:var(--lah-fs-md)}
.lah-tcell.lah-is-lead::before{content:none}
.lah-tcell.lah-is-bar{grid-column:1 / -1}
.lah-tcell.lah-is-bar::before{content:none}
.lah-water{position:relative;height:8px;border-radius:var(--lah-r-pill);background:var(--lah-neutral-soft);overflow:hidden;min-width:60px}
.lah-water>span{position:absolute;top:0;bottom:0;min-width:2px;border-radius:var(--lah-r-pill);background:var(--lah-accent)}
.lah-water>span.lah-is-tool{background:var(--lah-warning)}
.lah-legend{display:flex;flex-wrap:wrap;gap:var(--lah-s1) var(--lah-s3);font-size:var(--lah-fs-xs);color:var(--lah-muted);min-width:0}
.lah-legend>span{display:inline-flex;align-items:center;gap:6px}
.lah-swatch{display:inline-block;width:12px;height:8px;border-radius:var(--lah-r-pill);background:var(--lah-accent)}
.lah-swatch.lah-is-tool{background:var(--lah-warning)}
.lah-events{display:flex;flex-direction:column;gap:2px;min-width:0}
.lah-event>summary{display:flex;align-items:center;gap:var(--lah-s2);min-height:var(--lah-tap-sm);padding:0 var(--lah-s1);cursor:pointer;list-style:none;border-radius:var(--lah-r);min-width:0;font-size:var(--lah-fs-sm)}
.lah-event>summary::-webkit-details-marker{display:none}
.lah-event>summary:hover{background:var(--lah-hover)}
.lah-event-seq{flex:none;min-width:3.5ch;text-align:right;color:var(--lah-dim);font-variant-numeric:tabular-nums}
.lah-event-kind{flex:none;font-weight:600;font-family:var(--lah-mono)}
.lah-event-what{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--lah-muted)}
.lah-event-at{flex:none;color:var(--lah-dim);font-size:var(--lah-fs-xs);font-variant-numeric:tabular-nums;white-space:nowrap}
@container lah (min-width:${WIDE_MIN_PX}px){
.lah-turn-grid{display:grid;grid-template-columns:minmax(220px,var(--lah-side-w)) minmax(0,1fr);align-items:start;gap:var(--lah-s4)}
/* Under the two columns the foot's buttons stand under the steps, not over the side column's outline and filters, which stick to the panel's foot too. */
.lah-turn-grid~.lah-foot>.lah-follow{padding-left:calc(var(--lah-side-w) + var(--lah-s4))}
.lah-turn-side{position:sticky;top:calc(var(--lah-stick-top,0px) + var(--lah-bar-h,0px) + var(--lah-s2));max-height:calc(var(--lah-fill-h,100vh) - var(--lah-bar-h,0px) - var(--lah-s3));overflow-y:auto;overscroll-behavior:contain;padding-right:2px}
.lah-outline{flex-direction:column;overflow-x:visible;padding-bottom:0}
.lah-outline-row{flex:none;max-width:none;width:100%;margin-left:calc(min(var(--lah-depth,0),4) * var(--lah-s3));width:calc(100% - min(var(--lah-depth,0),4) * var(--lah-s3))}
.lah-outline-name,.lah-outline-sub{white-space:normal;overflow-wrap:anywhere}
.lah-filters-toggle{display:none}
.lah-turn-search>.lah-turn-folds{display:flex}
.lah-filters-body[data-open=false]{display:flex}
.lah-turn-head{flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--lah-s2) var(--lah-s4)}
.lah-turn-head>.lah-turn-what{flex:1 1 320px}
.lah-turn-head>.lah-menu{flex:1 1 100%}
.lah-thead{display:grid}
.lah-thead,.lah-trow{grid-template-columns:var(--lah-cols);align-items:center;gap:var(--lah-s2)}
.lah-table{gap:2px}
.lah-thead{padding:0 var(--lah-s3);font-size:var(--lah-fs-xs);font-weight:600;color:var(--lah-muted)}
.lah-thead>span{min-width:0;overflow-wrap:anywhere}
.lah-thead>span.lah-is-n,.lah-tcell.lah-is-n{text-align:right;align-items:flex-end}
.lah-trow{padding:var(--lah-s1) var(--lah-s3);border-radius:var(--lah-r)}
.lah-tcell::before{content:none}
.lah-tcell.lah-is-lead,.lah-tcell.lah-is-bar{grid-column:auto;font-size:var(--lah-fs-sm)}
}
`;
