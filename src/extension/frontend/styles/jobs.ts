// Jobs (pages/jobs.tsx): the user's two switches and the limits in force in a card over the list,
// the form that starts a job, a job's row (its agent and state, how its task opens, who started it
// and what it spent), and the job open beside the list: its facts, its report and its run.

import { WIDE_MIN_PX } from "../layout";

export const JOBS_CSS = `
.lah-job-card{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0;padding:var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-xl);background:var(--lah-card)}
.lah-job-card>.lah-switch+.lah-switch{padding-top:var(--lah-s2);border-top:1px solid var(--lah-hairline)}
.lah-job-limits{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,84px),1fr));gap:var(--lah-s2);min-width:0;margin:0}
.lah-job-limit{display:flex;flex-direction:column;gap:1px;min-width:0}
.lah-job-limit>dt{font-size:var(--lah-fs-xs);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-job-limit>dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.lah-job-meter{display:block;height:6px;border-radius:var(--lah-r-pill);background:var(--lah-well);box-shadow:inset 0 0 0 1px var(--lah-hairline);overflow:hidden}
.lah-job-meter>span{display:block;height:100%;min-width:2px;border-radius:inherit;background:var(--lah-accent)}
.lah-job-meter.lah-is-reached>span{background:var(--lah-danger)}
.lah-job-form{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-job-form textarea.lah-input{min-height:calc(4 * 1.5em + 2 * var(--lah-s2) + 2px);max-height:40vh}
.lah-job-row{align-items:flex-start}
.lah-job-row>.lah-chev{align-self:center}
.lah-job-row-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--lah-s1) var(--lah-s2);min-width:0}
/* Two lines say what a task is about; the whole of how it opens is in the job itself. */
.lah-job-task{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;color:var(--lah-fg)}
.lah-job-spent{font-size:var(--lah-fs-xs);color:var(--lah-muted);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.lah-job-block{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-job-label{font-size:var(--lah-fs-xs);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--lah-muted);overflow-wrap:anywhere}
.lah-job-quote{min-width:0;margin:0;padding:var(--lah-s2) var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-lg);background:var(--lah-card);white-space:pre-wrap;overflow-wrap:anywhere}
.lah-job-facts{display:flex;flex-direction:column;min-width:0;margin:0;border:1px solid var(--lah-hairline);border-radius:var(--lah-r-lg);background:var(--lah-card);overflow:hidden}
.lah-job-fact{display:flex;flex-direction:column;gap:1px;min-width:0;padding:var(--lah-s2) var(--lah-s3);border-top:1px solid var(--lah-hairline)}
.lah-job-fact:first-child{border-top:0}
.lah-job-fact>dt{font-size:var(--lah-fs-sm);color:var(--lah-muted);overflow-wrap:anywhere}
.lah-job-fact>dd{margin:0;min-width:0;display:flex;flex-direction:column;overflow-wrap:anywhere}
.lah-job-report{min-width:0;padding:var(--lah-s3);border:1px solid var(--lah-hairline);border-radius:var(--lah-r-lg);background:var(--lah-well);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}
.lah-job-allow{display:flex;flex-direction:column;gap:var(--lah-s2);min-width:0}
.lah-job-allow-row{display:flex;flex-direction:column;gap:var(--lah-s1);min-width:0}
@container lah (min-width:${WIDE_MIN_PX}px){
.lah-job-fact{flex-direction:row;gap:var(--lah-s3)}
.lah-job-fact>dt{flex:0 0 9em}
.lah-job-fact>dd{flex:1 1 0}
}
`;
