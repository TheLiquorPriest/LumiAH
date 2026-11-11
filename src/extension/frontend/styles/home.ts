// Home (pages/home.tsx) and what it shares with the Runtime page (setup-parts.tsx): a chat's switch
// with how it stands and where it runs, the rows of what needs the user, the last reply's lines and
// the list of ways into the other pages. One column on a phone; where there is room, the chat and
// what needs the user beside the ways in.

import { WIDE_MIN_PX } from "../layout";

export const HOME_CSS = `
.lah-home{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
.lah-home-col{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
.lah-home-lead{padding:var(--lah-s3) var(--lah-s3) 0}
.lah-chatswitch{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-chatswitch-line{display:flex;align-items:flex-start;gap:var(--lah-s2);min-width:0;font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-chatswitch-line>.lah-icon{margin-top:1px}
.lah-chatswitch-line>span{min-width:0}
.lah-chatswitch-line[data-tone=pos]>.lah-icon{color:var(--lah-pos)}
.lah-chatswitch-line[data-tone=warn]{color:var(--lah-warn)}
.lah-chatswitch-place,.lah-chatswitch-story{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;padding-top:var(--lah-s2);border-top:1px solid var(--lah-hairline)}
.lah-chatswitch-story-row{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-need{display:flex;flex-wrap:wrap;align-items:flex-start;gap:var(--lah-s2) var(--lah-s3);padding:var(--lah-s3);border-top:1px solid var(--lah-hairline);min-width:0}
.lah-need:first-child{border-top:0}
.lah-need>.lah-icon{margin-top:2px}
.lah-need[data-tone=neg]>.lah-icon{color:var(--lah-neg)}
.lah-need[data-tone=warn]>.lah-icon{color:var(--lah-warn)}
.lah-need[data-tone=pos]>.lah-icon{color:var(--lah-pos)}
.lah-need-text{flex:1 1 12em;min-width:0;display:flex;flex-direction:column;gap:var(--lah-s2);overflow-wrap:anywhere}
.lah-need-actions{flex:0 0 auto;display:flex;align-items:center;gap:var(--lah-s1);margin-left:auto}
.lah-home-last{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-home-last-title{display:flex;align-items:flex-start;gap:var(--lah-s2);min-width:0;font-weight:600;overflow-wrap:anywhere}
.lah-home-last-title>.lah-icon{margin-top:1px;color:var(--lah-muted)}
.lah-home-last[data-tone=pos] .lah-home-last-title>.lah-icon{color:var(--lah-pos)}
.lah-home-last[data-tone=warn] .lah-home-last-title>.lah-icon{color:var(--lah-warn)}
.lah-home-last[data-tone=neg] .lah-home-last-title>.lah-icon{color:var(--lah-neg)}
.lah-home-last[data-tone=accent] .lah-home-last-title>.lah-icon{color:var(--lah-accent-text)}
.lah-home-ways{display:flex;flex-direction:column;min-width:0}
.lah-home-more{border-top:1px solid var(--lah-hairline)}
.lah-home-more>summary{padding:0 var(--lah-s3);min-height:max(var(--lah-tap),44px);color:var(--lah-muted);font-size:var(--lah-fs-sm)}
.lah-home-more>.lah-disclosure-body{padding:0;gap:0;border-top:1px solid var(--lah-hairline)}
@container lah (min-width:${WIDE_MIN_PX}px){
.lah-home{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:start;gap:var(--lah-s4)}
}
`;
