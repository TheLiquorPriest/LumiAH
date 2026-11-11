// Jobs (DESIGN §15): agent runs that outlive a reply. The user's two switches over all jobs and the
// limits in force stand at the top with the form that starts a job by hand; under them the jobs,
// newest first, a page at a time. The job picked opens beside the list (in its place on a phone,
// with Back): what it is, its report, and its work as Live shows a reply's turn, with the same held
// calls, notes, pause and stop while it runs. Other pages lead here by setting `nav.job`.

import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ApprovalView, ChatView, JobView, JobsPage as JobsRead, RunningTurn } from "../../../shared/ui";
import { errorWords, useApp } from "../app";
import { ChatBar, chatLabel, useShownChat } from "../chat";
import { Badge, Banner, Button, Check, CopyButton, Disclosure, Editor, Empty, Field, IconButton, NumberField, Seg, type SegOption, Select, Switch, useBusy, useTick } from "../components";
import { ago, count, counted } from "../format";
import { Icon } from "../icons";
import { agentName, ALLOWANCE_FIELDS, ALLOWANCE_MODE_WORDS, type AllowanceDraft, allowanceDraft, allowanceFacts, type AllowanceMode, allowanceOf, clipped, countLine, dayUse, draftAgent, grantBlock, heldStreams, jobActions, jobBadge, jobFacts, jobSentence, limitFacts, needingUser, NO_DRAFT, noWorkWords, openJob, REASON_TITLES, reportName, rowLine, settingsAllowanceWords, shownJobs, startBlock, type StartDraft, startedBy, startNote, type Switches, usageFacts } from "../jobs-model";
import { RunPane, useBlob } from "../runs";
import { openSetting } from "../setting-links";
import { revealInScroller } from "../scroll";
import { useSelect } from "../store";

const NO_CHATS: readonly ChatView[] = [];
const NO_JOBS: readonly JobView[] = [];
const NONE_RUNNING: readonly RunningTurn[] = [];
const NONE_HELD: readonly ApprovalView[] = [];

type Scope = "chat" | "all";

const SCOPES: readonly SegOption<Scope>[] = [
  { value: "chat", label: "This chat's jobs" },
  { value: "all", label: "Every chat's" },
];

const WHENS: readonly SegOption<StartDraft["when"]>[] = [
  { value: "now", label: "Now" },
  { value: "after_reply", label: "After the next reply" },
];

/** What the jobs' list read last: its rows, the cursor to the page after them, and what came with them. */
interface Listed {
  status: "loading" | "ready" | "failed";
  jobs: JobView[];
  next: string | null;
  total: number;
  limits: JobsRead["limits"] | null;
  today: JobsRead["today"];
  agents: JobsRead["agents"];
  message: string;
}

const NOTHING: Listed = { status: "loading", jobs: [], next: null, total: 0, limits: null, today: { tokens: 0 }, agents: [], message: "" };

/**
 * What the start form held when the page was last left: a task half written is there again when
 * the page is shown again, on this device, for as long as the drawer's page lives. Nothing of it
 * is stored.
 */
let keptDraft: StartDraft = NO_DRAFT;

/** The user's switches over all jobs, and the limits Settings put on them with today's use of the day's. */
function Controls(props: { switches: Switches; limits: JobsRead["limits"] | null; today: JobsRead["today"] }) {
  const app = useApp();
  const [busy, run] = useBusy();
  const { off, paused } = props.switches;
  const set = (body: { off?: boolean; paused?: boolean }): void =>
    run(async () => {
      try {
        await app.client.request("lah.jobs.set", body);
      } catch (error) {
        app.fail(error);
      }
    });
  const day = props.limits ? dayUse(props.limits, props.today) : null;
  return (
    // The switches and the limits are for the day something must be held back: folded until asked for, and the fold's own words say when a switch is on or the day's limit is reached.
    <Disclosure
      class="lah-job-card"
      defaultOpen={off || paused}
      summary={
        <span class="lah-inline">
          <Icon name={off || paused || day?.reached === true ? "alert" : "sliders"} size={16} />
          <strong>{off ? "Jobs are switched off" : paused ? "Jobs are paused" : day?.reached === true ? "Today's limit for jobs is reached" : "Switches and limits"}</strong>
        </span>
      }
    >
      <div class="lah-stack" data-lah-job-controls>
      <Switch checked={off} disabled={busy} label="Switch jobs off" help={off ? "Off now: no job may start, by an agent's call or from this page. Those that wait keep waiting." : "While this is on no job may start. Those running go on."} onChange={(on) => set({ off: on })} />
      <Switch checked={paused} disabled={busy} label="Pause jobs" help={paused ? "Paused now: those running are held at their agents' next round, and none starts, until you switch this off." : "Those running are held at their agents' next round, and none starts, until you switch it off."} onChange={(on) => set({ paused: on })} />
      {props.limits && day ? (
        <div class="lah-stack" data-lah-job-limits>
          <span class="lah-job-label">Limits in force</span>
          <dl class="lah-job-limits">
            {limitFacts(props.limits).map((fact) => (
              <div key={fact.label} class="lah-job-limit">
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
          {day.fraction !== null ? (
            <span class={day.reached ? "lah-job-meter lah-is-reached" : "lah-job-meter"} aria-hidden="true">
              <span style={{ width: `${day.fraction * 100}%` }} />
            </span>
          ) : null}
          <p class={day.reached ? "lah-line lah-is-warn" : "lah-small lah-muted"}>
            {day.reached ? <Icon name="alert" size={14} /> : null}
            <span>{day.words}</span>
          </p>
          <div class="lah-actions">
            <Button size="sm" icon="sliders" onClick={() => openSetting(app, "jobsLimits")}>
              Change the limits in Settings
            </Button>
          </div>
        </div>
      ) : null}
      </div>
    </Disclosure>
  );
}

const MODES: readonly AllowanceMode[] = ["settings", "none", "set"];

/** The fields of an allowance (DESIGN §22): for each of tokens in and out, rounds of tool calls and time, Settings' limit, no limit, or a figure set here. */
export function AllowanceFields(props: { draft: AllowanceDraft; onChange(next: AllowanceDraft): void }) {
  const base = useId();
  return (
    <div class="lah-job-allow" data-lah-job-allowance>
      {ALLOWANCE_FIELDS.map(({ key, label, unit, step }) => {
        const member = props.draft[key];
        const id = `${base}-${key}`;
        return (
          <div key={key} class="lah-job-allow-row">
            <label class="lah-field-label" for={id}>
              {label}
            </label>
            <Select id={id} value={member.mode} options={MODES.map((mode) => ({ value: mode, label: ALLOWANCE_MODE_WORDS[mode] }))} onChange={(picked) => props.onChange({ ...props.draft, [key]: { ...member, mode: MODES.find((mode) => mode === picked) ?? member.mode } })} />
            {member.mode === "set" ? (
              <span class="lah-inline">
                <NumberField value={member.value} min={0} step={step} integer label={`${label}, in ${unit}`} onChange={(value) => props.onChange({ ...props.draft, [key]: { ...member, value } })} />
                <span class="lah-small lah-muted">{unit}</span>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Starting a job by hand: as which agent, to do what, and when. */
function StartJob(props: { chatId: string | null; chat: string | null; agents: JobsRead["agents"]; limits: JobsRead["limits"] | null; switches: Switches; onStarted(job: JobView): void }) {
  const app = useApp();
  const [draft, setDraft] = useState<StartDraft>(keptDraft);
  // A task left half written shows at once: closed, it would look as if it were gone.
  const [open, setOpen] = useState(keptDraft.task !== "");
  const [busy, run] = useBusy();
  const agentField = useId();
  const taskField = useId();
  const change = (next: StartDraft): void => {
    keptDraft = next;
    setDraft(next);
  };
  const agent = draftAgent(draft, props.agents);
  const block = startBlock(draft, props.chatId, props.agents);
  const note = startNote(props.switches);
  const start = (): void => {
    const chatId = props.chatId;
    if (block !== null || agent === null || chatId === null) return;
    run(async () => {
      try {
        const r = await app.client.request("lah.job.start", { chatId, agent, task: draft.task.trim(), when: draft.when, ...(draft.allowance !== null ? { allowance: allowanceOf(draft.allowance) } : {}) });
        // The task is done with; the allowance was for that job alone, so the next starts from Settings' limits again.
        change({ ...draft, task: "", allowance: null });
        props.onStarted(r.job);
      } catch (error) {
        app.fail(error);
      }
    });
  };
  return (
    <Disclosure
      class="lah-job-card"
      open={open}
      onToggle={setOpen}
      summary={
        <span class="lah-inline">
          <Icon name="plus" size={16} />
          <strong>Start a job</strong>
        </span>
      }
    >
      <div class="lah-job-form" data-lah-job-start>
        <p class="lah-small lah-muted">{`An agent starts a job by itself when a reply needs longer work; this form starts one by hand.${props.chat !== null ? ` This one belongs to ${props.chat}.` : ""}`}</p>
        <Field label="Agent" for={agentField} help="The agent the job runs as, with that agent's own tools and instructions.">
          <Select id={agentField} value={agent ?? ""} options={props.agents.map((a) => ({ value: a.id, label: a.name }))} disabled={props.agents.length === 0} onChange={(id) => change({ ...draft, agent: id })} />
        </Field>
        <Field label="Task" for={taskField}>
          <Editor id={taskField} prose rows={4} label="The job's task" placeholder="What it is to do, and what its report should say" value={draft.task} onInput={(task) => change({ ...draft, task })} />
        </Field>
        <Seg value={draft.when} options={WHENS} label="When the job starts" onChange={(when) => change({ ...draft, when })} />
        <Check
          checked={draft.allowance !== null}
          label="Give this job a budget of its own"
          help={draft.allowance !== null ? "For a long objective: the agent is told its budget and says, before it works, what it will do with it." : `For a long objective, which plans to what it is given. Without one: ${settingsAllowanceWords(props.limits)}`}
          onChange={(on) => change({ ...draft, allowance: on ? allowanceDraft(undefined, props.limits) : null })}
        />
        {draft.allowance !== null ? <AllowanceFields draft={draft.allowance} onChange={(allowance) => change({ ...draft, allowance })} /> : null}
        {note !== null ? (
          <p class="lah-line lah-is-warn">
            <Icon name="alert" size={14} />
            <span>{note}</span>
          </p>
        ) : null}
        {block !== null ? <p class="lah-field-help">{block}</p> : null}
        <div class="lah-actions">
          <Button variant="primary" icon="play" busy={busy} disabled={block !== null} onClick={start}>
            Start the job
          </Button>
        </div>
      </div>
    </Disclosure>
  );
}

/** A job's report, read by its hash: the text, Copy, and a file of it. */
function Report(props: { job: JobView; hash: string }) {
  const app = useApp();
  const { job } = props;
  const clip = useSelect(app.prefs, (p) => p.clipChars);
  const report = useBlob(props.hash);
  const [whole, setWhole] = useState(false);
  const text = report.text;
  const cut = text === null ? null : whole ? { shown: text, rest: 0 } : clipped(text, clip);
  return (
    <section class="lah-job-block" data-lah-job-report>
      <div class="lah-spread">
        <span class="lah-job-label">{`${job.state === "off_path" ? "Its report, marked off the path" : "Its report"}${job.reportChars !== undefined ? ` · ${counted(job.reportChars, "character")}` : ""}`}</span>
        {text !== null ? (
          <span class="lah-actions">
            <CopyButton text={text} label="Copy the report" variant="secondary">
              Copy
            </CopyButton>
            <Button size="sm" icon="download" onClick={() => app.save(reportName(job), text, "text/markdown")}>
              Save as a file
            </Button>
          </span>
        ) : null}
      </div>
      {report.failed !== null ? (
        <Banner tone="neg" title="The report couldn't be read">
          {report.failed}
        </Banner>
      ) : cut === null ? (
        <p class="lah-job-report lah-muted">{job.opening !== undefined && job.opening !== "" ? `${job.opening} …` : "Reading the report…"}</p>
      ) : (
        <>
          <div class="lah-job-report">{cut.shown}</div>
          {cut.rest > 0 ? (
            <div class="lah-actions">
              <Button size="sm" icon="chevron-down" onClick={() => setWhole(true)}>{`Show the rest (${count(cut.rest)} more characters)`}</Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/** The job open: how it stands, what can be done to it, its task, what it spent, its report and its work. */
function JobDetail(props: { job: JobView; held: ReadonlySet<string>; needs: boolean; switches: Switches; agents: JobsRead["agents"]; limits: JobsRead["limits"] | null; chat: string; onBack(): void; onOpen(id: string): void }) {
  const app = useApp();
  const { job } = props;
  // How long a running job has run is counted in whole seconds, so the page reads the time once a second: no setting would make that clock truer.
  const now = useTick(1000);
  const [cancelling, cancel] = useBusy();
  const [starting, again] = useBusy();
  const [resuming, resume] = useBusy();
  const [granting, grant] = useBusy();
  /** The budget being granted, while Grant more is open. */
  const [more, setMore] = useState<AllowanceDraft | null>(null);
  const badge = jobBadge(job, props.held);
  const actions = jobActions(job);
  const name = agentName(job.agent, props.agents);
  const stop = (): void =>
    cancel(async () => {
      const message = job.state === "running" ? `${name} stops where it is and leaves no report. What it has written to the workspace stays.` : "It won't start. Nothing of it has run, so nothing is lost but the task, which stays here to start again.";
      if (!(await app.host.confirm({ title: "Cancel this job?", message, confirm: "Yes, cancel the job", danger: true }))) return;
      try {
        await app.client.request("lah.job.cancel", { id: job.id });
        app.toast("The job was cancelled.");
      } catch (error) {
        app.fail(error);
      }
    });
  const startAgain = (): void =>
    again(async () => {
      try {
        const r = await app.client.request("lah.job.again", { id: job.id });
        app.toast("Started again, as a new job with the same agent and task.");
        props.onOpen(r.job.id);
      } catch (error) {
        app.fail(error);
      }
    });
  const resumeIt = (): void =>
    resume(async () => {
      try {
        await app.client.request("lah.job.resume", { id: job.id });
        app.toast("Resumed. It runs again from its own session when its turn comes.");
      } catch (error) {
        app.fail(error);
      }
    });
  // A day's limit used nothing of the job's own up: it carries on as it is, with a grant of nothing more.
  const carryOn = (): void =>
    grant(async () => {
      try {
        await app.client.request("lah.job.grant", { id: job.id, allowance: {} });
        app.toast("It carries on from where it stopped. If the day's limit still stands, it pauses there again.");
      } catch (error) {
        app.fail(error);
      }
    });
  const grantBlocked = more !== null ? grantBlock(more, job.allowance) : null;
  const grantIt = (): void => {
    if (more === null || grantBlocked !== null) return;
    grant(async () => {
      try {
        await app.client.request("lah.job.grant", { id: job.id, allowance: allowanceOf(more) });
        setMore(null);
        app.toast("Granted. It carries on from its own session when its turn comes.");
      } catch (error) {
        app.fail(error);
      }
    });
  };
  const allowed = allowanceFacts(job);
  const parent = job.parent;
  const over = job.state !== "queued" && job.state !== "running";
  // A job that carries on (granted more, or resumed) still names its last run's transcript while it waits for its next run and while that is under way: what runs is followed live, and the transcript is read once the run has ended.
  const stored = over ? (job.transcript ?? null) : null;
  const work = <RunPane stream={job.id} transcript={stored} none={<p class="lah-lead lah-small">{noWorkWords(job)}</p>} />;
  return (
    <>
      <div class="lah-pane-head" data-lah-job-open={job.id} data-state={job.state}>
        <span class="lah-back">
          <IconButton icon="chevron-left" label="Back to the jobs" onClick={props.onBack} />
        </span>
        <span class="lah-pane-title">
          <strong class="lah-h">{name}</strong>
          <span class="lah-inline">
            <Badge tone={badge.tone}>
              <Icon name={badge.icon} size={12} />
              {badge.word}
            </Badge>
            {props.needs ? (
              <Badge tone="warn">
                <Icon name="shield" size={12} />
                needs you
              </Badge>
            ) : null}
            <span class="lah-dim lah-small">{`by ${startedBy(job)} · ${ago(now, job.createdAt)}`}</span>
          </span>
        </span>
        {actions.cancel ? (
          <Button icon="stop" busy={cancelling} onClick={stop}>
            Cancel
          </Button>
        ) : null}
        {actions.resume ? (
          <Button variant="primary" icon="play" busy={resuming} onClick={resumeIt}>
            Resume
          </Button>
        ) : null}
        {actions.grant ? (
          <Button variant="primary" icon="coins" expanded={more !== null} onClick={() => setMore(more === null ? allowanceDraft(job.allowance, props.limits) : null)}>
            Grant more
          </Button>
        ) : null}
        {actions.carryOn ? (
          <>
            <Button variant="primary" icon="play" busy={granting} onClick={carryOn}>
              Carry on
            </Button>
            <Button icon="coins" onClick={() => app.nav.update((n) => ({ ...n, page: "spend" }))}>
              See the day's limits
            </Button>
          </>
        ) : null}
        {actions.again ? (
          <Button variant="primary" icon="refresh" busy={starting} onClick={startAgain}>
            Start again
          </Button>
        ) : null}
      </div>
      <p class="lah-line">
        <Icon name="info" size={14} />
        <span>{jobSentence(job, props.held, props.switches)}</span>
      </p>
      {props.needs ? (
        <Banner tone="warn" title="It needs you">
          It holds a tool call for your word. Answer it under Its work, below: it waits there until you do, or until the wait runs out.
        </Banner>
      ) : null}
      {job.reason !== undefined ? (
        <Banner tone={job.state === "failed" ? "neg" : "warn"} title={REASON_TITLES[job.state]}>
          {job.reason}
        </Banner>
      ) : null}
      {actions.grant && more !== null ? (
        <section class="lah-job-card" data-lah-job-grant>
          <span class="lah-job-label">Its budget in all from now on</span>
          <p class="lah-small lah-muted">The fields start from what it had. Raise the limit it ran out at, or lift it: what it has spent already counts against the new figures, and it carries on from where it stopped.</p>
          <AllowanceFields draft={more} onChange={setMore} />
          {grantBlocked !== null ? <p class="lah-field-help">{grantBlocked}</p> : null}
          <div class="lah-actions">
            <Button variant="primary" icon="check" busy={granting} disabled={grantBlocked !== null} onClick={grantIt}>
              Grant and carry on
            </Button>
            <Button variant="ghost" onClick={() => setMore(null)}>
              Close
            </Button>
          </div>
        </section>
      ) : null}
      <section class="lah-job-block">
        <span class="lah-job-label">Its task, as it opens</span>
        <p class="lah-job-quote">{job.task}</p>
      </section>
      <Disclosure summary={<span class="lah-small">About this job: its chat, its turn, its times</span>}>
        <dl class="lah-job-facts" data-lah-job-facts>
          {jobFacts(job, { agents: props.agents, chat: props.chat, now }).map((fact) => (
            <div key={fact.label} class="lah-job-fact">
              <dt>{fact.label}</dt>
              <dd>
                <span>{fact.value}</span>
                {fact.sub !== undefined ? <span class="lah-dim lah-small">{fact.sub}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      </Disclosure>
      {job.report !== undefined ? <Report key={job.report} job={job} hash={job.report} /> : null}
      {parent !== undefined ? (
        <div class="lah-actions">
          <Button size="sm" icon="arrow-right" onClick={() => props.onOpen(parent)}>
            Open the job that started it
          </Button>
        </div>
      ) : null}
      {allowed.length > 0 ? (
        <section class="lah-job-block" data-lah-job-allowed>
          <span class="lah-job-label">Its budget, against what it spent</span>
          <div class="lah-statgrid">
            {allowed.map((fact) => (
              <div key={fact.label} class="lah-statcard">
                <span class="lah-statcard-label">{fact.label}</span>
                <span class="lah-statcard-value">{fact.value}</span>
                {fact.sub !== undefined ? <span class="lah-statcard-sub">{fact.sub}</span> : null}
              </div>
            ))}
          </div>
          <p class="lah-small lah-muted">Where it names no figure, Settings' limit for each job stands.</p>
        </section>
      ) : null}
      <section class="lah-job-block">
        <span class="lah-job-label">{over ? "What it spent" : "What it has spent so far"}</span>
        <div class="lah-statgrid">
          {usageFacts(job.usage).map((fact) => (
            <div key={fact.label} class="lah-statcard">
              <span class="lah-statcard-label">{fact.label}</span>
              <span class="lah-statcard-value">{fact.value}</span>
              {fact.sub !== undefined ? <span class="lah-statcard-sub">{fact.sub}</span> : null}
            </div>
          ))}
        </div>
      </section>
      <section class="lah-job-block" data-lah-job-work>
        <span class="lah-job-label">Its work</span>
        {/* A run that ended can be long, so it is read on request; one under way, or yet to start, shows as it happens. */}
        {stored !== null ? <Disclosure summary={<span class="lah-small">{over ? "Its work, step by step" : "Its last run, step by step"}</span>}>{work}</Disclosure> : work}
      </section>
    </>
  );
}

export function JobsPage() {
  const app = useApp();
  const chatId = useShownChat();
  const open = useSelect(app.nav, (n) => n.job);
  const pageTurns = useSelect(app.prefs, (p) => p.pageTurns);
  const chats = useSelect(app.client.state, (s) => s?.chats ?? NO_CHATS);
  const active = useSelect(app.client.state, (s) => s?.jobs.active ?? NO_JOBS);
  const off = useSelect(app.client.state, (s) => s?.jobs.off ?? false);
  const paused = useSelect(app.client.state, (s) => s?.jobs.paused ?? false);
  const changed = useSelect(app.client.state, (s) => s?.jobs.changed ?? 0);
  const running = useSelect(app.client.state, (s) => s?.running ?? NONE_RUNNING);
  const approvals = useSelect(app.client.state, (s) => s?.approvals ?? NONE_HELD);
  const [scope, setScope] = useState<Scope>("chat");
  const [list, setList] = useState<Listed>(NOTHING);
  const [reading, more] = useBusy();
  /** Whose jobs the list holds: the shown chat's, or (null) every chat's, which is all there is to show while no chat is open. */
  const of = scope === "chat" ? chatId : null;
  /** The read that counts: a slower answer to an earlier one is dropped. */
  const asked = useRef(0);
  /** How many rows the list holds, and whose: reading it again keeps what Show more brought. */
  const rows = useRef<{ of: string | null; count: number }>({ of, count: 0 });
  const read = (): void => {
    const mine = (asked.current += 1);
    const limit = Math.max(pageTurns, rows.current.of === of ? rows.current.count : 0);
    app.client.request("lah.jobs.list", { chatId: of, cursor: null, limit }).then(
      (r) => {
        if (mine !== asked.current) return;
        rows.current = { of, count: r.jobs.length };
        setList({ status: "ready", jobs: r.jobs, next: r.next, total: r.total, limits: r.limits, today: r.today, agents: r.agents, message: "" });
      },
      (e: unknown) => mine === asked.current && setList((held) => ({ ...held, status: "failed", message: errorWords(e) })),
    );
  };
  const showMore = (): void =>
    more(async () => {
      const cursor = list.next;
      if (cursor === null) return;
      const mine = (asked.current += 1);
      try {
        const r = await app.client.request("lah.jobs.list", { chatId: of, cursor, limit: pageTurns });
        if (mine !== asked.current) return;
        const jobs = [...list.jobs, ...r.jobs.filter((j) => !list.jobs.some((had) => had.id === j.id))];
        rows.current = { of, count: jobs.length };
        setList((held) => ({ ...held, jobs, next: r.next, total: r.total }));
      } catch (error) {
        app.fail(error);
      }
    });
  // Another chat's jobs are another list: the rows of the one before don't stand in for it while it is read.
  useEffect(() => {
    setList((held) => (held.status === "loading" ? held : { ...held, status: "loading", jobs: [], next: null, total: 0 }));
  }, [of]);
  // The state's counter moves whenever any job changes: the list is read again, as it is when the page is shown again.
  useEffect(() => {
    read();
    return app.client.onBack(read);
  }, [of, changed, pageTurns]);

  const switches: Switches = { off, paused };
  const held = heldStreams(running);
  const needs = needingUser(approvals);
  const shown = shownJobs(list.jobs, active, of, list.next !== null);
  const job = openJob(open, shown, active);
  const now = app.now();
  const chatName = (id: string): string => chatLabel(chats.find((c) => c.chatId === id) ?? { chatId: id, name: null });
  const select = (id: string | null): void => app.nav.update((n) => ({ ...n, job: id }));
  // A job picked from the list starts at its head: the panel may be scrolled far down the list.
  const detail = useRef<HTMLDivElement>(null);
  const shownId = job?.id ?? null;
  useLayoutEffect(() => {
    if (shownId !== null) revealInScroller(detail.current, "start");
  }, [shownId]);
  const missing = open !== null && job === null && list.status === "ready";
  return (
    <div class="lah-split" data-pane={job !== null || (open !== null && list.status === "loading") ? "detail" : "list"} data-lah-view="jobs">
      <div class="lah-split-list">
        <ChatBar aside={<IconButton icon="refresh" label="Read the jobs again" onClick={read} />} />
        {chatId !== null ? <Seg value={scope} options={SCOPES} label="Whose jobs the list shows" onChange={(next) => setScope(next)} /> : <p class="lah-small lah-muted">No chat is open, so the list shows the jobs of every chat. Open a chat, or pick one above, to see its own and to start one in it.</p>}
        <StartJob
          chatId={chatId}
          chat={chatId !== null ? chatName(chatId) : null}
          agents={list.agents}
          limits={list.limits}
          switches={switches}
          onStarted={(started) => {
            select(started.id);
            read();
          }}
        />
        <Controls switches={switches} limits={list.limits} today={list.today} />
        {list.status === "failed" ? (
          <Banner
            tone="neg"
            title="The jobs couldn't be read"
            actions={
              <Button size="sm" icon="refresh" onClick={read}>
                Try again
              </Button>
            }
          >
            {list.message}
          </Banner>
        ) : null}
        {missing ? (
          <Banner
            tone="info"
            title="The job you came for isn't in this list"
            actions={
              <>
                {of !== null ? (
                  <Button size="sm" onClick={() => setScope("all")}>
                    Show every chat's jobs
                  </Button>
                ) : null}
                {list.next !== null ? (
                  <Button size="sm" busy={reading} onClick={showMore}>
                    Show more
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => select(null)}>
                  Dismiss
                </Button>
              </>
            }
          >
            It may belong to another chat, stand further down the list, or be gone.
          </Banner>
        ) : null}
        {list.status === "loading" && shown.length === 0 ? <Empty icon="hourglass">Reading the jobs…</Empty> : null}
        {list.status === "ready" && shown.length === 0 ? (
          <Empty icon="layers" title={of !== null ? "This chat has no job yet" : "No job yet"}>
            A job is longer work an agent does in the background, beside a reply or after it. An agent starts one when a reply needs it, or you start one with Start a job, above. Each shows here with how it stands, what it spent and its report.
          </Empty>
        ) : null}
        {shown.length > 0 ? (
          <>
            {list.status === "ready" ? <p class="lah-small lah-muted">{countLine(Math.max(list.total, shown.length), shown.length, of !== null ? "chat" : "all")}</p> : null}
            <nav class="lah-navlist" aria-label="Jobs, newest first">
              {shown.map((j) => {
                const badge = jobBadge(j, held);
                return (
                  <button key={j.id} type="button" class="lah-navrow lah-job-row" data-lah-job={j.id} data-state={j.state} aria-current={j.id === shownId ? "true" : undefined} onClick={() => select(j.id)}>
                    <span class="lah-navrow-text">
                      <span class="lah-job-row-head">
                        <span class="lah-navrow-title">{agentName(j.agent, list.agents)}</span>
                        <Badge tone={badge.tone}>
                          <Icon name={badge.icon} size={12} />
                          {badge.word}
                        </Badge>
                        {needs.has(j.id) ? (
                          <Badge tone="warn">
                            <Icon name="shield" size={12} />
                            needs you
                          </Badge>
                        ) : null}
                      </span>
                      <span class="lah-navrow-sub lah-job-task">{j.task}</span>
                      <span class="lah-job-spent">{`${rowLine(j, now)}${of === null ? ` · ${chatName(j.chatId)}` : ""}`}</span>
                    </span>
                    <Icon name="chevron-right" size={16} class="lah-chev" />
                  </button>
                );
              })}
            </nav>
            {list.next !== null ? (
              <div class="lah-actions">
                <Button icon="chevron-down" busy={reading} onClick={showMore}>
                  Show more
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <div class="lah-split-detail" ref={detail}>
        {job ? (
          <JobDetail key={job.id} job={job} held={held} needs={needs.has(job.id)} switches={switches} agents={list.agents} limits={list.limits} chat={chatName(job.chatId)} onBack={() => select(null)} onOpen={select} />
        ) : open !== null && list.status === "loading" ? (
          <Empty icon="hourglass">Reading the job…</Empty>
        ) : (
          <Empty icon="layers" title="Pick a job">
            Its task, its report, what it spent and its work, step by step, show here. While it runs you can answer a tool call it holds for your word, say something to it, pause it and stop it.
          </Empty>
        )}
      </div>
    </div>
  );
}
