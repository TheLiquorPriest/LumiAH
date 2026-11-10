// Design tokens and base rules on the `.lah` root, moved from LumiRPEngine's set. Host theme
// variables with fallbacks, so the pages follow the host's theme in light and dark. Text tokens mix
// the host's status and muted colours toward its text colour so they keep WCAG 4.5:1 on its light
// and dark surfaces; accent-filled controls use --lah-accent-fill.
//
// --lah-tap is the least height and width of anything pressed: 36 px with a fine pointer, 44 px with
// a coarse one (`data-lah-coarse`, which the shell sets from the pointer the device has), so a touch
// target is never under the 42 px DESIGN §8 asks for.

export const TOKENS_CSS = `
.lah{
--lah-font:var(--lumiverse-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);--lah-mono:var(--lumiverse-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);
--lah-fs-xs:calc(11px * var(--lumiverse-font-scale,1));--lah-fs-sm:calc(12px * var(--lumiverse-font-scale,1));--lah-fs-md:calc(14px * var(--lumiverse-font-scale,1));--lah-fs-lg:calc(16px * var(--lumiverse-font-scale,1));--lah-fs-xl:calc(20px * var(--lumiverse-font-scale,1));
--lah-fg:var(--lumiverse-text,#e8e8ea);--lah-muted:color-mix(in srgb,var(--lumiverse-text-muted,#a3a3ad) 85%,var(--lah-fg));--lah-dim:color-mix(in srgb,var(--lumiverse-text-dim,#7c7c86) 50%,var(--lah-fg));
--lah-surface:var(--lumiverse-bg,#17171c);--lah-card:var(--lumiverse-surface-raised,var(--lumiverse-bg-elevated,rgba(255,255,255,.04)));--lah-well:var(--lumiverse-fill,rgba(0,0,0,.15));--lah-hover:var(--lumiverse-fill-hover,rgba(127,127,127,.12));
--lah-border:var(--lumiverse-border,rgba(255,255,255,.12));--lah-hairline:var(--lumiverse-border-light,rgba(128,128,128,.12));
--lah-subtle:var(--lumiverse-fill-subtle,rgba(255,255,255,.05));--lah-neutral-soft:color-mix(in srgb,var(--lah-fg) 10%,transparent);
--lah-bar-bg:linear-gradient(var(--lah-surface),var(--lah-surface)),var(--lumiverse-bg-deep,#121217);
--lah-accent:var(--lumiverse-primary,#7c6cff);--lah-accent-fg:var(--lumiverse-primary-contrast,#fff);--lah-accent-fill:var(--lah-accent);--lah-accent-soft:color-mix(in srgb,var(--lah-accent) 14%,transparent);--lah-accent-text:color-mix(in srgb,var(--lah-accent) 70%,var(--lah-fg));
--lah-danger:var(--lumiverse-danger,#ef4444);--lah-success:var(--lumiverse-success,#22c55e);--lah-warning:var(--lumiverse-warning,#f59e0b);
--lah-neg:color-mix(in srgb,var(--lah-danger) 55%,var(--lah-fg));--lah-pos:color-mix(in srgb,var(--lah-success) 35%,var(--lah-fg));--lah-warn:color-mix(in srgb,var(--lah-warning) 35%,var(--lah-fg));
--lah-neg-soft:color-mix(in srgb,var(--lah-danger) 12%,transparent);--lah-pos-soft:color-mix(in srgb,var(--lah-success) 12%,transparent);--lah-warn-soft:color-mix(in srgb,var(--lah-warning) 12%,transparent);
--lah-mark:color-mix(in srgb,var(--lah-warning) 38%,transparent);--lah-mark-now:color-mix(in srgb,var(--lah-warning) 85%,var(--lah-fg));
--lah-r-sm:var(--lumiverse-radius-sm,6px);--lah-r:var(--lumiverse-radius-md,10px);--lah-r-lg:var(--lumiverse-radius-lg,12px);--lah-r-xl:var(--lumiverse-radius-xl,16px);--lah-r-pill:999px;
--lah-shadow-sm:var(--lumiverse-shadow-sm,0 2px 8px rgba(0,0,0,.2));--lah-shadow-lg:var(--lumiverse-shadow-md,0 8px 24px rgba(0,0,0,.4));
--lah-s1:4px;--lah-s2:8px;--lah-s3:12px;--lah-s4:16px;--lah-s5:24px;--lah-tap:36px;
--lah-fast:var(--lumiverse-transition-fast,150ms ease);--lah-med:var(--lumiverse-transition,200ms ease);
overflow-wrap:break-word}
.lah[data-lah-coarse]{--lah-tap:44px}
@supports (color:hsl(from red h s calc(100 - l))){.lah{--lah-accent-fill:color-mix(in srgb,var(--lah-accent) 80%,hsl(from var(--lah-accent-fg) h s calc(100 - l)))}}
.lah{font:var(--lah-fs-md)/1.45 var(--lah-font);color:var(--lah-fg);box-sizing:border-box;min-width:0;text-align:left}
.lah *,.lah *::before,.lah *::after{box-sizing:border-box}
.lah [hidden]{display:none!important}
.lah button{font:inherit;color:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
.lah button:disabled{cursor:default;opacity:.5}
.lah :focus-visible{outline:2px solid var(--lah-accent);outline-offset:2px}
.lah p,.lah ol,.lah ul,.lah h2,.lah h3,.lah h4,.lah pre{margin:0}
.lah ol,.lah ul{padding:0;list-style:none}
.lah code,.lah pre{font-family:var(--lah-mono)}
.lah mark{background:var(--lah-mark);color:inherit;border-radius:2px}
.lah mark[data-lah-now]{background:var(--lah-mark-now);color:var(--lah-surface);outline:2px solid var(--lah-mark-now)}
@media (prefers-reduced-motion:reduce){.lah,.lah *,.lah *::before,.lah *::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
`;
