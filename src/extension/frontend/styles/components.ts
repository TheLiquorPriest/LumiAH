// The shared atoms of components.tsx, built on the tokens only, moved from LumiRPEngine's set and
// cut to what LumiAH uses. Everything pressed is at least --lah-tap tall and wide (--lah-tap-sm for
// the small controls inside a transcript), and both are 44 px with a coarse pointer. Nothing shows
// only on hover: hover only tints what is already there.

export const COMPONENTS_CSS = `
.lah{--lah-tap-sm:28px}
.lah[data-lah-coarse]{--lah-tap-sm:44px}
.lah .lah-icon{flex:none;vertical-align:middle}
.lah-stack{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-inline{display:flex;gap:var(--lah-s2);align-items:center;flex-wrap:wrap;min-width:0}
.lah-spread{display:flex;flex-wrap:wrap;gap:var(--lah-s2);align-items:center;justify-content:space-between;min-width:0}
.lah-inline>*,.lah-spread>*{max-width:100%}
.lah-grow{flex:1 1 0;min-width:0}
.lah-muted{color:var(--lah-muted)}.lah-dim{color:var(--lah-dim)}.lah-neg{color:var(--lah-neg)}.lah-pos{color:var(--lah-pos)}.lah-warn{color:var(--lah-warn)}
.lah-small{font-size:var(--lah-fs-sm)}
.lah-num{font-variant-numeric:tabular-nums}
.lah-mono{font-family:var(--lah-mono);font-size:var(--lah-fs-sm);overflow-wrap:anywhere}
.lah-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.lah-dot{display:inline-block;flex:none;width:8px;height:8px;border-radius:50%;background:var(--lah-dim)}
.lah-dot.lah-is-accent{background:var(--lah-accent)}.lah-dot.lah-is-pos{background:var(--lah-success)}.lah-dot.lah-is-neg{background:var(--lah-danger)}.lah-dot.lah-is-warn{background:var(--lah-warning)}
.lah-pulse{display:inline-block;flex:none;width:8px;height:8px;border-radius:50%;background:var(--lah-accent);animation:lah-pulse 1.4s ease-in-out infinite}
@keyframes lah-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}
.lah-btn{min-height:var(--lah-tap);min-width:var(--lah-tap);max-width:100%;padding:var(--lah-s1) var(--lah-s3);border-radius:var(--lah-r-lg);border:1px solid var(--lah-border);background:var(--lah-subtle);font-weight:500;line-height:1.25;display:inline-flex;align-items:center;justify-content:center;gap:var(--lah-s2);white-space:normal;overflow-wrap:anywhere;text-align:center;transition:background-color var(--lah-fast),border-color var(--lah-fast),color var(--lah-fast)}
.lah-btn:hover:not(:disabled){background:var(--lah-hover);border-color:var(--lumiverse-border-hover,var(--lah-border))}
.lah-btn.lah-is-primary{background:var(--lah-accent-fill);color:var(--lah-accent-fg);border-color:transparent}
.lah-btn.lah-is-primary:hover:not(:disabled){background:color-mix(in srgb,var(--lah-accent-fill) 88%,var(--lah-fg));border-color:transparent}
.lah-btn.lah-is-danger{color:var(--lah-neg);border-color:color-mix(in srgb,var(--lah-danger) 40%,transparent)}
.lah-btn.lah-is-danger:hover:not(:disabled){background:var(--lah-neg-soft)}
.lah-btn.lah-is-ghost{background:transparent;border-color:transparent}
.lah-btn.lah-is-ghost:hover:not(:disabled){background:var(--lah-hover);border-color:transparent}
.lah-btn.lah-is-block{width:100%}
.lah-btn.lah-is-small{min-height:var(--lah-tap-sm);min-width:var(--lah-tap-sm);padding:2px 10px;font-size:var(--lah-fs-sm);border-radius:var(--lah-r)}
.lah-btn[aria-busy=true]{cursor:progress}
.lah-btn[aria-pressed=true]{background:var(--lah-accent-soft);color:var(--lah-accent-text);border-color:color-mix(in srgb,var(--lah-accent) 35%,transparent)}
.lah-iconbtn{flex:none;width:var(--lah-tap);height:var(--lah-tap);padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--lah-r-lg);border:1px solid transparent;background:transparent;color:var(--lah-muted);transition:background-color var(--lah-fast),color var(--lah-fast)}
.lah-iconbtn:hover:not(:disabled){background:var(--lah-hover);color:var(--lah-fg)}
.lah-iconbtn.lah-is-small{width:var(--lah-tap-sm);height:var(--lah-tap-sm);border-radius:var(--lah-r)}
.lah-iconbtn[aria-pressed=true]{background:var(--lah-accent-soft);color:var(--lah-accent-text)}
.lah-seg{display:flex;gap:2px;flex-wrap:wrap;padding:2px;border-radius:var(--lah-r-lg);background:var(--lah-well);min-width:0}
.lah-seg>button{flex:1 1 0;min-width:min-content;max-width:100%;min-height:var(--lah-tap);padding:var(--lah-s1) var(--lah-s2);border-radius:calc(var(--lah-r-lg) - 2px);border:0;background:transparent;color:var(--lah-muted);font-size:var(--lah-fs-sm);font-weight:500;white-space:normal;overflow-wrap:break-word;transition:background-color var(--lah-fast),color var(--lah-fast)}
.lah-seg>button:hover:not(:disabled):not([aria-pressed=true]){color:var(--lah-fg)}
.lah-seg>button[aria-pressed=true]{background:var(--lah-accent-fill);color:var(--lah-accent-fg)}
.lah-btn.lah-is-primary:focus-visible,.lah-seg>button[aria-pressed=true]:focus-visible{outline-color:var(--lah-fg);box-shadow:inset 0 0 0 2px var(--lah-accent-fg)}
.lah-chips{display:flex;flex-wrap:wrap;gap:var(--lah-s1);min-width:0}
.lah-chip{min-height:var(--lah-tap-sm);padding:2px 10px;border-radius:var(--lah-r-pill);border:1px solid var(--lah-hairline);background:transparent;color:var(--lah-muted);font-size:var(--lah-fs-sm);font-weight:500;display:inline-flex;align-items:center;gap:var(--lah-s1);white-space:nowrap;transition:background-color var(--lah-fast),color var(--lah-fast)}
.lah-chip:hover:not(:disabled){background:var(--lah-hover);color:var(--lah-fg)}
.lah-chip[aria-pressed=true]{background:var(--lah-accent-soft);color:var(--lah-accent-text);border-color:color-mix(in srgb,var(--lah-accent) 35%,transparent);font-weight:600}
.lah-badge{display:inline-flex;align-items:center;gap:var(--lah-s1);min-height:20px;padding:0 var(--lah-s2);border-radius:var(--lah-r-pill);font-size:var(--lah-fs-xs);font-weight:600;background:var(--lah-neutral-soft);color:var(--lah-muted);white-space:nowrap}
.lah-badge.lah-is-accent{background:var(--lah-accent-soft);color:var(--lah-accent-text)}
.lah-badge.lah-is-warn{background:var(--lah-warn-soft);color:var(--lah-warn)}
.lah-badge.lah-is-neg{background:var(--lah-neg-soft);color:var(--lah-neg)}
.lah-badge.lah-is-pos{background:var(--lah-pos-soft);color:var(--lah-pos)}
.lah-banner{border-radius:var(--lah-r-xl);padding:var(--lah-s3);display:flex;flex-direction:column;gap:var(--lah-s2);border:1px solid var(--lah-hairline);background:var(--lah-card);min-width:0}
.lah-banner.lah-is-info{background:var(--lah-accent-soft);border-color:color-mix(in srgb,var(--lah-accent) 35%,transparent)}
.lah-banner.lah-is-warn{background:var(--lah-warn-soft);border-color:color-mix(in srgb,var(--lah-warning) 40%,transparent)}
.lah-banner.lah-is-neg{background:var(--lah-neg-soft);border-color:color-mix(in srgb,var(--lah-danger) 40%,transparent)}
.lah-banner.lah-is-pos{background:var(--lah-pos-soft);border-color:color-mix(in srgb,var(--lah-success) 40%,transparent)}
.lah-banner-main{display:flex;gap:var(--lah-s3);align-items:flex-start;min-width:0}
.lah-banner-icon{margin-top:1px}
.lah-banner.lah-is-info .lah-banner-icon{color:var(--lah-accent-text)}.lah-banner.lah-is-warn .lah-banner-icon{color:var(--lah-warn)}.lah-banner.lah-is-neg .lah-banner-icon{color:var(--lah-neg)}.lah-banner.lah-is-pos .lah-banner-icon{color:var(--lah-pos)}
.lah-banner-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere}
.lah-banner-actions{display:flex;flex-wrap:wrap;gap:var(--lah-s2)}
.lah-empty{padding:var(--lah-s5) var(--lah-s2);text-align:center;color:var(--lah-muted);display:flex;flex-direction:column;align-items:center;gap:var(--lah-s2);min-width:0}
.lah-empty-icon{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--lah-neutral-soft)}
.lah-empty-title{font-weight:600;color:var(--lah-fg)}
.lah-empty-body{max-width:46ch;overflow-wrap:anywhere}
.lah-empty-action{display:flex;flex-wrap:wrap;justify-content:center;gap:var(--lah-s2)}
.lah-section{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-section-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--lah-s1) var(--lah-s2);min-height:24px;padding:0 var(--lah-s1)}
.lah-section-title{min-width:0;font-size:var(--lah-fs-xs);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--lah-muted);overflow-wrap:anywhere}
.lah-section-body{min-width:0;padding:var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-xl);background:var(--lah-card);display:flex;flex-direction:column;gap:var(--lah-s3)}
.lah-section.lah-is-flush>.lah-section-body{padding:0;gap:0;overflow:hidden}
.lah-disclosure{min-width:0}
.lah-disclosure>summary{display:flex;align-items:center;gap:var(--lah-s2);min-height:var(--lah-tap);cursor:pointer;list-style:none;font-weight:500;border-radius:var(--lah-r)}
.lah-disclosure>summary::-webkit-details-marker{display:none}
.lah-disclosure-label{flex:1;min-width:0;overflow-wrap:anywhere}
.lah-caret{color:var(--lah-muted);transition:transform var(--lah-fast)}
details[open]>summary>.lah-caret{transform:rotate(90deg)}
.lah-disclosure-body{display:flex;flex-direction:column;gap:var(--lah-s2);padding:var(--lah-s1) 0 var(--lah-s2);min-width:0}
/* An agent's words as prose (prose.tsx): a heading or a list it wrote looks the same on every page. Under .lah so the lists outweigh the reset that takes a list's marks away. */
.lah-prose{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;overflow-wrap:anywhere}
.lah-prose-h{font-weight:600}
.lah .lah-prose ul{list-style:disc;padding-left:1.3em;display:flex;flex-direction:column;gap:2px}
.lah .lah-prose ol{list-style:decimal;padding-left:1.6em;display:flex;flex-direction:column;gap:2px}
.lah-prose-code{margin:0;padding:var(--lah-s2) var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r);background:var(--lah-well);white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--lah-fs-sm)}
.lah-field{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
.lah-field-head{display:flex;align-items:center;justify-content:space-between;gap:var(--lah-s2);min-width:0}
.lah-field-head>label,.lah-field-label{font-size:var(--lah-fs-sm);font-weight:500;color:var(--lah-muted);min-width:0;overflow-wrap:anywhere}
.lah-field-help{font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-field-error{display:flex;align-items:flex-start;gap:var(--lah-s1);font-size:var(--lah-fs-sm);color:var(--lah-neg);overflow-wrap:anywhere}
.lah-input{min-height:var(--lah-tap);width:100%;padding:var(--lah-s1) var(--lah-s3);border-radius:var(--lah-r);border:1px solid var(--lah-border);background:var(--lah-well);color:var(--lah-fg);font:inherit;min-width:0;transition:border-color var(--lah-fast)}
.lah-input:focus{border-color:var(--lah-accent)}
.lah-input:disabled{opacity:.55}
textarea.lah-input{min-height:96px;padding:var(--lah-s2) var(--lah-s3);resize:vertical;font-family:var(--lah-mono);font-size:var(--lah-fs-sm);line-height:1.5}
textarea.lah-input.lah-is-prose{font-family:inherit;font-size:inherit}
select.lah-input{appearance:auto;text-overflow:ellipsis}
.lah-input.lah-is-invalid{border-color:var(--lah-neg)}
.lah-search{position:relative;display:flex;align-items:center;flex:1 1 0;min-width:0}
.lah-search>.lah-search-icon{position:absolute;top:50%;left:10px;transform:translateY(-50%);color:var(--lah-muted);pointer-events:none}
.lah-search>.lah-input{padding-left:34px;padding-right:var(--lah-tap);-webkit-appearance:none;appearance:none}
.lah-search>.lah-input::-webkit-search-cancel-button,.lah-search>.lah-input::-webkit-search-decoration{-webkit-appearance:none;appearance:none}
.lah-search>.lah-iconbtn{position:absolute;top:50%;right:0;transform:translateY(-50%)}
.lah-switch{display:flex;align-items:center;justify-content:space-between;gap:var(--lah-s3);min-height:var(--lah-tap);min-width:0;cursor:pointer;position:relative}
.lah-switch-text{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere}
.lah-switch>input{position:absolute;opacity:0;width:44px;height:26px;right:0;top:50%;transform:translateY(-50%);margin:0;cursor:pointer}
.lah-switch-track{flex:none;width:44px;height:26px;border-radius:var(--lah-r-pill);background:var(--lah-neutral-soft);border:1px solid var(--lah-border);position:relative;transition:background-color var(--lah-fast)}
.lah-switch-track::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--lah-muted);transition:transform var(--lah-fast),background-color var(--lah-fast)}
.lah-switch>input:checked+.lah-switch-track{background:var(--lah-accent-fill);border-color:transparent}
.lah-switch>input:checked+.lah-switch-track::after{transform:translateX(18px);background:var(--lah-accent-fg)}
.lah-switch>input:focus-visible+.lah-switch-track{outline:2px solid var(--lah-accent);outline-offset:2px}
.lah-switch>input:disabled+.lah-switch-track{opacity:.5}
.lah-check{display:flex;align-items:flex-start;gap:var(--lah-s2);min-height:var(--lah-tap);padding:var(--lah-s1) 0;min-width:0;cursor:pointer}
.lah-check>input{flex:none;width:20px;height:20px;margin:calc((var(--lah-tap) - 20px - 2 * var(--lah-s1)) / 2) 0 0;accent-color:var(--lah-accent);cursor:pointer}
.lah-check-text{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere;align-self:center}
.lah-stepper{display:inline-flex;align-items:center;gap:var(--lah-s1);max-width:100%;min-width:0}
.lah-stepper>.lah-input{flex:1 1 96px;width:96px;min-width:56px;text-align:center;font-variant-numeric:tabular-nums}
.lah-stepper>.lah-btn{flex:0 0 var(--lah-tap);padding:0}
/* The notices take no room of their own and stand over the page's foot, above whatever a running turn keeps there (--lah-foot-h: the bar with Stop, a held call's card; transcript.tsx measures it) and above what the host or the page keeps at the panel's foot (--lah-stick-bottom, --lah-page-foot-h: the same two the transcript's own foot rises over), so a notice never covers a control the user may need at once. */
.lah-toasts{position:sticky;bottom:calc(var(--lah-s2) + var(--lah-foot-h,0px) + max(var(--lah-stick-bottom,0px),var(--lah-page-foot-h,0px)));z-index:8;height:0;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:var(--lah-s1);pointer-events:none;margin-top:auto}
.lah-toast{pointer-events:auto;display:flex;align-items:center;gap:var(--lah-s2);max-width:min(100%,520px);padding:var(--lah-s1) var(--lah-s1) var(--lah-s1) var(--lah-s3);border-radius:var(--lah-r-lg);border:1px solid var(--lah-border);background:var(--lah-bar-bg);box-shadow:var(--lah-shadow-lg);font-size:var(--lah-fs-sm)}
.lah-toast.lah-is-error{border-color:color-mix(in srgb,var(--lah-danger) 50%,transparent);color:var(--lah-neg)}
.lah-toast-text{flex:1;min-width:0;overflow-wrap:anywhere;color:var(--lah-fg)}
.lah-copyline{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
.lah-copyline-row{display:flex;align-items:stretch;gap:var(--lah-s1);min-width:0}
.lah-code{flex:1 1 0;min-width:0;display:block;padding:var(--lah-s2) var(--lah-s3);border-radius:var(--lah-r);background:var(--lah-well);border:1px solid var(--lah-hairline);font:var(--lah-fs-sm)/1.45 var(--lah-mono);white-space:pre-wrap;overflow-wrap:anywhere;user-select:all}
.lah-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s2);min-width:0}
.lah-text{white-space:pre-wrap;overflow-wrap:anywhere;font:var(--lah-fs-sm)/1.5 var(--lah-mono);min-width:0}
.lah-lead{color:var(--lah-muted);overflow-wrap:anywhere}
.lah-h{font-size:var(--lah-fs-lg);font-weight:600;line-height:1.3;overflow-wrap:anywhere}
`;
