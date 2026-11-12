// A turn's transcript as the Live page shows it while it runs and Sessions shows it once stored
// (`live-model.ts` reads the trace and lays out the feed): its head (what it answers, how it stands,
// its time, tokens and cost, Stop while it runs, Copy and Export), its views (the steps, the totals,
// the events as traced), an outline of the agents and the filters (by agent, by kind of step, by
// tool, only what went wrong), a search with its finds stepped through one by one, and the feed:
// each agent with what it was told, each call with its figures, its thinking, its answer, its tool
// calls (each a card holding its arguments and its result) and its exact prompt on request, each
// stop, what it waits on now, and what it spent. A long transcript shows its latest steps and the
// earlier ones a page at a time; a long text shows its start and the rest on request; and well down
// a long transcript, "Back to top" at its foot goes back up in one press (to-top-model.ts).

import type { ComponentChildren, RefObject } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { type CallPrompt, isReply, type LiveView, replyDid } from "../../shared/ui";
import { errorWords, useApp } from "./app";
import { Badge, Button, Chip, CopyButton, Disclosure, IconButton, SearchField, Seg, Select, type Tone, useBusy } from "./components";
import type { FileChange } from "../../shared/ui";
import { clock, compact, count, counted, dateTime, duration, elapsed } from "./format";
import { Icon } from "./icons";
import {
  loreNamesWords,
  mendOf,
  activityWords,
  streamingWords,
  AGENT_STATE_WORDS,
  type AgentFeed,
  type AgentState,
  type AgentTotals,
  agentModel,
  agentMs,
  ALL_KINDS,
  callWords,
  fileChangeWord,
  filePath,
  wordWords,
  type Totals,
  END_LINE_WORDS,
  endReason,
  endSentence,
  END_STATE_WORDS,
  exportJson,
  exportName,
  type FeedItem,
  feedOf,
  type Filter,
  findMatches,
  finishedShort,
  markPieces,
  matchAt,
  matchCounts,
  matchTotal,
  NO_FILTER,
  promptHashes,
  roleLabel,
  sessionWords,
  spentWords,
  STEP_KIND_WORDS,
  type StepKind,
  stepWindow,
  toolsCalled,
  totalCostWords,
  totalTokensWords,
  totalsCsv,
  transcriptMarkdown,
  runTitle,
  type TurnTotals,
  type TurnView,
  turnTotals,
  turnView,
} from "./live-model";
import { agentLabel } from "./live-model";
import { atFoot, revealInScroller, scrollParent } from "./scroll";
import { neededPermissions } from "./setup-model";
import { HeldPrompt, LoreChange, MendBanner, ReplyBrief } from "./turn-parts";
import { useSelect } from "./store";
import { showsToTop } from "./to-top-model";
import { EventsView, PromptBlock, TotalsView } from "./transcript-views";
import { type Folds, FeedText, Hits, Marked, TextBlock, useNow } from "./feed-parts";

const STATE_TONE: Readonly<Record<AgentState, Tone>> = { working: "accent", done: "pos", failed: "neg", stopped: "warn", cancelled: "neutral" };

type EndState = NonNullable<LiveView["ended"]>["state"];
const END_TONE: Readonly<Record<EndState, Tone>> = { done: "pos", failed: "neg", stopped: "warn", lost: "neg" };


const CALL_STATE_WORDS = { running: "running…", held: "waits for your word", done: "done", error: "failed", none: "no result" } as const;

/** The way to a job on the Jobs page. */
function JobLink(props: { job: { id: string; chatId: string }; children: ComponentChildren }) {
  const app = useApp();
  const active = useSelect(app.host.activeChat, (c) => c);
  return (
    <Button size="sm" icon="clock" onClick={() => app.nav.update((n) => ({ ...n, page: "jobs", job: props.job.id, chatId: props.job.chatId === active ? null : props.job.chatId }))}>
      {props.children}
    </Button>
  );
}

/** The workspace files a tool call changed, each with the way to it as the call left it (DESIGN §18: from a result to the file it changed). */
function ChangedFiles(props: { files: readonly FileChange[] }) {
  const app = useApp();
  if (props.files.length === 0) return null;
  return (
    <ul class="lah-changed" data-lah-changed aria-label="The workspace files this call changed">
      {props.files.map((f) => (
        <li key={`${f.area}:${f.path}`} class="lah-changed-row" data-change={fileChangeWord(f)}>
          <Icon name="file" size={14} />
          <code class="lah-mono lah-changed-path">{filePath(f)}</code>
          <span class="lah-dim">{fileChangeWord(f)}</span>
          <Button size="sm" icon="folder" onClick={() => app.nav.update((n) => ({ ...n, page: "workspace", changes: null, file: { area: f.area, path: f.path, hash: f.after } }))}>
            {f.after === null ? "Its history" : "Open"}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** A 64-character hash in lower-case hex names a blob the backend can read back whole. */
const BLOB_HASH = /^[0-9a-f]{64}$/;

/** One tool call as a card: its name and its arguments in a line, how it stands; opened, its arguments laid out and its result as the model was sent it. */
function ToolCard(props: { item: Extract<FeedItem, { kind: "tool" }>; folds: Folds; openByDefault: boolean }) {
  const app = useApp();
  const { item, folds } = props;
  const { call, result, state } = item;
  const open = folds.open(item.key, props.openByDefault);
  const [whole, setWhole] = useState<string | null>(null);
  const [reading, read] = useBusy();
  const now = (field: number): number => (folds.current !== null && folds.current.key === item.key && folds.current.field === field ? folds.current.nth : -1);
  const scratch = result?.scratch;
  return (
    <details class="lah-tool" open={open} data-lah-key={item.key} data-lah-call={call.name} data-state={state} data-lah-here={folds.current?.key === item.key || undefined} onToggle={(event) => folds.set(item.key, event.currentTarget.open)}>
      <summary>
        <Icon name="chevron-right" size={14} class="lah-caret" />
        <code class="lah-tool-name">
          <Marked text={call.name} query={folds.query} now={now(0)} />
        </code>
        <code class="lah-tool-preview">{JSON.stringify(call.args).slice(0, 200)}</code>
        <Hits n={folds.hits.get(item.key) ?? 0} />
        <span class="lah-tool-state">{result ? `${CALL_STATE_WORDS[state]} · ${duration(result.ms)}` : CALL_STATE_WORDS[state]}</span>
      </summary>
      {open ? (
        <div class="lah-tool-body">
          <div class="lah-tool-label">
            <span>Arguments</span>
            <CopyButton text={item.args} label={`Copy the arguments of ${call.name}`} />
          </div>
          <FeedText item={item.key} field={1} text={item.args} folds={folds} />
          <div class="lah-tool-label">
            <span>{result?.error ? "Its failure" : "Its result"}</span>
            {result ? <CopyButton text={result.text} label={`Copy the result of ${call.name}`} /> : null}
          </div>
          {result ? (
            <>
              <FeedText item={item.key} field={2} text={result.text} folds={folds} />
              {scratch ? (
                <p class="lah-line lah-dim">
                  <span>{`The model got it clipped; the whole is kept for scratch_read as ${scratch.slice(0, 16)}${scratch.length > 16 ? "…" : ""}.`}</span>
                  {BLOB_HASH.test(scratch) && whole === null ? (
                    <Button
                      size="sm"
                      busy={reading}
                      onClick={() =>
                        read(() =>
                          app.client.request("lah.blob.get", { hash: scratch }).then(
                            (r) => setWhole(r.text),
                            (e: unknown) => app.fail(e),
                          ),
                        )
                      }
                    >
                      Read the whole
                    </Button>
                  ) : null}
                </p>
              ) : null}
              {whole !== null ? (
                <>
                  <div class="lah-tool-label">
                    <span>The whole result</span>
                    <CopyButton text={whole} label={`Copy the whole result of ${call.name}`} />
                  </div>
                  <pre class="lah-text">{whole}</pre>
                </>
              ) : null}
            </>
          ) : (
            <p class="lah-line lah-dim">{state === "running" ? "Waiting for it…" : state === "held" ? "It runs once you approve it: the card at the foot of the view asks." : "None came: its agent stopped first."}</p>
          )}
        </div>
      ) : null}
    </details>
  );
}

/** What stands under a tool call's card whether it is open or not: that the call was held and what the user said to it, the way from its result to each file it changed, and what it did to the lore the writer saw. */
function ToolAfter(props: { item: Extract<FeedItem, { kind: "tool" }>; folds: Folds }) {
  const { item, folds } = props;
  const { word, files, lore } = item;
  // The lore's lines are the fourth of the texts a search reads of a tool call (`itemTexts`).
  const now = folds.current !== null && folds.current.key === item.key && folds.current.field === 3 ? folds.current.nth : -1;
  return (
    <>
      {word ? (
        <p class="lah-line lah-is-warn" data-lah-word={word.ended?.decision ?? "waiting"}>
          <Icon name="shield" size={14} />
          <span>{wordWords(word.asked, word.ended)}</span>
        </p>
      ) : null}
      <ChangedFiles files={files} />
      {lore ? <LoreChange lore={lore} query={folds.query} now={now} /> : null}
    </>
  );
}

/** One item of an agent's feed. */
function Item(props: { item: FeedItem; folds: Folds; now: number; thinkingOpen: boolean; toolsOpen: boolean }) {
  const { item, folds } = props;
  const now = folds.current !== null && folds.current.key === item.key ? folds.current.nth : -1;
  switch (item.kind) {
    case "instructions":
      return <TextBlock item={item.key} kind="told" title="Instructions" text={item.text} folds={folds} />;
    case "history":
      return <p class="lah-line lah-dim">{`Takes up ${counted(item.messages, "message")} of its session.`}</p>;
    case "told":
      return <TextBlock item={item.key} kind="told" title="Told" text={item.text} folds={folds} />;
    case "note":
      return <TextBlock item={item.key} kind="told" title="You said" text={item.text} folds={folds} byDefault />;
    case "word":
      return (
        <p class="lah-line lah-is-warn" data-lah-key={item.key} data-lah-word={item.ended?.decision ?? "waiting"}>
          <Icon name="shield" size={14} />
          <span>
            <Marked text={item.text} query={folds.query} now={now} />
          </span>
        </p>
      );
    case "notice":
      return (
        <p class={item.of === "run" && item.info !== true ? "lah-line lah-is-warn" : "lah-line lah-dim"} data-lah-key={item.key} data-lah-notice={item.info === true ? "info" : item.of}>
          <Icon name={item.of === "run" && item.info !== true ? "alert" : "info"} size={14} />
          <span>
            <Marked text={item.text} query={folds.query} now={now} />
          </span>
        </p>
      );
    case "hold":
      return (
        <p class="lah-line lah-dim" data-lah-hold={item.on ? "paused" : "resumed"}>
          <Icon name={item.on ? "pause" : "play"} size={14} />
          <span>{`${item.on ? "You paused the run here" : "You let the run go on"} · ${clock(item.at)}`}</span>
        </p>
      );
    case "job":
      return (
        <p class="lah-line" data-lah-key={item.key} data-lah-job={item.job.id}>
          <Icon name="clock" size={14} />
          <span>
            <Marked text={item.text} query={folds.query} now={now} />
          </span>
          <JobLink job={item.job}>Open the job</JobLink>
        </p>
      );
    case "call": {
      const e = item.entry;
      return (
        <>
          <div class="lah-call" data-lah-key={item.key} data-lah-call-seq={item.seq} data-short={finishedShort(e) || undefined}>
            <span class="lah-call-name">
              <span class="lah-arrow">←</span> {`Call ${item.call}`}
            </span>
            <span class="lah-stats">
              <span style={{ whiteSpace: "normal" }}>
                <Marked text={callWords(e)} query={folds.query} now={now} />
              </span>
            </span>
            {finishedShort(e) ? <Badge tone="warn">finished short</Badge> : null}
            {e.tools === "text" ? <Badge>tools offered as text</Badge> : null}
            {e.written ? <Badge>calls written as text</Badge> : null}
            {e.offered ? <span class="lah-dim">{`offered ${counted(e.offered.tools, "tool")} (≈${count(e.offered.tokens)} tokens)`}</span> : null}
            {e.prompt ? null : <span class="lah-dim">prompt not kept</span>}
          </div>
          {e.prompt ? <PromptBlock hash={e.prompt} item={`p:${item.seq}`} folds={folds} /> : null}
        </>
      );
    }
    case "thinking":
      return <TextBlock item={item.key} kind="thinking" title="Thinking" text={item.text} folds={folds} byDefault={item.live === true || props.thinkingOpen} live={item.live} />;
    case "said":
      return <TextBlock item={item.key} kind="said" title="Answer" text={item.text} folds={folds} byDefault live={item.live} />;
    case "tool":
      return (
        <>
          <ToolCard item={item} folds={folds} openByDefault={props.toolsOpen} />
          <ToolAfter item={item} folds={folds} />
        </>
      );
    case "result":
      return <TextBlock item={item.key} field={1} kind={item.entry.error ? "failed" : "result"} title={`${item.entry.error ? "✗" : "←"} ${item.entry.name}`} text={item.entry.text} folds={folds} meta={duration(item.entry.ms)} />;
    case "refused":
      return (
        <>
          <p class="lah-line lah-is-warn" data-lah-key={item.key}>
            <Icon name="alert" size={14} />
            <span>
              <Marked text={item.text} query={folds.query} now={now} />
            </span>
          </p>
          {item.entry.prompt ? <PromptBlock hash={item.entry.prompt} item={`p:${item.seq}`} folds={folds} /> : null}
        </>
      );
    case "retry":
      return (
        <>
          <p class="lah-line lah-is-warn" data-lah-key={item.key} data-lah-retry={item.entry.attempt}>
            <Icon name="refresh" size={14} />
            <span>
              <Marked text={item.text} query={folds.query} now={now} />
            </span>
          </p>
          {item.entry.prompt ? <PromptBlock hash={item.entry.prompt} item={`p:${item.seq}`} folds={folds} /> : null}
        </>
      );
    case "stop":
      return (
        <>
          <p class="lah-line lah-is-warn" data-lah-key={item.key} data-lah-stop={item.entry.code}>
            <Icon name="stop" size={14} />
            <span>
              <Marked text={item.text} query={folds.query} now={now} />
            </span>
          </p>
          {item.entry.prompt ? <PromptBlock hash={item.entry.prompt} item={`p:${item.seq}`} folds={folds} /> : null}
        </>
      );
    case "activity":
      return (
        <p class="lah-line" data-lah-activity={item.activity.waits}>
          <span class="lah-pulse" aria-hidden="true" />
          <span>{`${activityWords(item.activity)}… ${elapsed(props.now, item.activity.since)}`}</span>
        </p>
      );
    case "streaming":
      return (
        <p class="lah-line" data-lah-streaming={item.call}>
          <span class="lah-pulse" aria-hidden="true" />
          <span>{`${streamingWords(item)}… ${elapsed(props.now, item.since)}`}</span>
        </p>
      );
    case "finished":
      return <p class="lah-line lah-dim">{`Finished its message · ${spentWords(item.spent)}`}</p>;
  }
}

/** One agent: its head (how it stands, its role and task, its model, time, tokens and cost), then its items. */
function AgentBlock(props: { feed: AgentFeed; turn: TurnView; spent: AgentTotals | undefined; folds: Folds; now: number; open: boolean; connection(id: string): string; focused: boolean; thinkingOpen: boolean; toolsOpen: boolean; onToggle(): void; onFocus(): void }) {
  const app = useApp();
  const a = props.feed.agent;
  const label = agentLabel(a.start);
  return (
    <li class="lah-agent" data-lah-agent={a.start.id} data-role={a.start.role} data-state={a.state} style={{ "--lah-depth": String(a.depth) }}>
      <div class="lah-agent-head">
        <button type="button" class="lah-agent-toggle" aria-expanded={props.open} onClick={props.onToggle}>
          <Icon name="chevron-right" size={14} class="lah-caret" />
          <Badge tone={STATE_TONE[a.state]}>{AGENT_STATE_WORDS[a.state]}</Badge>
          <strong>{label}</strong>
          {a.start.task ? <span class="lah-agent-task">{a.start.task}</span> : null}
        </button>
        <IconButton icon="filter" size="sm" label={props.focused ? "Show every agent" : `Show only ${label}`} pressed={props.focused} onClick={props.onFocus} />
        <CopyButton text={() => transcriptMarkdown(props.turn, feedOf(props.turn, { ...NO_FILTER, agent: a.start.id }), app.now())} label={`Copy what ${label} did, as Markdown`} />
      </div>
      <p class="lah-agent-meta">
        <span class="lah-model">{agentModel(a) ?? "the connection's model"}</span>
        <span>{a.start.connectionId ? `on ${props.connection(a.start.connectionId)}` : "on the default connection"}</span>
        <span>{`effort ${a.start.effort}`}</span>
        <span>{duration(agentMs(a, props.now))}</span>
        {props.spent && props.spent.calls > 0 ? <span>{`${totalTokensWords(props.spent)} · ${totalCostWords(props.spent)}`}</span> : null}
      </p>
      {props.open ? (
        <div class="lah-agent-body">
          {props.feed.hidden > 0 ? <p class="lah-line lah-dim">{`${counted(props.feed.hidden, "earlier step")} not shown.`}</p> : null}
          {props.feed.items.map((item) => (
            <Item key={item.key} item={item} folds={props.folds} now={props.now} thinkingOpen={props.thinkingOpen} toolsOpen={props.toolsOpen} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

/** Each agent in a list beside the feed (a strip above it in one column): how it stands and what it spent; pressing one shows only its work. */
function Outline(props: { turn: TurnView; totals: TurnTotals; agent: string | null; now: number; onAgent(id: string | null): void }) {
  const { turn, totals } = props;
  const brief = (t: Totals): string => `${t.estimated ? "≈" : ""}${compact(t.in)} in · ${t.estimated ? "≈" : ""}${compact(t.out)} out`;
  return (
    <nav class="lah-outline" aria-label="The turn's agents">
      <button type="button" class="lah-outline-row" aria-pressed={props.agent === null} onClick={() => props.onAgent(null)}>
        <span class="lah-outline-name">Every agent</span>
        <span class="lah-outline-sub">{totals.turn.calls > 0 ? `${brief(totals.turn)} · ${totalCostWords(totals.turn)}` : counted(turn.agents.length, "agent")}</span>
      </button>
      {totals.agents.map((t) => {
        const a = t.agent;
        return (
          <button key={a.start.id} type="button" class="lah-outline-row" data-state={a.state} aria-pressed={props.agent === a.start.id} style={{ "--lah-depth": String(a.depth) }} onClick={() => props.onAgent(props.agent === a.start.id ? null : a.start.id)}>
            <span class="lah-outline-name">
              {a.state === "working" ? <span class="lah-pulse" aria-hidden="true" /> : <span class={`lah-dot lah-is-${STATE_TONE[a.state]}`} aria-hidden="true" />}
              {agentLabel(a.start)}
              <span class="lah-sr">{`, ${AGENT_STATE_WORDS[a.state]}`}</span>
            </span>
            <span class="lah-outline-sub">{[...(t.calls > 0 ? [brief(t)] : []), duration(agentMs(a, props.now)), ...(t.calls > 0 ? [totalCostWords(t)] : [])].join(" · ")}</span>
          </button>
        );
      })}
    </nav>
  );
}

export type TurnMode = "steps" | "totals" | "events";

const MODES: readonly { value: TurnMode; label: string }[] = [
  { value: "steps", label: "Steps" },
  { value: "totals", label: "Totals" },
  { value: "events", label: "Events" },
];

function filtered(filter: Filter): number {
  return (filter.agent !== null ? 1 : 0) + (filter.kinds.length < ALL_KINDS.length ? 1 : 0) + (filter.tool !== null ? 1 : 0) + (filter.problems ? 1 : 0);
}

/**
 * Whether a transcript's "Back to top" shows (to-top-model.ts), and what pressing it does. The panel
 * that scrolls is the host's, found as the follow logic finds it; it is found again when `again`
 * changes (another turn). `root` takes focus (`tabIndex={-1}`): the button goes away near the top,
 * and focus waits at the transcript's start rather than being lost to the page.
 */
function useToTop(root: RefObject<HTMLElement | null>, again: unknown): { shown: boolean; toTop(): void } {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const scroller = root.current ? scrollParent(root.current) : null;
    if (!scroller) {
      setShown(false);
      return;
    }
    const heard = (): void => setShown(showsToTop({ top: scroller.scrollTop, height: scroller.clientHeight, scrollable: scroller.scrollHeight > scroller.clientHeight }));
    heard();
    scroller.addEventListener("scroll", heard, { passive: true });
    // Turning the phone or its keyboard opening changes the height that shows without a scroll.
    window.addEventListener("resize", heard);
    return () => {
      scroller.removeEventListener("scroll", heard);
      window.removeEventListener("resize", heard);
    };
  }, [again]);
  const toTop = (): void => {
    const el = root.current;
    const scroller = el ? scrollParent(el) : null;
    if (!el || !scroller) return;
    // Nothing moves under reduced motion: the jump is instant there.
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    scroller.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
  };
  return { shown, toTop };
}

export interface TurnFeedProps {
  view: LiveView;
  /** The stream's live turn: while it runs, its state and what the user can do to it stay in view at the top, and the feed follows its newest step. */
  live: boolean;
  /** Events the backend has couldn't all be read. */
  partial?: boolean;
  onStop?(): Promise<unknown>;
  /** Reads the turn again, where some of it couldn't be read. */
  onRetry?(): void;
  /** What stands at the foot while the turn runs: the calls held for the user's word. */
  dock?: ComponentChildren;
  /** What the user can do to a running turn besides ending it, in the pinned bar. */
  controls?: ComponentChildren;
  /** What opens under the pinned bar: the box to say something, and that the turn is held. */
  below?: ComponentChildren;
}

export function TurnFeed(props: TurnFeedProps) {
  const app = useApp();
  const { view } = props;
  const prefs = useSelect(app.prefs, (p) => p);
  const connections = useSelect(app.client.state, (s) => s?.connections);
  const running = view.ended === null;
  const now = useNow(running);
  // The turn as it was folded last: a delta of a call in flight leaves its events' fold standing (live-model's turnView says why).
  const lastTurn = useRef<TurnView | null>(null);
  const turn = useMemo(() => (lastTurn.current = turnView(view, lastTurn.current)), [view]);
  const [mode, setMode] = useState<TurnMode>("steps");
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [chosen, setChosen] = useState<Readonly<Record<string, boolean>>>({});
  const [all, setAll] = useState<boolean | null>(null);
  const [wholes, setWholes] = useState<Readonly<Record<string, true>>>({});
  const [folded, setFolded] = useState<Readonly<Record<string, boolean>>>({});
  const [shown, setShown] = useState(prefs.pageSteps);
  const [following, setFollowing] = useState(prefs.follow);
  const [stopping, stop] = useBusy();
  const [bundling, bundle] = useBusy();
  const root = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  const pin = useRef<HTMLDivElement>(null);
  const pinned = props.live && running;
  const top = useToTop(root, view.turn);
  // The foot stands while the turn runs, and in any transcript once "Back to top" shows.
  const footed = pinned || top.shown;
  // What stays under the page bar while the turn runs is measured for the search row, which sticks right under it (styles/live.ts): the stylesheet can't know how tall the box to say something makes it.
  useLayoutEffect(() => {
    const el = pin.current;
    const host = root.current;
    if (!el || !host) return;
    const publish = (): void => host.style.setProperty("--lah-pin-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      host.style.removeProperty("--lah-pin-h");
    };
  }, [pinned]);
  // What stands at the foot is measured for the notices, which rise over it (styles/components.ts): the stylesheet can't know how tall a held call's card makes it.
  useLayoutEffect(() => {
    const el = foot.current;
    const host = el?.closest<HTMLElement>("[data-lah-root]");
    if (!el || !host) return;
    const publish = (): void => host.style.setProperty("--lah-foot-h", `${Math.ceil(el.getBoundingClientRect().height + (Number.parseFloat(getComputedStyle(el).rowGap) || 0))}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      host.style.removeProperty("--lah-foot-h");
    };
  }, [footed]);
  // Another turn is another transcript: nothing filtered, folded or paged carries over.
  useEffect(() => {
    setFilter(NO_FILTER);
    setMatchIndex(0);
    setChosen({});
    setAll(null);
    setWholes({});
    setFolded({});
    setShown(prefs.pageSteps);
    setFollowing(prefs.follow);
  }, [view.turn]);
  const everything = useMemo(() => feedOf(turn, filter), [turn, filter]);
  const matches = useMemo(() => findMatches(everything, filter.query), [everything, filter.query]);
  const total = matchTotal(matches);
  const at = matchAt(matches, matchIndex);
  const current = at ? { key: at.group.key, field: at.group.field, nth: at.nth } : null;
  const hits = useMemo(() => matchCounts(matches), [matches]);
  const window = stepWindow(turn, shown);
  // A find before the window widens it, so stepping to it shows it.
  const from = at && at.group.seq < window.from ? Math.floor(at.group.seq) : window.from;
  const feeds = useMemo(() => (from === 0 ? everything : feedOf(turn, filter, from)), [everything, turn, filter, from]);
  const hidden = from === 0 ? 0 : turn.agents.reduce((n, a) => n + a.steps.filter((s) => s.seq < from).length, 0);
  const folds: Folds = {
    query: filter.query,
    hits,
    current,
    open: (key, byDefault) => chosen[key] ?? all ?? byDefault,
    set: (key, open) => setChosen((c) => (c[key] === open ? c : { ...c, [key]: open })),
    clip: prefs.clipChars,
    whole: (id) => wholes[id] === true,
    showWhole: (id) => setWholes((w) => ({ ...w, [id]: true })),
  };
  // The find the search stands on: its block and its agent open, and it comes into view.
  const here = at ? `${at.group.key}/${at.group.field}/${at.nth}` : null;
  useEffect(() => {
    if (!at) return;
    setChosen((c) => (c[at.group.key] === true ? c : { ...c, [at.group.key]: true }));
    setFolded((f) => (f[at.group.agentId] === true ? { ...f, [at.group.agentId]: false } : f));
  }, [here]);
  useLayoutEffect(() => {
    if (here === null || !root.current) return;
    revealInScroller(root.current.querySelector("mark[data-lah-now]") ?? root.current.querySelector("[data-lah-here]"), "center");
  }, [here, chosen, folded]);
  // Following the newest step while the turn runs, until the reader scrolls up from the foot.
  useEffect(() => {
    if (!props.live || !running || !root.current) return;
    const scroller = scrollParent(root.current);
    if (!scroller) return;
    const heard = (): void => setFollowing(atFoot(scroller));
    scroller.addEventListener("scroll", heard, { passive: true });
    return () => scroller.removeEventListener("scroll", heard);
  }, [props.live, running]);
  // What the calls in flight have sent: a word that arrives is followed as a new step is.
  const streamed = view.partials.reduce((n, p) => n + p.text.length + p.reasoning.length, 0);
  useLayoutEffect(() => {
    // Only a turn that runs is followed: one that has ended opens at its head, where its figures are.
    if (!props.live || !running || !following || mode !== "steps" || filter.query.trim() !== "" || !root.current) return;
    const scroller = scrollParent(root.current);
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [view.events.length, streamed, following, mode]);
  const ended = view.ended;
  const totals = useMemo(() => turnTotals(turn, now), [turn, now]);
  const narrowed = filtered(filter) > 0;
  const markdown = (onlyShown: boolean): string => transcriptMarkdown(turn, onlyShown ? everything : feedOf(turn, NO_FILTER), app.now());
  /** Saves a file through the app (which says so) and folds the menu it was picked from. */
  const save = (name: string, text: string, mime: string, said?: string, tone?: "info" | "error"): void => {
    app.save(name, text, mime, said, tone);
    setExporting(false);
  };
  /** Reads every call's exact prompt, then saves the turn with them: the whole of what was sent and what came back, in one file. */
  const saveWithPrompts = async (): Promise<void> => {
    const prompts: Record<string, CallPrompt> = {};
    const hashes = promptHashes(view);
    let failed = 0;
    for (const hash of hashes) {
      try {
        prompts[hash] = (await app.client.request("lah.prompt.get", { prompt: hash })).prompt;
      } catch {
        failed += 1;
      }
    }
    const name = exportName(view, "json", "with-prompts");
    const body = exportJson(view, prompts, app.now());
    if (hashes.length === 0) save(name, body, "application/json", `Saved ${name}. No call of this turn kept its prompt.`);
    else if (failed > 0) save(name, body, "application/json", `Saved ${name}, but ${counted(failed, "prompt")} of ${hashes.length} couldn't be read and ${failed === 1 ? "is" : "are"} left out.`, "error");
    else save(name, body, "application/json", `Saved ${name} with ${counted(hashes.length, "prompt")}.`);
  };
  const toggleKind = (kind: StepKind): void => setFilter((f) => ({ ...f, kinds: f.kinds.includes(kind) ? f.kinds.filter((k) => k !== kind) : ALL_KINDS.filter((k) => k === kind || f.kinds.includes(k)) }));
  const step = (back: boolean): void => {
    if (total > 0) setMatchIndex((i) => (((i + (back ? -1 : 1)) % total) + total) % total);
  };
  const tools = toolsCalled(turn);
  const connection = (id: string): string => connections?.find((c) => c.id === id)?.name ?? id;
  const t = totals.turn;
  // How long and how much, where a cost is known: "Finished in 12.4 s, $0.0018".
  const priced = t.calls > 0 && !(t.unpriced >= t.calls && t.cost === 0);
  const stateLine = ended === null ? `${turn.paused ? "Paused" : "Running"} · ${elapsed(now, view.startedAt)}` : `${END_LINE_WORDS[ended.state]} ${duration(ended.at - view.startedAt)}${priced ? `, ${totalCostWords(t)}` : ""}`;
  // For a reply: what the turn came to in words, and, where it failed, the cause with the step that mends it. A permission missing now says nothing of a reply long past.
  const reply = isReply(view.kind);
  const did = useMemo(() => (reply ? replyDid(view.events) : null), [reply, view.events]);
  const lacking = useSelect(app.client.state, (s) => s !== null && neededPermissions(s).length > 0);
  const mend = ended !== null && did !== null ? mendOf(ended, did, props.live && lacking) : null;
  const stats = (
    <p class="lah-stats" data-lah-turn-totals>
      <span>
        <b>{count(t.calls)}</b> {t.calls === 1 ? "call" : "calls"}
      </span>
      <span>
        <b>{`${t.estimated ? "≈" : ""}${count(t.in)}`}</b> in{t.cachedIn > 0 ? ` (${count(t.cachedIn)} cached)` : ""}
      </span>
      <span>
        <b>{`${t.estimated ? "≈" : ""}${count(t.out)}`}</b> out{t.reasoningOut > 0 ? ` (${count(t.reasoningOut)} reasoning)` : ""}
      </span>
      <span>
        <b>{duration(t.modelMs)}</b> in the model
      </span>
      {t.toolCalls > 0 ? (
        <span>
          <b>{count(t.toolCalls)}</b> {`tool ${t.toolCalls === 1 ? "call" : "calls"} (${duration(t.toolMs)})`}
        </span>
      ) : null}
      <span>
        <b>{totalCostWords(t)}</b>
      </span>
    </p>
  );
  const foldButtons = (
    <>
      <IconButton icon="expand" label="Open every block" onClick={() => (setAll(true), setChosen({}), setFolded({}))} />
      <IconButton icon="shrink" label="Fold every block" onClick={() => (setAll(false), setChosen({}))} />
    </>
  );
  // "Jump to the newest": a running turn's steps, scrolled away from the newest.
  const jump = pinned && !following && mode === "steps";
  return (
    <div ref={root} class="lah-turn" data-lah-turn={view.turn} data-state={ended === null ? "running" : ended.state} tabIndex={-1}>
      {/*
        While the turn runs, its state and what the user can do to it stay at the top of what the
        panel shows: the feed follows its newest step, so the head is soon scrolled out of reach, and
        the foot is where the drawer lies over Lumiverse's own Send and Stop.
      */}
      {pinned ? (
        <div ref={pin} class="lah-pin" data-lah-pin>
          <div class="lah-pinned" data-lah-pinned="working">
            <span class="lah-pulse" aria-hidden="true" />
            <span class="lah-pinned-text">{stateLine}</span>
            {props.controls}
            {props.onStop ? (
              <Button variant="danger" size="sm" icon="stop" busy={stopping} onClick={() => props.onStop && stop(props.onStop)}>
                Stop
              </Button>
            ) : null}
          </div>
          {props.below}
        </div>
      ) : null}
      <header class="lah-turn-head">
        <div class="lah-stack lah-turn-what">
          <div class="lah-turn-title">
            <strong class="lah-h">{runTitle(view)}</strong>
            <Badge tone={ended === null ? "accent" : END_TONE[ended.state]}>{ended === null ? "running" : END_STATE_WORDS[ended.state]}</Badge>
            <span class="lah-dim lah-small">{dateTime(view.startedAt)}</span>
          </div>
          <p class="lah-turn-state" role="status" aria-live="polite">
            {ended === null ? <span class="lah-pulse" aria-hidden="true" /> : null}
            <span>{stateLine}</span>
            {ended !== null && mend === null && endReason(ended, stateLine) !== null ? <span class="lah-warn">{endReason(ended, stateLine)}</span> : null}
          </p>
          {did !== null ? <ReplyBrief brief={did.brief} lore={loreNamesWords(did.lore)} /> : null}
          {/* A reply's head leads with what was done for it; its counts and tokens are a press away. Any other run's figures are what its head is for. */}
          {reply ? (
            <Disclosure class="lah-turn-details" summary={<span class="lah-small">Details: calls, tokens and time</span>}>
              {stats}
            </Disclosure>
          ) : (
            stats
          )}
          {props.partial ? (
            <p class="lah-line lah-is-warn">
              <Icon name="alert" size={14} />
              <span>Some of this turn's steps couldn't be read.</span>
              {props.onRetry ? (
                <Button size="sm" icon="refresh" onClick={props.onRetry}>
                  Read again
                </Button>
              ) : null}
            </p>
          ) : null}
        </div>
        <div class="lah-actions">
          <CopyButton text={() => markdown(narrowed)} label={narrowed ? "Copy what is shown, as Markdown" : "Copy the transcript, as Markdown"} size="md" variant="secondary">
            {narrowed ? "Copy shown" : "Copy"}
          </CopyButton>
          <Button icon="download" expanded={exporting} onClick={() => setExporting((open) => !open)}>
            Export
          </Button>
        </div>
        {exporting ? (
          <div class="lah-menu" data-lah-export>
            <Button variant="ghost" icon="file" onClick={() => save(exportName(view, "md"), markdown(false), "text/markdown")}>
              The transcript, as Markdown (.md)
            </Button>
            {narrowed ? (
              <Button variant="ghost" icon="filter" onClick={() => save(exportName(view, "md", "shown"), markdown(true), "text/markdown")}>
                Only what is shown, as Markdown (.md)
              </Button>
            ) : null}
            <Button variant="ghost" icon="code" onClick={() => save(exportName(view, "json"), exportJson(view, null, app.now()), "application/json")}>
              Every event as traced (.json)
            </Button>
            <Button variant="ghost" icon="code" busy={bundling} onClick={() => bundle(() => saveWithPrompts().catch((e: unknown) => app.toast(errorWords(e), "error")))}>
              Every event, with each call's exact prompt (.json)
            </Button>
            <Button variant="ghost" icon="table" onClick={() => save(exportName(view, "csv"), totalsCsv(totals), "text/csv")}>
              Tokens, time and cost per call (.csv)
            </Button>
          </div>
        ) : null}
      </header>
      {mend !== null ? (
        <MendBanner
          mend={mend}
          onProblems={() => {
            setMode("steps");
            setFilter((f) => ({ ...f, problems: true }));
          }}
        />
      ) : null}
      <Seg<TurnMode> label="What to show of the turn" value={mode} options={MODES} onChange={setMode} />
      {mode === "totals" ? (
        <TotalsView turn={turn} totals={totals} connection={connection} />
      ) : (
        <div class="lah-turn-grid">
          <aside class="lah-turn-side">
            {mode === "steps" ? (
              <>
                <Outline turn={turn} totals={totals} agent={filter.agent} now={now} onAgent={(agent) => setFilter((f) => ({ ...f, agent }))} />
                <div class="lah-filters">
                  <span class="lah-filters-toggle">
                    <Button size="sm" icon="filter" expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>
                      {filtered(filter) > 0 ? `Filters (${filtered(filter)} on)` : "Filters"}
                    </Button>
                    {/* In one column these sit here, not in the search row: beside a search's count and its two steps they would wrap that row, which stays in view, onto a second line. */}
                    <span class="lah-turn-folds">{foldButtons}</span>
                  </span>
                  <div class="lah-filters-body" data-open={filtersOpen}>
                    <div class="lah-chips" role="group" aria-label="Show these steps">
                      {ALL_KINDS.map((k) => (
                        <Chip key={k} pressed={filter.kinds.includes(k)} onClick={() => toggleKind(k)}>
                          {STEP_KIND_WORDS[k]}
                        </Chip>
                      ))}
                    </div>
                    <div class="lah-filters-row">
                      <Chip pressed={filter.problems} onClick={() => setFilter((f) => ({ ...f, problems: !f.problems }))}>
                        <Icon name="alert" size={14} /> Only what went wrong
                      </Chip>
                      {tools.length > 0 ? <Select label="Show the calls of this tool" value={filter.tool ?? ""} options={[{ value: "", label: "Every tool" }, ...tools.map((name) => ({ value: name, label: name }))]} onChange={(name) => setFilter((f) => ({ ...f, tool: name === "" ? null : name }))} /> : null}
                    </div>
                    {narrowed ? (
                      <div class="lah-filters-row">
                        <Button size="sm" variant="ghost" icon="close" onClick={() => setFilter((f) => ({ ...NO_FILTER, query: f.query }))}>
                          Clear the filters
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </>
            ) : (
              <p class="lah-lead lah-small">Every event of the turn as the runtime traced it, in order. The search keeps the events whose JSON holds it.</p>
            )}
          </aside>
          <div class="lah-turn-main">
            <div class="lah-turn-search">
              <SearchField
                value={filter.query}
                label={mode === "steps" ? "Search the transcript" : "Search the events"}
                placeholder={mode === "steps" ? "Search the transcript" : "Search the events"}
                status={mode !== "steps" || filter.query.trim() === "" ? undefined : total === 0 ? "Nothing found" : `Find ${(((matchIndex % total) + total) % total) + 1} of ${total}`}
                onInput={(query) => {
                  setFilter((f) => ({ ...f, query }));
                  setMatchIndex(0);
                }}
                onEnter={step}
              />
              {mode === "steps" && filter.query.trim() !== "" ? (
                <span class="lah-turn-matches">
                  <span class="lah-muted" aria-hidden="true" data-lah-finds>
                    {total === 0 ? "0 found" : `${(((matchIndex % total) + total) % total) + 1} / ${count(total)}`}
                  </span>
                  <IconButton icon="chevron-up" label="Previous find" disabled={total === 0} onClick={() => step(true)} />
                  <IconButton icon="chevron-down" label="Next find" disabled={total === 0} onClick={() => step(false)} />
                </span>
              ) : null}
              {mode === "steps" ? <span class="lah-turn-folds">{foldButtons}</span> : null}
            </div>
            {mode === "events" ? (
              <EventsView view={view} query={filter.query} page={prefs.pageSteps} />
            ) : (
              <ol class="lah-feed" aria-label="What the turn's agents did">
                {hidden > 0 ? (
                  <li class="lah-mark">
                    <Button size="sm" icon="chevron-up" onClick={() => setShown((n) => n + prefs.pageSteps)}>
                      {`Show ${counted(Math.min(prefs.pageSteps, hidden), "earlier step")} (${count(hidden)} not shown)`}
                    </Button>
                  </li>
                ) : null}
                {turn.session && filter.agent === null && !filter.problems ? (
                  <li class="lah-mark lah-session" data-lah-session>
                    {sessionWords(turn.session).map((line) => (
                      <p key={line}>{line}</p>
                    ))}
                    {turn.session.jobs && turn.session.jobs.length > 0 ? (
                      <div class="lah-actions">
                        {turn.session.jobs.map((job) => (
                          <JobLink key={job.id} job={job}>{`${roleLabel(job.agent)}: ${job.opening ?? job.task}`}</JobLink>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ) : null}
                {turn.held && filter.agent === null && !filter.problems ? (
                  <li class="lah-mark lah-session" data-lah-held-prompt>
                    <HeldPrompt held={turn.held} />
                  </li>
                ) : null}
                {feeds.length === 0 ? <li class="lah-mark">{filter.problems ? "Nothing went wrong in this turn." : running ? "Starting the main agent…" : "No agent ran in this turn."}</li> : null}
                {feeds.map((feed) => (
                  <AgentBlock
                    key={feed.agent.start.id}
                    feed={feed}
                    spent={totals.agents.find((t) => t.agent === feed.agent)}
                    turn={turn}
                    folds={folds}
                    now={now}
                    open={folded[feed.agent.start.id] !== true}
                    connection={connection}
                    focused={filter.agent === feed.agent.start.id}
                    thinkingOpen={prefs.thinkingOpen}
                    toolsOpen={prefs.toolsOpen}
                    onToggle={() => setFolded((f) => ({ ...f, [feed.agent.start.id]: f[feed.agent.start.id] !== true }))}
                    onFocus={() => setFilter((f) => ({ ...f, agent: f.agent === feed.agent.start.id ? null : feed.agent.start.id }))}
                  />
                ))}
                {ended ? <li class="lah-mark lah-ended" data-lah-ended={ended.state}>{endSentence(ended)}</li> : null}
              </ol>
            )}
          </div>
        </div>
      )}
      {/*
        At the foot of what the panel shows: while the turn runs, the way back to the newest step and
        the calls held for the user's word, whose answers must stay in reach; in any transcript well
        down from its top, the way back to it. Both ways share one row, so neither lies over the other.
      */}
      {footed ? (
        <div ref={foot} class="lah-foot">
          {jump || top.shown ? (
            <div class="lah-follow">
              {jump ? (
                <Button size="sm" variant="primary" icon="chevron-down" onClick={() => setFollowing(true)}>
                  Jump to the newest
                </Button>
              ) : null}
              {top.shown ? (
                <Button
                  size="sm"
                  icon="chevron-up"
                  onClick={() => {
                    // At the top the feed must stay put: following would pull it back down to the newest step. "Jump to the newest" follows again.
                    setFollowing(false);
                    top.toTop();
                  }}
                >
                  Back to top
                </Button>
              ) : null}
            </div>
          ) : null}
          {pinned ? props.dock : null}
        </div>
      ) : null}
    </div>
  );
}
