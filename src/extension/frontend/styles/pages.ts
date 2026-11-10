// Sessions, Settings and Runtime (pages/*.tsx), built on the tokens and the shared atoms: a chat's
// turns with their compaction points; a setting's row with its Changed mark and Default, groups of
// them, tables of rows, the text editor; and the Runtime page's steps, runtimes, key and chats, in
// one column on a phone and side by side where there is room.

import { WIDE_MIN_PX } from "../layout";

export const PAGES_CSS = `
.lah-turns{display:flex;flex-direction:column;min-width:0;border:1px solid var(--lah-hairline);border-radius:var(--lah-r-xl);background:var(--lah-card);overflow:hidden}
.lah-turnrow{min-width:0;border-top:1px solid var(--lah-hairline)}
.lah-turnrow:first-child{border-top:0}
.lah-turnrow>.lah-navrow{border-top:0}
.lah-turnrow[data-on-path=false] .lah-navrow-title{color:var(--lah-muted)}
.lah-turnrow-title{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);font-weight:500;min-width:0}
.lah-turnrow-preview{font-size:var(--lah-fs-sm);color:var(--lah-muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.lah-compaction{display:flex;flex-direction:column;gap:var(--lah-s1);margin:0 var(--lah-s3) var(--lah-s2);padding:var(--lah-s2) var(--lah-s3);border-radius:var(--lah-r-lg);background:var(--lah-accent-soft);border:1px solid color-mix(in srgb,var(--lah-accent) 30%,transparent);font-size:var(--lah-fs-sm);min-width:0;overflow-wrap:anywhere}
.lah-compaction-head{display:flex;align-items:flex-start;gap:var(--lah-s2);font-weight:600;color:var(--lah-accent-text)}
.lah-compaction-head>.lah-icon{margin-top:2px}
.lah-set-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--lah-s1) var(--lah-s2);min-width:0}
.lah-set-status{font-size:var(--lah-fs-sm);color:var(--lah-muted);min-height:1.45em}
.lah-set-group{display:flex;flex-direction:column;min-width:0;border:1px solid var(--lah-hairline);border-radius:var(--lah-r-xl);background:var(--lah-card)}
.lah-set-group .lah-set-group{border-radius:var(--lah-r-lg);background:var(--lah-subtle);margin:0 var(--lah-s3) var(--lah-s3)}
.lah-set-group-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--lah-s1) var(--lah-s2);padding:var(--lah-s2) var(--lah-s3) 0;min-width:0}
.lah-set-group-title{font-weight:600;min-width:0;overflow-wrap:anywhere}
.lah-set-group-help{padding:0 var(--lah-s3);font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-set-row{display:flex;flex-direction:column;gap:var(--lah-s1);padding:var(--lah-s3);border-top:1px solid var(--lah-hairline);min-width:0;scroll-margin-top:calc(var(--lah-bar-h,0px) + var(--lah-s3))}
.lah-set-group>.lah-set-row:first-child,.lah-set-group-head+.lah-set-row,.lah-set-group-help+.lah-set-row{border-top:0}
.lah-set-row[data-lah-found]{box-shadow:inset 3px 0 0 var(--lah-mark-now)}
.lah-set-row-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);min-width:0;min-height:var(--lah-tap-sm)}
.lah-set-label{flex:1 1 auto;min-width:0;font-weight:500;overflow-wrap:anywhere}
.lah-set-path{font:var(--lah-fs-xs)/1.3 var(--lah-mono);color:var(--lah-dim);overflow-wrap:anywhere}
.lah-set-control{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s2);min-width:0}
.lah-set-control>.lah-input,.lah-set-control>.lah-seg,.lah-set-control>.lah-switch{flex:1 1 180px}
.lah-set-control>textarea.lah-input{flex-basis:100%}
.lah-set-unit{font-size:var(--lah-fs-sm);color:var(--lah-muted);white-space:nowrap}
.lah-set-checks{display:flex;flex-direction:column;min-width:0;flex:1 1 100%}
.lah-set-tablerow{display:flex;flex-direction:column;min-width:0;border-top:1px solid var(--lah-hairline)}
.lah-set-tablerow-head{display:flex;align-items:center;justify-content:space-between;gap:var(--lah-s2);padding:var(--lah-s2) var(--lah-s3) 0;min-width:0}
.lah-set-tablerow-key{font:600 var(--lah-fs-sm)/1.3 var(--lah-mono);min-width:0;overflow-wrap:anywhere}
.lah-set-add{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s2);padding:var(--lah-s3);border-top:1px solid var(--lah-hairline);min-width:0}
.lah-set-add>.lah-input{flex:1 1 160px}
.lah-found{display:flex;flex-direction:column;min-width:0;border:1px solid var(--lah-hairline);border-radius:var(--lah-r-xl);background:var(--lah-card);overflow:hidden}
.lah-text-editor{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
.lah-text-editor textarea.lah-input{min-height:min(52vh,420px)}
.lah-text-compare{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
.lah-text-vars{display:flex;flex-direction:column;min-width:0;border:1px solid var(--lah-hairline);border-radius:var(--lah-r-lg);overflow:hidden}
.lah-text-var{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);padding:var(--lah-s1) var(--lah-s2);border-top:1px solid var(--lah-hairline);min-width:0;font-size:var(--lah-fs-sm)}
.lah-text-var:first-child{border-top:0}
.lah-text-var>span:not([class]){flex:1 1 140px;min-width:0;overflow-wrap:anywhere;color:var(--lah-muted)}
.lah-text-default{max-height:min(52vh,420px);overflow:auto;padding:var(--lah-s2) var(--lah-s3);border-radius:var(--lah-r);background:var(--lah-well);border:1px solid var(--lah-hairline)}
.lah-runtime{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
.lah-runtime-col{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
.lah-steps{display:flex;flex-direction:column;min-width:0;counter-reset:lah-step}
.lah-step{display:flex;gap:var(--lah-s3);padding:var(--lah-s3);border-top:1px solid var(--lah-hairline);min-width:0}
.lah-step:first-child{border-top:0}
.lah-step-mark{flex:none;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:var(--lah-fs-sm);font-weight:700;background:var(--lah-neutral-soft);color:var(--lah-muted)}
.lah-step[data-state=done]>.lah-step-mark{background:var(--lah-pos-soft);color:var(--lah-pos)}
.lah-step[data-state=now]>.lah-step-mark{background:var(--lah-accent-fill);color:var(--lah-accent-fg)}
.lah-step-body{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:var(--lah-s2)}
.lah-step-title{font-weight:600;overflow-wrap:anywhere}
.lah-step[data-state=todo] .lah-step-title{color:var(--lah-muted)}
.lah-relay{display:flex;flex-direction:column;gap:var(--lah-s2);padding:var(--lah-s3);border-top:1px solid var(--lah-hairline);min-width:0}
.lah-relay:first-child{border-top:0}
.lah-relay-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--lah-s1) var(--lah-s2);min-width:0}
.lah-relay-name{font-weight:600;min-width:0;overflow-wrap:anywhere}
.lah-facts{display:flex;flex-direction:column;gap:2px;font-size:var(--lah-fs-sm);color:var(--lah-muted);min-width:0;overflow-wrap:anywhere}
.lah-facts>li{display:flex;gap:var(--lah-s2);min-width:0}
.lah-facts>li::before{content:"·";flex:none;color:var(--lah-dim)}
.lah-facts>li>span{min-width:0}
.lah-chatrow{display:flex;flex-direction:column;gap:var(--lah-s1);padding:var(--lah-s3);border-top:1px solid var(--lah-hairline);min-width:0}
.lah-chatrow:first-child{border-top:0}
.lah-chatrow-sub{font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-ol{display:flex;flex-direction:column;gap:var(--lah-s2);padding-left:1.4em;list-style:decimal;min-width:0}
.lah .lah-ol{list-style:decimal;padding-left:1.4em}
.lah-ol>li{min-width:0;overflow-wrap:anywhere}
@container lah (min-width:${WIDE_MIN_PX}px){
.lah-runtime{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:var(--lah-s4)}
.lah-runtime>.lah-runtime-wide{grid-column:1 / -1}
.lah-set-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:var(--lah-s1) var(--lah-s4);align-items:start}
.lah-set-row>.lah-set-about{grid-column:1;display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
.lah-set-row>.lah-set-edit{grid-column:2;display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
.lah-set-row.lah-is-wide{grid-template-columns:minmax(0,1fr)}
.lah-set-row.lah-is-wide>.lah-set-edit{grid-column:1}
.lah-text-compare{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--lah-s3);align-items:start}
}
.lah-set-about,.lah-set-edit{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
`;
