// Talk (pages/talk.tsx): the box that starts a conversation, a conversation as what was said and
// what was answered (yours to the right, as in a chat; the agent's with its work under it), and the
// box to say more, which stays at the foot of what the panel shows while nothing of the
// conversation is being worked (while one is, the turn's own bar stands there: styles/live.ts).

export const TALK_CSS = `
.lah-talk-new{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;padding:var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-xl);background:var(--lah-card)}
.lah-talk{display:flex;flex-direction:column;gap:var(--lah-s4);min-width:0;margin:0;padding:0;list-style:none}
.lah-talk-turn{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-talk-said{align-self:flex-end;max-width:min(100%,640px);display:flex;flex-direction:column;gap:2px;min-width:0;padding:var(--lah-s2) var(--lah-s3);border-radius:var(--lah-r-xl);background:var(--lah-accent-soft);border:1px solid color-mix(in srgb,var(--lah-accent) 30%,transparent)}
.lah-talk-answer{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;padding:var(--lah-s2) var(--lah-s3);border-radius:var(--lah-r-xl);background:var(--lah-card);border:1px solid var(--lah-hairline)}
.lah-talk-who{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);font-size:var(--lah-fs-xs);font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--lah-muted)}
.lah-talk-text{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
.lah-talk-foot{position:sticky;bottom:var(--lah-s2);z-index:4;display:flex;flex-direction:column;min-width:0;margin-top:auto}
.lah-talk-foot[data-working]{position:static}
`;
