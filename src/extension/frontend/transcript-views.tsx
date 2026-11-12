// The other views of a turn (transcript.tsx holds the feed): a call's exact prompt, read when it is
// opened; the totals, with tokens, time and cost for the turn, per agent and per call, and where the
// turn's time went call by call; and the turn's events exactly as the runtime traced them.

import { useEffect, useMemo, useState } from "preact/hooks";
import type { CallPrompt, LiveEvent, LiveView, ModelMessage, ModelPart, TraceEvent } from "../../shared/ui";
import { errorWords, useApp } from "./app";
import { Badge, Button, CopyButton, Disclosure, Empty, Section } from "./components";
import { clock, compact, count, counted, duration, money } from "./format";
import { Icon } from "./icons";
import { AGENT_STATE_WORDS, type AgentTotals, agentLabel, type CallRow, costWords, heldLine, onConnection, promptFacts, type Totals, totalCostWords, type TurnTotals, type TurnView } from "./live-model";
import { type Folds, TextBlock } from "./feed-parts";

// ---------------------------------------------------------------- the exact prompt

/** A message part as the prompt view shows it. */
function partText(p: ModelPart): string {
  switch (p.type) {
    case "text":
      return p.text;
    case "tool_use":
      return `→ ${p.name} ${JSON.stringify(p.input, null, 2)}`;
    case "tool_result":
      return `← ${p.isError ? "failed: " : ""}${p.content}`;
    case "media":
      // Base64 holds three bytes in four characters.
      return `[${p.media}, ${p.mimeType}, about ${compact(Math.round((p.data.length * 3) / 4))} bytes]`;
  }
}

function messageText(m: ModelMessage): string {
  const body = m.parts && m.parts.length > 0 ? m.parts.map(partText).join("\n\n") : m.content;
  return m.reasoning ? `[thinking sent back]\n${m.reasoning}\n\n${body}` : body;
}

type PromptState = { status: "loading" } | { status: "ready"; prompt: CallPrompt } | { status: "failed"; message: string };

/** A call's exact request, read when it opens: where it went, with what, and every message and tool it carried. `connection` names a connection as the runtime that plays the transcript's chat lists it, else by its id. */
function PromptView(props: { hash: string; item: string; folds: Folds; connection(id: string): string }) {
  const app = useApp();
  const [state, setState] = useState<PromptState>({ status: "loading" });
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    app.client.request("lah.prompt.get", { prompt: props.hash }).then(
      (r) => live && setState({ status: "ready", prompt: r.prompt }),
      (e: unknown) => live && setState({ status: "failed", message: errorWords(e) }),
    );
    return () => {
      live = false;
    };
  }, [props.hash, tries]);
  if (state.status === "loading") return <p class="lah-line lah-dim">Reading the exact prompt…</p>;
  if (state.status === "failed")
    return (
      <p class="lah-line lah-is-warn">
        <Icon name="alert" size={14} />
        <span>{`The prompt couldn't be read: ${state.message}`}</span>
        <Button size="sm" icon="refresh" onClick={() => setTries((n) => n + 1)}>
          Try again
        </Button>
      </p>
    );
  const p = state.prompt;
  const json = JSON.stringify(p, null, 2);
  const tools = p.tools ?? [];
  const chars = p.messages.reduce((n, m) => n + messageText(m).length, 0);
  const facts = promptFacts(p, props.connection);
  return (
    <div class="lah-prompt" data-lah-prompt={props.hash}>
      <p class="lah-prompt-facts">{facts.join(" · ")}</p>
      <p class="lah-prompt-facts">{`${counted(p.messages.length, "message")} · ${count(chars)} characters · ${counted(tools.length, "tool")} offered`}</p>
      <div class="lah-actions">
        <CopyButton text={json} label="Copy the prompt as JSON" variant="secondary">
          Copy JSON
        </CopyButton>
        <Button size="sm" icon="download" onClick={() => app.save(`lumiah-prompt-${props.hash.slice(0, 12)}.json`, json, "application/json")}>
          Save .json
        </Button>
      </div>
      {tools.length > 0 ? (
        <Disclosure summary={`${counted(tools.length, "tool")} offered`}>
          {tools.map((t) => (
            <TextBlock key={t.name} item={`${props.item}:tool:${t.name}`} kind="told" title={t.name} text={`${t.description}\n\n${JSON.stringify(t.parameters, null, 2)}`} folds={props.folds} />
          ))}
        </Disclosure>
      ) : null}
      {p.messages.map((m, i) => (
        <TextBlock key={i} item={`${props.item}:msg:${i}`} kind={m.role} title={`${i + 1} · ${m.role}`} text={messageText(m)} folds={props.folds} />
      ))}
    </div>
  );
}

/** The exact prompt of a call, on request; `connection` names the call's connection (`PromptView`). */
export function PromptBlock(props: { hash: string; item: string; folds: Folds; connection(id: string): string }) {
  const { folds } = props;
  const open = folds.open(props.item, false);
  return (
    <details class="lah-block" data-kind="prompt" open={open} data-lah-key={props.item} onToggle={(event) => folds.set(props.item, event.currentTarget.open)}>
      <summary>
        <Icon name="chevron-right" size={14} class="lah-caret" />
        <span class="lah-block-title">Exact prompt</span>
        <span class="lah-block-preview">what this call was sent, whole</span>
        <span class="lah-block-meta">{props.hash.slice(0, 10)}</span>
      </summary>
      {open ? (
        <div class="lah-block-body">
          <PromptView hash={props.hash} item={props.item} folds={folds} connection={props.connection} />
        </div>
      ) : null}
    </details>
  );
}

// ---------------------------------------------------------------- totals

function StatCard(props: { label: string; value: string; sub?: string }) {
  return (
    <div class="lah-statcard" data-lah-stat={props.label}>
      <span class="lah-statcard-label">{props.label}</span>
      <span class="lah-statcard-value">{props.value}</span>
      {props.sub ? <span class="lah-statcard-sub">{props.sub}</span> : null}
    </div>
  );
}

const est = (on: boolean): string => (on ? "≈" : "");

/** The cells every sum shares: calls, tokens in and out, times, cost. */
function SumCells(props: { t: Totals; wallMs: number }) {
  const { t } = props;
  return (
    <>
      <span class="lah-tcell lah-is-n" data-label="Calls">
        {count(t.calls)}
      </span>
      <span class="lah-tcell lah-is-n" data-label="Tokens in">{`${est(t.estimated)}${count(t.in)}`}</span>
      <span class="lah-tcell lah-is-n" data-label="Of them cached">
        {count(t.cachedIn)}
      </span>
      <span class="lah-tcell lah-is-n" data-label="Tokens out">{`${est(t.estimated)}${count(t.out)}`}</span>
      <span class="lah-tcell lah-is-n" data-label="Of them reasoning">
        {count(t.reasoningOut)}
      </span>
      <span class="lah-tcell lah-is-n" data-label="Model time">
        {duration(t.modelMs)}
      </span>
      <span class="lah-tcell lah-is-n" data-label="Tool calls">{t.toolErrors > 0 ? `${count(t.toolCalls)} (${count(t.toolErrors)} failed)` : count(t.toolCalls)}</span>
      <span class="lah-tcell lah-is-n" data-label="Tool time">
        {duration(t.toolMs)}
      </span>
      <span class="lah-tcell lah-is-n" data-label="Start to end">
        {duration(props.wallMs)}
      </span>
      <span class="lah-tcell lah-is-n" data-label="Cost">
        {totalCostWords(t)}
      </span>
    </>
  );
}

const AGENT_COLS = "minmax(0,2.2fr) minmax(0,.7fr) repeat(4,minmax(0,1fr)) minmax(0,1.1fr) minmax(0,1.1fr) minmax(0,1.1fr) minmax(0,1.1fr) minmax(0,1.5fr)";
const CALL_COLS = "minmax(0,1.6fr) minmax(0,1.8fr) repeat(4,minmax(0,1fr)) minmax(0,1fr) minmax(0,.8fr) minmax(0,1.1fr) minmax(0,1.1fr) minmax(0,1.8fr)";

function AgentRow(props: { t: AgentTotals }) {
  const a = props.t.agent;
  return (
    <div class="lah-trow" role="row" data-lah-agent-totals={a.start.id}>
      <span class="lah-tcell lah-is-lead" data-label="Agent">
        <span>
          {agentLabel(a.start)} <span class="lah-dim lah-small">{AGENT_STATE_WORDS[a.state]}</span>
        </span>
      </span>
      <SumCells t={props.t} wallMs={props.t.wallMs} />
    </div>
  );
}

function CallRowView(props: { c: CallRow; role: string; on: string; start: number; span: number }) {
  const { c } = props;
  const u = c.usage;
  const mark = (field: "in" | "cachedIn" | "out" | "reasoningOut" | "cost"): string => est(u.estimated.includes(field));
  // Where the call sits in the turn's time, as shares of it: when it was asked, how long it took, and its tools' times after it.
  const left = Math.min(100, Math.max(0, ((c.startedAt - props.start) / props.span) * 100));
  const width = Math.min(100 - left, (c.ms / props.span) * 100);
  const toolWidth = Math.min(100 - left - width, (c.toolMs / props.span) * 100);
  return (
    <div class="lah-trow" role="row" data-lah-call-totals={c.seq}>
      <span class="lah-tcell lah-is-lead" data-label="Call">{`${props.role} · call ${c.call}`}</span>
      <span class="lah-tcell" data-label="Model">
        {c.model || "model"} <span class="lah-dim lah-small">{props.on}</span>
      </span>
      <span class="lah-tcell lah-is-n" data-label="Tokens in">{`${mark("in")}${count(u.in)}`}</span>
      <span class="lah-tcell lah-is-n" data-label="Of them cached">{`${mark("cachedIn")}${count(u.cachedIn)}`}</span>
      <span class="lah-tcell lah-is-n" data-label="Tokens out">{`${mark("out")}${count(u.out)}`}</span>
      <span class="lah-tcell lah-is-n" data-label="Of them reasoning">{`${mark("reasoningOut")}${count(u.reasoningOut)}`}</span>
      <span class="lah-tcell lah-is-n" data-label="Time">
        {duration(c.ms)}
      </span>
      <span class="lah-tcell lah-is-n" data-label="Tool calls">{c.tools > 0 ? `${count(c.tools)} (${duration(c.toolMs)})` : "0"}</span>
      <span class="lah-tcell lah-is-n" data-label="Cost">
        {u.cost === undefined ? "unknown" : `${mark("cost")}${money(u.cost)}`}
      </span>
      <span class="lah-tcell lah-is-n" data-label="Finished">
        {c.finishReason || "stop"}
      </span>
      <span class="lah-tcell lah-is-bar" data-label="When">
        <span class="lah-water" role="img" aria-label={`Asked ${duration(Math.max(0, c.startedAt - props.start))} into the turn, took ${duration(c.ms)}`}>
          <span style={{ left: `${left}%`, width: `${width}%` }} />
          {c.toolMs > 0 ? <span class="lah-is-tool" style={{ left: `${left + width}%`, width: `${toolWidth}%` }} /> : null}
        </span>
      </span>
    </div>
  );
}

/** The turn's totals: its figures, then each agent's, then each call's with where it sat in the turn's time and the connection it went on (`connection` names one as the runtime that plays the transcript's chat lists it, where the trace kept no name). */
export function TotalsView(props: { turn: TurnView; totals: TurnTotals; connection(id: string): string }) {
  const { totals, turn } = props;
  const t = totals.turn;
  const role = new Map(totals.agents.map((a) => [a.agent.start.id, agentLabel(a.agent.start)]));
  const span = Math.max(1, t.wallMs);
  if (totals.agents.length === 0) return <Empty icon="table">No agent has run in this turn yet, so there is nothing to add up.</Empty>;
  return (
    <div class="lah-stack" data-lah-totals>
      <div class="lah-statgrid">
        <StatCard label="Calls" value={count(t.calls)} sub={counted(totals.agents.length, "agent")} />
        <StatCard label="Tokens in" value={`${est(t.estimated)}${count(t.in)}`} sub={`${count(t.cachedIn)} read from cache${t.cacheWrite > 0 ? ` · ${count(t.cacheWrite)} written to it` : ""}`} />
        <StatCard label="Tokens out" value={`${est(t.estimated)}${count(t.out)}`} sub={`${count(t.reasoningOut)} of them reasoning`} />
        <StatCard label="Model time" value={duration(t.modelMs)} sub="its calls' times added up" />
        <StatCard label="Tool calls" value={count(t.toolCalls)} sub={`${duration(t.toolMs)}${t.toolErrors > 0 ? ` · ${count(t.toolErrors)} failed` : ""}`} />
        <StatCard label="Start to end" value={duration(t.wallMs)} sub={turn.view.ended ? "by the clock" : "so far"} />
        <StatCard label="Cost" value={totalCostWords(t)} sub={turn.spent ? `the runtime's own count: ${costWords(turn.spent)}` : undefined} />
      </div>
      <Section title="By agent">
        <div class="lah-table" role="table" aria-label="Tokens, time and cost by agent" style={{ "--lah-cols": AGENT_COLS }}>
          <div class="lah-thead" role="row">
            <span>Agent</span>
            <span class="lah-is-n">Calls</span>
            <span class="lah-is-n">In</span>
            <span class="lah-is-n">Cached</span>
            <span class="lah-is-n">Out</span>
            <span class="lah-is-n">Reasoning</span>
            <span class="lah-is-n">Model time</span>
            <span class="lah-is-n">Tool calls</span>
            <span class="lah-is-n">Tool time</span>
            <span class="lah-is-n">Start to end</span>
            <span class="lah-is-n">Cost</span>
          </div>
          {totals.agents.map((a) => (
            <AgentRow key={a.agent.start.id} t={a} />
          ))}
          <div class="lah-trow lah-is-sum" role="row" data-lah-agent-totals="all">
            <span class="lah-tcell lah-is-lead" data-label="Agent">
              The turn
            </span>
            <SumCells t={t} wallMs={t.wallMs} />
          </div>
        </div>
      </Section>
      <Section title="By call">
        {totals.calls.length === 0 ? (
          <p class="lah-lead">No call has answered yet.</p>
        ) : (
          <>
            <div class="lah-table" role="table" aria-label="Tokens, time and cost by call" style={{ "--lah-cols": CALL_COLS }}>
              <div class="lah-thead" role="row">
                <span>Call</span>
                <span>Model</span>
                <span class="lah-is-n">In</span>
                <span class="lah-is-n">Cached</span>
                <span class="lah-is-n">Out</span>
                <span class="lah-is-n">Reasoning</span>
                <span class="lah-is-n">Time</span>
                <span class="lah-is-n">Tool calls</span>
                <span class="lah-is-n">Cost</span>
                <span class="lah-is-n">Finished</span>
                <span>When in the turn</span>
              </div>
              {totals.calls.map((c) => (
                <CallRowView key={c.seq} c={c} role={role.get(c.agentId) ?? c.agentId} on={onConnection(c.on, props.connection)} start={turn.view.startedAt} span={span} />
              ))}
            </div>
            <p class="lah-legend">
              <span>
                <span class="lah-swatch" /> the model answering
              </span>
              <span>
                <span class="lah-swatch lah-is-tool" /> the tools it called, their times added up
              </span>
            </p>
          </>
        )}
      </Section>
      <p class="lah-lead lah-small">≈ marks a count the provider didn't report, which holds the runtime's estimate. A cost marked ≈ is no bill: it is worked out from your price for the model in Settings, else from the provider's published price where the runtime knows it. A cost is unknown where the provider named none and no price is known for the model.</p>
    </div>
  );
}

// ---------------------------------------------------------------- events

/** When an event happened: an agent's start and an agent's step carry their time inside. */
function eventAt(e: TraceEvent): number {
  switch (e.kind) {
    case "agent_started":
      return e.agent.at;
    case "agent_entry":
      return e.entry.at;
    default:
      return e.at;
  }
}

/** An event in a few words, for its line. */
function eventWords(e: TraceEvent): string {
  switch (e.kind) {
    case "turn_started":
      return `${e.generation}${e.messageId ? ` → message ${e.messageId}` : ""}`;
    case "session":
      return `${counted(e.session.turns, "turn")}, ≈${count(e.session.tokens)} tokens${e.session.summary ? ", after a summary" : ""}`;
    case "prompt_held":
      return heldLine(e);
    case "agent_started":
      return `${e.agent.role} (${e.agent.id})${e.agent.parent ? `, started by ${e.agent.parent}` : ""}`;
    case "agent_entry": {
      const x = e.entry;
      const WHAT: Readonly<Record<typeof x.kind, () => string>> = {
        message: () => "message",
        notice: () => "a word from the runtime",
        note: () => "a note from the user",
        answer: () => (x.kind === "answer" ? `answer, ${counted(x.calls.length, "tool call")}, ${x.finishReason || "stop"}` : ""),
        result: () => (x.kind === "result" ? `result of ${x.name}${x.error ? " (failed)" : ""}${x.files && x.files.length > 0 ? `, ${counted(x.files.length, "file")} changed` : ""}` : ""),
        stop: () => (x.kind === "stop" ? `stop: ${x.code}` : ""),
        tools_refused: () => "native tools refused",
        retry: () => (x.kind === "retry" ? `call failed, try ${x.attempt} of ${x.of}` : ""),
        approval_asked: () => (x.kind === "approval_asked" ? `${x.tool} held for the user's word` : ""),
        approval: () => (x.kind === "approval" ? `held call ${x.decision.replace("_", " ")}` : ""),
      };
      return `${e.agentId} · ${WHAT[x.kind]()}`;
    }
    case "usage":
      return `${e.agentId} · ${count(e.call.in)} in · ${count(e.call.out)} out`;
    case "agent_idle":
      return `${e.agentId} finished its message`;
    case "turn_paused":
      return "the user paused the run";
    case "turn_resumed":
      return "the user let the run go on";
    case "job":
      return `job ${e.job.id} as ${e.job.agent}, ${e.job.when === "now" ? "now" : "after the reply"}`;
    case "notice":
      return e.text;
    case "turn_ended":
      return `${e.status}${e.reason ? `: ${e.reason}` : ""}`;
  }
}

function EventRow(props: { record: LiveEvent; start: number }) {
  const [open, setOpen] = useState(false);
  const { record } = props;
  const at = eventAt(record.event);
  const json = open ? JSON.stringify(record.event, null, 2) : "";
  return (
    <details class="lah-event" open={open} data-lah-event={record.seq} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <Icon name="chevron-right" size={14} class="lah-caret" />
        <span class="lah-event-seq">{record.seq}</span>
        <span class="lah-event-kind">{record.event.kind}</span>
        <span class="lah-event-what">{eventWords(record.event)}</span>
        <span class="lah-event-at">{`+${duration(Math.max(0, at - props.start))}`}</span>
      </summary>
      {open ? (
        <div class="lah-block-body">
          <div class="lah-block-actions">
            <span class="lah-dim lah-small">{clock(at)}</span>
            <CopyButton text={json} label={`Copy event ${record.seq} as JSON`}>
              Copy
            </CopyButton>
          </div>
          <pre class="lah-text">{json}</pre>
        </div>
      ) : null}
    </details>
  );
}

/** The turn's events as traced, in order, the latest `page` of them first shown; a search keeps those whose JSON holds it. */
export function EventsView(props: { view: LiveView; query: string; page: number }) {
  const [shown, setShown] = useState(props.page);
  const q = props.query.trim().toLowerCase();
  const kept = useMemo(() => (q === "" ? props.view.events : props.view.events.filter((r) => JSON.stringify(r.event).toLowerCase().includes(q))), [props.view.events, q]);
  const hidden = Math.max(0, kept.length - shown);
  const rows = hidden > 0 ? kept.slice(hidden) : kept;
  if (props.view.events.length === 0) return <Empty icon="code">No event has been traced for this turn yet.</Empty>;
  return (
    <div class="lah-events" data-lah-events>
      <p class="lah-line lah-dim">
        <span>{q === "" ? `${counted(kept.length, "event")}.` : `${counted(kept.length, "event")} of ${count(props.view.events.length)} hold “${props.query.trim()}”.`}</span>
        <Badge>{`turn ${props.view.turn.slice(0, 8)}`}</Badge>
      </p>
      {hidden > 0 ? (
        <div class="lah-mark">
          <Button size="sm" icon="chevron-up" onClick={() => setShown((n) => n + props.page)}>
            {`Show ${counted(Math.min(props.page, hidden), "earlier event")} (${count(hidden)} not shown)`}
          </Button>
        </div>
      ) : null}
      {rows.map((r) => (
        <EventRow key={r.seq} record={r} start={props.view.startedAt} />
      ))}
    </div>
  );
}
