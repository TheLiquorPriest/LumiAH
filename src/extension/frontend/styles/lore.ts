// The Lore page (pages/lore.tsx): the search box with its button, what a search found (each hit a
// card whose title is its press, with why it matched and its best lines), the filters, an entry's
// row with its state as a sign and words, the entry open, and how search by meaning stands. One
// column on a phone, where the entry open takes the list's place; where there is room the list and
// the entry share the width evenly, since a row says as much as an entry's text does.

import { WIDE_MIN_PX } from "../layout";

export const LORE_CSS = `
.lah-lore-one,.lah-lore-entries,.lah-lore-entry,.lah-lore-found{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
.lah-lore-count{min-width:0;overflow-wrap:anywhere}
.lah-lore-search{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
.lah-lore-box{display:flex;align-items:center;gap:var(--lah-s2);min-width:0}
.lah-lore-box>.lah-btn{flex:none}
.lah-lore-found[data-busy]{opacity:.6}
.lah-lore-ran{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);min-width:0;font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-lore-ran>.lah-icon{align-self:flex-start;margin-top:1px}
.lah-lore-ran>span{flex:1 1 14em;min-width:0}
.lah-lore-ran[data-lah-lore-ran=on]>.lah-icon{color:var(--lah-accent-text)}
.lah-lore-query{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-lore-query-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--lah-s1) var(--lah-s2);min-width:0;padding:0 var(--lah-s1);font-size:inherit;font-weight:400;overflow-wrap:anywhere}
.lah-lore-query-head>strong{min-width:0;font-weight:600}
.lah-lore-hits{display:flex;flex-direction:column;min-width:0;border:1px solid var(--lah-hairline);border-radius:var(--lah-r-xl);background:var(--lah-card);overflow:hidden}
.lah-lore-hit{position:relative;display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0;padding:0 var(--lah-s3) var(--lah-s3);border-top:1px solid var(--lah-hairline);transition:background-color var(--lah-fast)}
.lah-lore-hit:first-child{border-top:0}
.lah-lore-hit:hover{background:var(--lah-hover)}
.lah-lore-hit[data-current]{background:var(--lah-accent-soft);box-shadow:inset 3px 0 0 var(--lah-accent)}
/* A hit's title is its button, and the button's press reaches over the whole card. */
.lah-lore-hit-open{display:flex;align-items:center;gap:var(--lah-s2);width:100%;min-width:0;min-height:max(var(--lah-tap),44px);padding:0;border:0;background:transparent;text-align:left;font-weight:600}
.lah-lore-hit-open::after{content:"";position:absolute;inset:0}
.lah-lore-hit-open>span{flex:1 1 0;min-width:0;overflow-wrap:anywhere}
.lah-lore-hit-open>.lah-chev{color:var(--lah-dim)}
.lah-lore-hit-open:focus-visible{outline-offset:-2px}
.lah-lore-match{min-width:0;font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-lore-lines{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
.lah-lore-line{min-width:0;padding-left:var(--lah-s2);border-left:2px solid var(--lah-border);font-size:var(--lah-fs-sm);overflow-wrap:anywhere}
.lah-lore-standing{display:flex;flex-wrap:wrap;align-items:center;gap:2px var(--lah-s2);min-width:0;font-size:var(--lah-fs-sm)}
.lah-lore-state{display:inline-flex;align-items:center;gap:var(--lah-s1);min-width:0;font-size:var(--lah-fs-sm);font-weight:600;color:var(--lah-muted)}
.lah-lore-state[data-tone=pos]{color:var(--lah-pos)}
.lah-lore-state[data-tone=accent]{color:var(--lah-accent-text)}
.lah-lore-state[data-tone=warn]{color:var(--lah-warn)}
.lah-lore-why{min-width:0;color:var(--lah-muted);overflow-wrap:anywhere}
.lah-lore-filters{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-lore-chip-count{font-weight:400;font-variant-numeric:tabular-nums}
.lah-lore-about{min-width:0;padding:var(--lah-s2) var(--lah-s3);font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-lore-row{align-items:flex-start}
.lah-lore-row>.lah-chev{align-self:center}
.lah-lore-row>.lah-navrow-text{gap:2px}
.lah-lore-facts{display:flex;flex-direction:column;min-width:0;margin:0;border:1px solid var(--lah-hairline);border-radius:var(--lah-r-lg);background:var(--lah-card);overflow:hidden}
.lah-lore-fact{display:flex;flex-direction:column;gap:1px;min-width:0;padding:var(--lah-s2) var(--lah-s3);border-top:1px solid var(--lah-hairline)}
.lah-lore-fact:first-child{border-top:0}
.lah-lore-fact>dt{font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-lore-fact>dd{margin:0;min-width:0;overflow-wrap:anywhere}
.lah-lore-text{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}
.lah-lore-meaning{display:flex;align-items:flex-start;gap:var(--lah-s2);min-width:0;font-weight:500;overflow-wrap:anywhere}
.lah-lore-meaning>.lah-icon{margin-top:1px}
.lah-lore-meaning>.lah-pulse{margin-top:6px}
.lah-lore-meaning>span:last-child{min-width:0}
.lah-lore-meaning[data-tone=pos]>.lah-icon{color:var(--lah-pos)}
.lah-lore-meaning[data-tone=warn]{color:var(--lah-warn)}
.lah-lore-spent{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
@container lah (min-width:${WIDE_MIN_PX}px){
.lah-split.lah-lore{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.lah-lore-hit-open>.lah-chev{display:none}
.lah-lore-fact{flex-direction:row;gap:var(--lah-s3)}
.lah-lore-fact>dt{flex:0 0 9em}
.lah-lore-fact>dd{flex:1 1 0}
}
`;
