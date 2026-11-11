// The Library pages (defs.tsx, pages/agents.tsx, pages/skills.tsx, pages/tools.tsx): the bar over a
// list of definitions, a row's opening line, the bar that saves a definition's edits (it stays at
// the foot of what the panel shows, so Save is in reach however long the definition is), a skill's
// reading view, and the Tools page: what each tier's calls do and the MCP servers above the tools,
// side by side where there is room, and a tool's arguments as a list.

import { WIDE_MIN_PX } from "../layout";

export const DEFS_CSS = `
.lah-defs-bar{display:flex;align-items:center;gap:var(--lah-s2);min-width:0}
.lah-defs-opening{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:var(--lah-fs-sm);color:var(--lah-dim);overflow-wrap:anywhere}
.lah-navrow[data-off] .lah-navrow-title>span:first-child{color:var(--lah-muted)}
.lah-defs-save{position:sticky;bottom:var(--lah-s2);z-index:4;display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s2) var(--lah-s3);min-width:0;padding:var(--lah-s2) var(--lah-s3);border:1px solid var(--lah-border);border-radius:var(--lah-r-xl);background:var(--lah-bar-bg);box-shadow:var(--lah-shadow-lg)}
.lah-defs-save[data-state=unsaved]{border-color:color-mix(in srgb,var(--lah-warning) 55%,transparent)}
.lah-defs-save[data-state=refused]{border-color:color-mix(in srgb,var(--lah-danger) 60%,transparent)}
.lah-defs-save-text{flex:1 1 14em;min-width:0;display:flex;align-items:flex-start;gap:var(--lah-s2);font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-defs-save-text>.lah-icon{margin-top:2px;color:var(--lah-neg)}
.lah-defs-save-text>span{min-width:0}
.lah-defs-save[data-state=refused]>.lah-defs-save-text{color:var(--lah-fg)}
.lah-defs-reading{padding:var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r);background:var(--lah-well);font-family:inherit;font-size:inherit;line-height:1.55}
.lah-defs-form{scroll-margin-top:calc(var(--lah-bar-h,0px) + var(--lah-s3))}
.lah-tools{display:flex;flex-direction:column;gap:var(--lah-s4);min-width:0;flex:1}
.lah-tools-top{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--lah-s3);min-width:0;align-items:start}
.lah-tools[data-pane=detail]>.lah-tools-top{display:none}
.lah-tools-tier{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0;padding-top:var(--lah-s3);border-top:1px solid var(--lah-hairline)}
.lah-tools-tier:first-of-type{padding-top:0;border-top:0}
.lah-tools-tier-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);min-width:0;font-size:var(--lah-fs-sm);color:var(--lah-muted)}
.lah-tools-tier-head>span:last-child{flex:1 1 12em;min-width:0;overflow-wrap:anywhere}
.lah-tools-server{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0;padding-top:var(--lah-s2);border-top:1px solid var(--lah-hairline)}
.lah-tools-server:first-of-type{padding-top:0;border-top:0}
.lah-tools-server-name{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);min-width:0;font-weight:500}
.lah-tools-filter{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-tools-filter .lah-chip{min-height:var(--lah-tap)}
.lah-tools-name{font-family:var(--lah-mono);font-size:var(--lah-fs-sm);font-weight:600;overflow-wrap:anywhere}
.lah-tools-params{display:flex;flex-direction:column;min-width:0;margin:0;padding:0;list-style:none}
.lah-tools-param{display:flex;flex-direction:column;gap:2px;min-width:0;padding:var(--lah-s2) 0;border-top:1px solid var(--lah-hairline)}
.lah-tools-param:first-child{padding-top:0;border-top:0}
.lah-tools-param:last-child{padding-bottom:0}
.lah-tools-param-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);min-width:0}
.lah-tools-param-type{font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-tools-param-text{font-size:var(--lah-fs-sm);overflow-wrap:anywhere}
.lah-tools-json{user-select:text;max-height:22em;overflow:auto}
@container lah (min-width:${WIDE_MIN_PX}px){
.lah-tools-top{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--lah-s4)}
.lah-tools[data-pane=detail]>.lah-tools-top{display:grid}
}
`;
