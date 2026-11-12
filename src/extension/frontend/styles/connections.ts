// Runtime → Connections (connections.tsx) and the sign-in (signin.tsx): the list of a runtime's
// connections as rows, the form that adds or edits one, Copy from Lumiverse and the keys it asks
// for, the sign-ins and the dialog of one. Every row and field wraps to the width there is, so the
// section reads at a phone's width; a heading the page moves the focus to shows no ring of its own
// (the focus is there for the keyboard, the content says where it is).

export const CONNECTIONS_CSS = `
.lah-conns-section{scroll-margin-top:calc(var(--lah-stick-top,0px) + var(--lah-bar-h,0px) + var(--lah-s3))}
.lah-conns{display:flex;flex-direction:column;min-width:0}
.lah-conn-pad{display:flex;flex-direction:column;gap:var(--lah-s2);padding:var(--lah-s3);min-width:0}
.lah-conn-pad+.lah-conn-pad,.lah-conn-list+.lah-conn-pad,.lah-conn-pad+.lah-conn-list,.lah-conns>.lah-empty+.lah-conn-pad{border-top:1px solid var(--lah-hairline)}
.lah-conn-list{display:flex;flex-direction:column;min-width:0;border-top:1px solid var(--lah-hairline)}
.lah-conn{display:flex;flex-direction:column;gap:var(--lah-s2);padding:var(--lah-s3);border-top:1px solid var(--lah-hairline);min-width:0}
.lah-conn:first-child{border-top:0}
.lah-conn[data-editing]{background:var(--lah-subtle)}
.lah-conn-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--lah-s1) var(--lah-s2);min-width:0}
.lah-conn-name{font-weight:600;min-width:0;overflow-wrap:anywhere}
.lah-conns-section .lah-section-title:focus,.lah-conn-form-title:focus,.lah-signin-title:focus{outline:none}
.lah-conn-form{display:flex;flex-direction:column;gap:var(--lah-s3);min-width:0}
.lah-conns>.lah-conn-form{padding:var(--lah-s3);background:var(--lah-subtle);border-top:1px solid var(--lah-hairline)}
.lah-conn-form-title,.lah-signin-title{font-weight:600;overflow-wrap:anywhere}
.lah-conn-panel{background:var(--lah-subtle)}
.lah-conn-signin{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--lah-s2);min-width:0}
.lah-conn-signins>.lah-conn-signin{padding-top:var(--lah-s2);border-top:1px solid var(--lah-hairline)}
.lah-conn-header{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s2);min-width:0}
.lah-conn-header>.lah-input{flex:1 1 150px}
.lah-conn-copyrow{min-width:0}
.lah-signin{display:flex;flex-direction:column;gap:var(--lah-s3);padding:var(--lah-s3);border:1px solid color-mix(in srgb,var(--lah-accent) 35%,transparent);border-radius:var(--lah-r-lg);background:var(--lah-card);min-width:0}
.lah-signin-steps>li{display:flex;flex-direction:column;gap:var(--lah-s2)}
.lah-signin-open{align-self:flex-start;text-decoration:none;color:inherit}
.lah-signin-paste{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s2);min-width:0}
.lah-signin-paste>.lah-input{flex:1 1 200px}
`;
