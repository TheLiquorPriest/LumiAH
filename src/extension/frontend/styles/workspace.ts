// Workspace and Guidance (pages/workspace*.tsx, pages/guidance.tsx): the areas as a choice, an
// area's files as a tree whose rows indent by their depth, a bound as words over a bar, a text as
// it is read, the line diff (each line that only one text has carries a sign and a word beside its
// colour), the cards of a change set, of a history and of what is pinned, and a guidance level.

import { WIDE_MIN_PX } from "../layout";

export const WORKSPACE_CSS = `
.lah-ws-wide{display:none}
.lah-ws-who{display:inline-flex;align-items:center;gap:4px;min-width:0;overflow-wrap:anywhere}
.lah-ws-facts{display:flex;flex-wrap:wrap;align-items:center;gap:2px var(--lah-s2);min-width:0;overflow-wrap:anywhere}
.lah-ws-path{font-family:var(--lah-mono);font-size:.92em;overflow-wrap:anywhere;min-width:0}

.lah-ws-areas>.lah-navrow[aria-pressed=true]{background:var(--lah-accent-soft);box-shadow:inset 3px 0 0 var(--lah-accent)}
.lah-ws-areas>.lah-navrow:disabled{opacity:.6;cursor:default}
.lah-ws-sign{flex:none;width:5.6em;white-space:nowrap;font-family:var(--lah-mono);font-size:var(--lah-fs-sm);color:var(--lah-muted)}
.lah-ws-about{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;padding:var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-xl);background:var(--lah-card)}
.lah-ws-tree>.lah-navrow{padding-left:calc(var(--lah-s3) + var(--lah-ws-depth,0) * var(--lah-s4))}
.lah-ws-tree>.lah-navrow[data-kind=folder] .lah-navrow-title{font-weight:600}
.lah-ws-tree>.lah-navrow>.lah-icon{flex:none;color:var(--lah-muted)}
.lah-ws-marks{display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex:none;max-width:45%}

.lah-ws-bound{display:flex;flex-direction:column;gap:4px;min-width:0}
.lah-ws-bound>span:first-child{display:flex;align-items:center;gap:var(--lah-s1);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-ws-bound[data-over=true]>span:first-child{color:var(--lah-warn)}
.lah-ws-meter{display:block;height:4px;border-radius:2px;background:var(--lah-well);box-shadow:inset 0 0 0 1px var(--lah-hairline);overflow:hidden}
.lah-ws-meter>span{display:block;height:100%;background:var(--lah-accent)}
.lah-ws-bound[data-over=true] .lah-ws-meter>span{background:var(--lah-warning)}

.lah-ws-text{margin:0;padding:var(--lah-s2) var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-lg);background:var(--lah-well)}
.lah-ws-editbox,.lah-ws-conflict{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-ws-editbox textarea{min-height:min(40vh,320px)}

.lah-ws-diffbox{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-ws-diff{display:flex;flex-direction:column;min-width:0;border:1px solid var(--lah-hairline);border-radius:var(--lah-r-lg);background:var(--lah-well);overflow:hidden;font:var(--lah-fs-sm)/1.5 var(--lah-mono)}
/* On a phone the gutter is the sign alone, and the word that says what the sign means stands small at the line's end: a word's width beside every line took a third of the text's room. */
.lah-ws-diffline{display:grid;grid-template-columns:1.2em minmax(0,1fr) auto;gap:0 var(--lah-s1);align-items:baseline;min-width:0;padding:1px var(--lah-s2)}
.lah-ws-diffline>.lah-ws-diffsign{grid-column:1;grid-row:1}
.lah-ws-diffline>.lah-ws-difftext{grid-column:2;grid-row:1}
.lah-ws-diffline>.lah-ws-diffword{grid-column:3;grid-row:1;font-size:var(--lah-fs-xs);white-space:nowrap}
.lah-ws-diffline[data-kind=added]{background:var(--lah-pos-soft);box-shadow:inset 3px 0 0 var(--lah-success)}
.lah-ws-diffline[data-kind=removed]{background:var(--lah-neg-soft);box-shadow:inset 3px 0 0 var(--lah-danger)}
.lah-ws-diffsign{text-align:center;font-weight:700}
.lah-ws-difftext{min-width:0;min-height:1.5em;white-space:pre-wrap;overflow-wrap:anywhere}
.lah-ws-diffline[data-kind=added]>.lah-ws-diffsign,.lah-ws-diffline[data-kind=added]>.lah-ws-diffword{color:var(--lah-pos)}
.lah-ws-diffline[data-kind=removed]>.lah-ws-diffsign,.lah-ws-diffline[data-kind=removed]>.lah-ws-diffword{color:var(--lah-neg)}
.lah-ws-fold{display:flex;align-items:center;gap:var(--lah-s2);width:100%;min-height:var(--lah-tap);padding:var(--lah-s1) var(--lah-s2);border:0;border-top:1px dashed var(--lah-border);border-bottom:1px dashed var(--lah-border);border-radius:0;background:transparent;color:var(--lah-muted);font:inherit;text-align:left;overflow-wrap:anywhere}
.lah-ws-fold:hover{background:var(--lah-hover);color:var(--lah-fg)}
.lah-ws-fold:focus-visible{outline-offset:-2px}

.lah-ws-changes,.lah-ws-versions{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;margin:0;padding:0;list-style:none}
.lah-ws-change,.lah-ws-version{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;padding:var(--lah-s2) var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-xl);background:var(--lah-card)}
.lah-ws-change-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);min-width:0}
.lah-ws-change-head>.lah-ws-path{flex:1 1 10em;font-weight:600}
.lah-ws-version[data-deleted=true]{background:transparent;border-style:dashed}
.lah-ws-version-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.lah-ws-version-when{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);min-width:0;font-weight:500;overflow-wrap:anywhere}
.lah-ws-panel{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;padding:var(--lah-s3);border:1px solid var(--lah-border);border-radius:var(--lah-r-xl);background:var(--lah-card);scroll-margin-top:calc(var(--lah-stick-top,0px) + var(--lah-bar-h,0px) + var(--lah-s3))}
.lah-ws-panel>.lah-spread{flex-wrap:nowrap;align-items:flex-start}
.lah-ws-panel>.lah-spread>strong{flex:1 1 0;min-width:0;overflow-wrap:anywhere}

.lah-ws-pingroup{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-ws-pingroup-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s2);min-width:0;overflow-wrap:anywhere}
.lah-ws-pinrow{display:flex;align-items:center;gap:var(--lah-s1);min-width:0;padding-right:var(--lah-s1);border-top:1px solid var(--lah-hairline)}
.lah-ws-pinrow:first-child{border-top:0}
.lah-ws-pinrow>.lah-navrow{flex:1 1 0;width:auto;border-top:0}

.lah-gd-levels{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0;margin:0;padding:0;list-style:none}
.lah-gd-level{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;padding:var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-xl);background:var(--lah-card)}
.lah-gd-head{display:flex;align-items:flex-start;gap:var(--lah-s2);min-width:0}
.lah-gd-n{flex:none;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:var(--lah-accent-soft);color:var(--lah-accent-text);font-weight:600;font-variant-numeric:tabular-nums}
.lah-gd-title{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:1px;overflow-wrap:anywhere}
.lah-gd-start{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s2) var(--lah-s3);min-width:0;padding:var(--lah-s3);border:1px solid color-mix(in srgb,var(--lah-accent) 30%,transparent);border-radius:var(--lah-r-xl);background:var(--lah-accent-soft)}
.lah-gd-start>span{flex:1 1 14em;min-width:0;overflow-wrap:anywhere}
.lah-gd-example{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
.lah-gd-level{scroll-margin-top:calc(var(--lah-stick-top,0px) + var(--lah-bar-h,0px) + var(--lah-s3))}

@container lah (min-width:${WIDE_MIN_PX}px){
.lah-ws-wide{display:inline-flex}
.lah-ws-diffline{grid-template-columns:1.2em 4.4em minmax(0,1fr)}
.lah-ws-diffline>.lah-ws-diffword{grid-column:2;font-size:inherit}
.lah-ws-diffline>.lah-ws-difftext{grid-column:3}
.lah-ws-version{flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:space-between}
.lah-ws-version-text{flex:1 1 12em}
}
`;
