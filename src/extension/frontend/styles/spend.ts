// The Spend and Storage pages (DESIGN §20): the chart of a period's days, the tables of figures, a
// cap's bar. A table is a stack of rows below the wide width, each row's figures under its name with
// their column's name beside them, and a table of columns from it up; the chart scrolls sideways in
// its own box when its days need more room than the page has.

import { WIDE_MIN_PX } from "../layout";

export const SPEND_CSS = `
.lah-spend,.lah-upkeep{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
.lah-spend-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s2);min-width:0}
.lah-spend-head>.lah-seg{flex:1 1 15em}
.lah-spend-note{display:flex;gap:var(--lah-s2);align-items:flex-start;min-width:0;font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-spend-note>.lah-icon{flex:none;margin-top:2px}
.lah-spend-note>span{min-width:0}
.lah-spend-pad{padding:var(--lah-s3)}

.lah-chart{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-chart-scroll{--lah-bar-w:8px;min-width:0;overflow-x:auto;overflow-y:hidden;padding-bottom:var(--lah-s1)}
.lah[data-lah-coarse] .lah-chart-scroll{--lah-bar-w:16px}
.lah-chart-plot{display:flex;align-items:stretch;gap:2px;height:160px;min-width:calc(var(--lah-days,1) * var(--lah-bar-w));margin:0;padding:0;list-style:none;border-bottom:1px solid var(--lah-border);background:linear-gradient(var(--lah-hairline),var(--lah-hairline)) 0 0/100% 1px no-repeat,linear-gradient(var(--lah-hairline),var(--lah-hairline)) 0 50%/100% 1px no-repeat}
.lah-chart-plot>li{flex:1 1 0;min-width:0;display:flex}
.lah-chart-bar{flex:1;min-width:0;display:flex;align-items:flex-end;padding:0;border:0;border-radius:var(--lah-r-sm) var(--lah-r-sm) 0 0;background:transparent;cursor:pointer}
.lah-chart-bar>span{display:block;width:100%;height:calc(var(--lah-bar,0) * 100%);min-height:3px;border-radius:2px 2px 0 0;background:var(--lah-accent);opacity:.6}
.lah-chart-bar[data-empty]>span{min-height:2px;background:var(--lah-dim)}
.lah-chart-bar:hover{background:var(--lah-subtle)}
.lah-chart-bar[aria-pressed=true]{background:var(--lah-accent-soft)}
.lah-chart-bar[aria-pressed=true]>span{opacity:1}
.lah-chart-bar:focus-visible{outline:2px solid var(--lah-accent);outline-offset:-2px}
.lah-chart-ends{display:flex;justify-content:space-between;gap:var(--lah-s2);min-width:calc(var(--lah-days,1) * var(--lah-bar-w));padding-top:2px;font-size:var(--lah-fs-xs);color:var(--lah-muted)}
.lah-chart-day{display:flex;align-items:center;gap:var(--lah-s2);min-width:0}
.lah-chart-day>p{flex:1;min-width:0;margin:0;font-size:var(--lah-fs-sm);overflow-wrap:anywhere}
.lah-chart-day>p>strong{display:block}

.lah-tbl{display:block;width:100%;min-width:0;border-collapse:collapse}
.lah-tbl>thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.lah-tbl>tbody,.lah-tbl>tfoot{display:block}
.lah-tbl tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--lah-s1) var(--lah-s3);padding:var(--lah-s2) var(--lah-s3);border-top:1px solid var(--lah-hairline)}
.lah-tbl>tbody>tr:first-child{border-top:0}
.lah-tbl th{padding:0;text-align:left;font-weight:600;overflow-wrap:anywhere}
.lah-tbl th[scope=row]{grid-column:1/-1}
.lah-tbl td{display:flex;flex-direction:column;align-items:flex-start;min-width:0;padding:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.lah-tbl td::before{content:attr(data-label);font-size:var(--lah-fs-xs);color:var(--lah-muted)}
.lah-tbl td[data-wide]{grid-column:1/-1}
.lah-tbl td[data-fill]{display:none}
.lah-tbl>tfoot>tr{background:var(--lah-well)}
.lah-tbl-sub{display:block;font-size:var(--lah-fs-xs);font-weight:400;color:var(--lah-muted)}
@container lah (min-width:${WIDE_MIN_PX}px){
.lah-tbl{display:table}
.lah-tbl>thead{position:static;width:auto;height:auto;overflow:visible;clip:auto;white-space:normal;display:table-header-group}
.lah-tbl>tbody{display:table-row-group}
.lah-tbl>tfoot{display:table-footer-group}
.lah-tbl tr{display:table-row}
.lah-tbl>tbody>tr:first-child{border-top:1px solid var(--lah-hairline)}
.lah-tbl th,.lah-tbl td{display:table-cell;padding:var(--lah-s2) var(--lah-s3);text-align:right;vertical-align:top}
.lah-tbl th:first-child{text-align:left}
.lah-tbl>thead th{font-size:var(--lah-fs-xs);font-weight:600;color:var(--lah-muted)}
.lah-tbl td::before{content:none}
.lah-tbl td[data-fill]{display:table-cell}
}

.lah-cap{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;padding:var(--lah-s3);border-top:1px solid var(--lah-hairline)}
.lah-cap:first-child{border-top:0}
.lah-cap-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--lah-s1) var(--lah-s2);min-width:0}
.lah-cap-head>strong{flex:1 1 12em;min-width:0;font-weight:600;overflow-wrap:anywhere}
.lah-cap-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--lah-s2);min-width:0}
.lah-cap-foot>p{flex:1 1 14em;min-width:0;margin:0;font-size:var(--lah-fs-sm);color:var(--lah-muted);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.lah-cap[data-reached] .lah-cap-foot>p{color:var(--lah-fg)}
.lah-meter{height:8px;border-radius:var(--lah-r-pill);background:var(--lah-well);overflow:hidden}
.lah-meter>span{display:block;height:100%;width:calc(var(--lah-fill,0) * 100%);border-radius:inherit;background:var(--lah-accent)}
.lah-meter[data-reached]>span{background:var(--lah-neg)}

.lah-sweep{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
.lah-sweep-facts{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;margin:0}
.lah-sweep-facts>div{display:flex;flex-direction:column;min-width:0}
.lah-sweep-facts dt{font-size:var(--lah-fs-xs);font-weight:600;color:var(--lah-muted)}
.lah-sweep-facts dd{margin:0;overflow-wrap:anywhere}
.lah-sweep-last{margin:0;min-width:0;overflow-wrap:anywhere}
`;
