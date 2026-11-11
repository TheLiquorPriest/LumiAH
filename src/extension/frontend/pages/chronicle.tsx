// Chronicle (DESIGN §24.7, §22): what the story has established, as the agents keep it in four
// short files, each line with the messages it rests on. The page leads with how far the chronicle
// has come and the one thing to do about it (Learn this story, or what the job that learns it
// needs), then says which lines no longer hold, then shows the files: a line is pressed to read
// the messages it cites as they stand now. Everything it decides is in `chronicle-model.ts`; this
// file reads, draws and sends. Other pages lead here by `nav.chronicle` (a file and a line) and
// `nav.message` (a citation).

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { type ChronicleView, type CitedView, type JobView, learnedPath, type RunningTurn, type StoryView } from "../../../shared/ui";
import { errorWords, useApp } from "../app";
import { ChatBar, useChatView, useShownChat } from "../chat";
import {
  agentChoices,
  agentsPath,
  ALLOWANCE_WORDS,
  allowanceWords,
  CARRY_ON,
  carryOnGrant,
  type ChronLine,
  citedBadge,
  citedNote,
  citedState,
  countsOf,
  extraPaths,
  failedPlaces,
  failedWords,
  failingLines,
  failWords,
  fileChoices,
  grantWords,
  hasChronicle,
  learnBlock,
  learnBody,
  type LearnDraft,
  learnDraft,
  type LinePlace,
  linesOf,
  marksOf,
  moveWords,
  nextPlace,
  quietWords,
  saidBy,
  shownChoice,
  type StoryCard,
  storyCard,
  storyJobOf,
  UNCITED_WORDS,
  workspaceTarget,
} from "../chronicle-model";
import { Badge, Banner, Button, Chip, Disclosure, Editor, Empty, Field, Select, useBusy } from "../components";
import { dateTime } from "../format";
import { Icon } from "../icons";
import { agentName, type AllowanceDraft, allowanceDraft, allowanceOf, grantBlock, heldStreams } from "../jobs-model";
import { RunPane } from "../runs";
import { revealInScroller } from "../scroll";
import { useSelect } from "../store";
import { AllowanceFields } from "./jobs";

const NO_JOBS: readonly JobView[] = [];
const NONE_RUNNING: readonly RunningTurn[] = [];

/** What the page read last of a chat: its chronicle with the check run over it, the learning of its story, and what else the chronicle's folder holds. */
interface Read {
  status: "loading" | "ready" | "failed";
  chatId: string | null;
  view: ChronicleView | null;
  story: StoryView | null;
  extras: string[];
  agents: { id: string; name: string }[];
  message: string;
}

const NOTHING: Read = { status: "loading", chatId: null, view: null, story: null, extras: [], agents: [], message: "" };

/** The text of the file shown. */
interface FileText {
  status: "loading" | "ready" | "failed";
  path: string | null;
  text: string;
  message: string;
}

const NO_TEXT: FileText = { status: "loading", path: null, text: "", message: "" };

/** The messages a line cites, as they stand now. */
interface Cited {
  status: "loading" | "ready" | "failed";
  list: CitedView[];
  message: string;
}

const samePlace = (a: LinePlace | null, b: LinePlace): boolean => a !== null && agentsPath(a.path) === agentsPath(b.path) && a.line === b.line;

/** The messages a line rests on, each as it stands now beside how it was cited. */
function CitedList(props: { cited: Cited }) {
  const { cited } = props;
  if (cited.status === "loading") return <p class="lah-small lah-muted">Reading the messages it cites…</p>;
  if (cited.status === "failed") return <p class="lah-field-help">{`The messages couldn't be read: ${cited.message} Press the line again to try once more.`}</p>;
  return (
    <>
      {cited.list.map((c) => {
        const badge = citedBadge(c);
        const note = citedNote(c);
        return (
          <div key={c.index} class="lah-chron-msg" data-lah-cited={c.index} data-state={citedState(c)}>
            <span class="lah-chron-msg-head">
              <strong>{`Message #${c.index}`}</strong>
              {c.message !== null ? <span>{saidBy(c.message)}</span> : null}
              {c.message !== null && c.message.at !== null ? <span class="lah-dim">{dateTime(c.message.at)}</span> : null}
              {badge !== null ? (
                <Badge tone={badge.tone}>
                  <Icon name={badge.icon} size={12} />
                  {badge.word}
                </Badge>
              ) : null}
            </span>
            {note !== null ? <p class="lah-small lah-muted">{note}</p> : null}
            {c.message !== null ? <p class="lah-chron-msg-text">{c.message.text}</p> : null}
          </div>
        );
      })}
    </>
  );
}

/** One line of a file. A line that cites messages is pressed to read them; the check's marks say in words what is wrong with it. */
function Line(props: { line: ChronLine; open: boolean; found: boolean; cited: Cited | null; onPress(): void }) {
  const { line } = props;
  const words = (
    <>
      <span class="lah-chron-words">
        {line.kind === "item" ? (
          <span class="lah-chron-bullet" aria-hidden="true">
            {line.marker ?? "•"}
          </span>
        ) : null}
        <span>
          {line.pieces.map((piece, i) =>
            "text" in piece ? (
              <span key={i}>{piece.text}</span>
            ) : (
              <span key={i} class="lah-chron-cite lah-mono">
                {`#${piece.cite.index}`}
              </span>
            ),
          )}
        </span>
      </span>
      {line.fails.length > 0 ? (
        <span class="lah-chron-mark" data-tone="warn">
          <Icon name="alert" size={14} />
          <span>{failWords(line.fails)}</span>
        </span>
      ) : null}
      {line.moves.length > 0 ? (
        <span class="lah-chron-mark">
          <Icon name="arrow-right" size={14} />
          <span>{moveWords(line.moves)}</span>
        </span>
      ) : null}
      {line.uncited ? (
        <span class="lah-chron-mark">
          <Icon name="info" size={14} />
          <span>{UNCITED_WORDS}</span>
        </span>
      ) : null}
    </>
  );
  // How far an item is set in is the file's own, so it is handed to the stylesheet as a number rather than a class a level.
  const depth = { "--lah-depth": String(line.kind === "item" ? line.level : 0) };
  return (
    <div class="lah-chron-row" data-lah-line={line.n} data-kind={line.kind} data-failed={line.fails.length > 0 || undefined} data-found={props.found || undefined} style={depth}>
      {line.citations.length > 0 ? (
        <button type="button" class="lah-chron-line" aria-expanded={props.open} onClick={props.onPress}>
          {words}
        </button>
      ) : line.kind === "heading" ? (
        <div class="lah-chron-line" role="heading" aria-level={Math.min(6, line.level + 2)}>
          {words}
        </div>
      ) : (
        <div class="lah-chron-line">{words}</div>
      )}
      {props.open && props.cited !== null ? (
        <div class="lah-chron-cited" data-lah-cited-of={line.n}>
          <CitedList cited={props.cited} />
        </div>
      ) : null}
    </div>
  );
}

/** How far the chronicle has come, and the learning of the story: the offer to start it, or the job that does it and what it needs. */
function StoryPanel(props: { chatId: string; card: StoryCard; story: StoryView; agents: readonly { id: string; name: string }[]; onChanged(): void; onPlan(path: string): void }) {
  const app = useApp();
  const { card, story } = props;
  const job = card.job;
  const [draft, setDraft] = useState<LearnDraft | null>(null);
  const [more, setMore] = useState<AllowanceDraft | null>(null);
  const [starting, start] = useBusy();
  const [cancelling, cancel] = useBusy();
  const [resuming, resume] = useBusy();
  const [granting, grant] = useBusy();
  // The form is for the offer it was opened on: once a job stands in its place, it closes.
  useEffect(() => {
    if (!card.learn) setDraft(null);
    if (!card.actions.grant) setMore(null);
  }, [card.learn, card.actions.grant]);
  // Home led here to learn this story: the form opens as if its button were pressed, where there is one to press.
  const asked = useSelect(app.nav, (n) => n.learn);
  useEffect(() => {
    if (!asked) return;
    if (card.learn) setDraft((held) => held ?? learnDraft(story));
    app.nav.update((n) => ({ ...n, learn: false }));
  }, [asked]);
  const blocked = draft !== null ? learnBlock(draft) : null;
  const learn = (): void => {
    if (draft === null || blocked !== null) return;
    start(async () => {
      try {
        await app.client.request("lah.job.start", learnBody(props.chatId, draft));
        setDraft(null);
        app.toast("Learning started. It works in the background: you can keep writing.");
        props.onChanged();
      } catch (error) {
        app.fail(error);
      }
    });
  };
  const again = (): void => {
    if (job === null) return;
    start(async () => {
      try {
        await app.client.request("lah.job.again", { id: job.id });
        app.toast("Started again, with the same agent and task.");
        props.onChanged();
      } catch (error) {
        app.fail(error);
      }
    });
  };
  const stop = (): void => {
    if (job === null) return;
    cancel(async () => {
      if (!(await app.host.confirm({ title: "Stop learning this story?", message: "The agent stops where it is. What it has written to the chronicle so far stays, and the rest can be learned later.", confirm: "Yes, stop it", danger: true }))) return;
      try {
        await app.client.request("lah.job.cancel", { id: job.id });
        app.toast("Stopped. What it wrote so far stays.");
        props.onChanged();
      } catch (error) {
        app.fail(error);
      }
    });
  };
  const goOn = (): void => {
    if (job === null) return;
    resume(async () => {
      try {
        await app.client.request("lah.job.resume", { id: job.id });
        app.toast("Resumed. It carries on from where it stopped.");
        props.onChanged();
      } catch (error) {
        app.fail(error);
      }
    });
  };
  const grantBlocked = more !== null && job !== null ? grantBlock(more, job.allowance) : null;
  const granted = (said: string): void => {
    setMore(null);
    app.toast(said);
    props.onChanged();
  };
  const grantIt = (): void => {
    if (more === null || job === null || grantBlocked !== null) return;
    grant(async () => {
      try {
        await app.client.request("lah.job.grant", { id: job.id, allowance: allowanceOf(more) });
        granted("Granted. It carries on from where it stopped.");
      } catch (error) {
        app.fail(error);
      }
    });
  };
  // One press carries a stopped learning on: out of its budget, it is given what the rest should need; paused at a day's limit, it needs nothing more of its own.
  const carry = job !== null && card.actions.grant ? carryOnGrant(job, story.estimate) : null;
  const carryOn = (): void => {
    if (job === null) return;
    grant(async () => {
      try {
        await app.client.request("lah.job.grant", { id: job.id, allowance: carry ?? {} });
        granted(carry !== null ? "It carries on to the end, from where it stopped." : "It carries on from where it stopped. If the day's limit still stands, it pauses there again.");
      } catch (error) {
        app.fail(error);
      }
    });
  };
  const plan = story.plan;
  // A job that carries on still names its last run's record while it waits for its next run and while that is under way: what runs is followed as it happens.
  const stored = job === null || card.live ? null : (job.transcript ?? null);
  const fraction = card.progress.fraction;
  return (
    <section class="lah-chron-story" data-lah-story={card.state}>
      <div class="lah-chron-story-head">
        <strong class="lah-h">{card.title}</strong>
        {card.badge !== null ? (
          <Badge tone={card.badge.tone}>
            <Icon name={card.badge.icon} size={12} />
            {card.badge.word}
          </Badge>
        ) : null}
      </div>
      <p class="lah-small" data-lah-story-progress>
        {card.progress.words}
      </p>
      {fraction !== null ? (
        <div class="lah-meter" role="meter" aria-label="How much of the chat the chronicle covers" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(fraction * 100)} aria-valuetext={card.progress.words} style={{ "--lah-fill": String(fraction) }}>
          <span />
        </div>
      ) : null}
      {card.estimate !== "" ? (
        <p class="lah-small" data-lah-story-estimate>
          {card.estimate}
        </p>
      ) : null}
      {card.text !== "" ? <p class="lah-small lah-muted">{card.text}</p> : null}
      {card.reason !== null ? (
        <Banner tone={card.reason.tone} title={card.reason.title}>
          {card.reason.text}
        </Banner>
      ) : null}
      <div class="lah-actions">
        {card.learn && draft === null ? (
          <Button variant="primary" icon="scroll" busy={starting} onClick={() => setDraft(learnDraft(story))}>
            {card.state === "done" || story.covered > 0 ? "Learn the rest" : "Learn this story"}
          </Button>
        ) : null}
        {(card.actions.grant || card.actions.carryOn) && job !== null ? (
          <Button variant="primary" icon="play" busy={granting} onClick={carryOn}>
            {CARRY_ON}
          </Button>
        ) : null}
        {card.actions.resume ? (
          <Button variant="primary" icon="play" busy={resuming} onClick={goOn}>
            Resume
          </Button>
        ) : null}
        {card.actions.grant && job !== null ? (
          <Button icon="sliders" expanded={more !== null} onClick={() => setMore(more === null ? allowanceDraft({ ...job.allowance, ...carry }, null) : null)}>
            Choose exactly
          </Button>
        ) : null}
        {card.actions.carryOn ? (
          <Button icon="coins" onClick={() => app.nav.update((n) => ({ ...n, page: "spend" }))}>
            See the day's limits
          </Button>
        ) : null}
        {card.actions.again ? (
          <Button variant="primary" icon="refresh" busy={starting} onClick={again}>
            Start again
          </Button>
        ) : null}
        {card.actions.cancel ? (
          <Button icon="stop" busy={cancelling} onClick={stop}>
            Stop
          </Button>
        ) : null}
        {plan !== null ? (
          <Button variant="ghost" icon="file" onClick={() => props.onPlan(plan)}>
            Read its plan
          </Button>
        ) : null}
        {job !== null ? (
          <Button variant="ghost" icon="arrow-right" onClick={() => app.nav.update((n) => ({ ...n, page: "jobs", job: job.id }))}>
            Open the job
          </Button>
        ) : null}
      </div>
      {carry !== null && more === null && grantWords(carry) !== "" ? (
        <p class="lah-small lah-muted" data-lah-story-carry>
          {`${CARRY_ON}: ${grantWords(carry)}`}
        </p>
      ) : null}
      {card.learn && draft !== null ? (
        <div class="lah-chron-form" data-lah-story-form>
          <p class="lah-small">
            {`${agentName(draft.agent, props.agents)} reads the chat and writes the chronicle. Nothing in your chat changes, and you can stop it at any time.`}
          </p>
          {/* What it may spend is said before it is started, in a sentence: the fields that change it are folded under the two buttons, so starting is one more press. */}
          <p class="lah-small" data-lah-story-spend>
            {allowanceWords(draft.allowance)}
          </p>
          {blocked !== null ? <p class="lah-field-help">{blocked}</p> : null}
          <div class="lah-actions">
            <Button variant="primary" icon="check" busy={starting} disabled={blocked !== null} onClick={learn}>
              Start learning
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Not now
            </Button>
          </div>
          <Disclosure summary={<span class="lah-small">Choose exactly</span>}>
            <Field label="Its budget" help={ALLOWANCE_WORDS}>
              <AllowanceFields draft={draft.allowance} onChange={(allowance) => setDraft({ ...draft, allowance })} />
            </Field>
          </Disclosure>
          <Disclosure summary={<span class="lah-small">Change what it is asked, or who does it</span>}>
            <Field label="What it is asked">
              <Editor value={draft.task} label="What the agent that learns this story is asked" rows={8} prose onInput={(task) => setDraft({ ...draft, task })} />
            </Field>
            <Field label="The agent that does it">
              <Select value={draft.agent} label="The agent that learns this story" options={agentChoices(draft.agent, props.agents, (id) => agentName(id, props.agents))} onChange={(agent) => setDraft({ ...draft, agent })} />
            </Field>
          </Disclosure>
        </div>
      ) : null}
      {card.actions.grant && more !== null ? (
        <div class="lah-chron-form" data-lah-story-grant>
          <p class="lah-small lah-muted">Its budget in all from now on. The fields start from what one press would give it; what it has spent already counts against them, and it carries on from where it stopped.</p>
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
        </div>
      ) : null}
      {job !== null && (card.live || stored !== null) ? (
        <Disclosure summary={<span class="lah-small">{card.live ? "Its work, as it happens" : "Its work, step by step"}</span>} defaultOpen={card.live}>
          {/* The run follows its newest step by scrolling the nearest box that scrolls: this one, so the page itself stays where the reader is. */}
          <div class="lah-chron-run" data-lah-story-run>
            <RunPane stream={job.id} transcript={stored} none={<p class="lah-lead lah-small">It hasn't started yet.</p>} />
          </div>
        </Disclosure>
      ) : null}
    </section>
  );
}

export function ChroniclePage() {
  const app = useApp();
  const chatId = useShownChat();
  const chat = useChatView(chatId);
  const asked = useSelect(app.nav, (n) => n.chronicle);
  const message = useSelect(app.nav, (n) => n.message);
  const active = useSelect(app.client.state, (s) => s?.jobs.active ?? NO_JOBS);
  const off = useSelect(app.client.state, (s) => s?.jobs.off ?? false);
  const paused = useSelect(app.client.state, (s) => s?.jobs.paused ?? false);
  const changed = useSelect(app.client.state, (s) => s?.jobs.changed ?? 0);
  const running = useSelect(app.client.state, (s) => s?.running ?? NONE_RUNNING);
  const [read, setRead] = useState<Read>(NOTHING);
  const [again, setAgain] = useState(0);
  const [file, setFile] = useState<FileText>(NO_TEXT);
  const [only, setOnly] = useState(false);
  const [open, setOpen] = useState<LinePlace | null>(null);
  const [cited, setCited] = useState<Cited | null>(null);
  const [found, setFound] = useState<LinePlace | null>(null);
  const [shown, setShown] = useState<Cited | null>(null);
  const lines = useRef<HTMLDivElement>(null);
  /** The read that counts: a slower answer to an earlier one is dropped. */
  const reads = useRef(0);
  const cites = useRef(0);

  // While the job that learns the story works, each step of it may have written to the chronicle: the page reads again as its count of steps moves, with no clock of its own.
  const storyJob = read.story !== null ? storyJobOf(read.story, active) : null;
  const beat = storyJob !== null && (storyJob.state === "running" || storyJob.state === "queued") ? storyJob.usage.toolTurns : -1;
  useEffect(() => {
    if (chatId === null) {
      setRead(NOTHING);
      return;
    }
    const mine = (reads.current += 1);
    // Another chat's chronicle doesn't stand in for this one's while it is read; the same chat's does, so reading again doesn't blank the page.
    setRead((held) => (held.chatId === chatId ? held : { ...NOTHING, chatId }));
    Promise.all([
      app.client.request("lah.chronicle.get", { chatId }),
      app.client.request("lah.story.get", { chatId }),
      // What else the folder holds is a help, not a need: where its listing can't be read the page shows the chronicle's own files.
      app.client.request("lah.ws.list", { chatId, area: "learned" }).then(
        (listing) => listing,
        () => null,
      ),
    ]).then(
      ([view, story, listing]) => {
        if (mine !== reads.current) return;
        setRead({ status: "ready", chatId, view, story, extras: extraPaths(listing?.files ?? [], story.plan), agents: listing?.agents ?? [], message: "" });
      },
      (error: unknown) => {
        if (mine !== reads.current) return;
        setRead((held) => ({ ...held, status: "failed", message: errorWords(error) }));
      },
    );
  }, [chatId, again, changed, beat]);

  const view = read.chatId === chatId ? read.view : null;
  const story = read.chatId === chatId ? read.story : null;
  const choices = view !== null ? fileChoices(view, read.extras) : [];
  const choice = shownChoice(choices, asked?.path ?? null);
  const path = choice?.path ?? null;

  // The file shown is read whenever the chronicle is: an agent may have written to it since.
  useEffect(() => {
    if (chatId === null || path === null) {
      setFile(NO_TEXT);
      return;
    }
    let live = true;
    setFile((held) => (held.path === path ? held : { ...NO_TEXT, path }));
    app.client.request("lah.ws.read", { chatId, area: "learned", path: learnedPath(agentsPath(path)) }).then(
      (r) => live && setFile({ status: "ready", path, text: r.text, message: "" }),
      (error: unknown) => live && setFile((held) => ({ ...held, path, status: "failed", message: errorWords(error) })),
    );
    return () => {
      live = false;
    };
  }, [chatId, path, view]);

  // Another chat, another file: what was open of the last one closes.
  useEffect(() => {
    setOpen(null);
    setCited(null);
  }, [chatId, path, only]);
  useEffect(() => {
    setOnly(false);
    setFound(null);
  }, [chatId]);

  // Another page led here to a line: once its file shows, the line comes into view marked, and the lead is taken so coming back later moves nothing.
  const wanted = asked?.line ?? null;
  useLayoutEffect(() => {
    if (wanted === null || path === null || file.status !== "ready" || file.path !== path) return;
    setOnly(false);
    setFound({ path, line: wanted });
    app.nav.update((n) => (n.chronicle !== null ? { ...n, chronicle: { ...n.chronicle, line: null } } : n));
  }, [wanted, path, file.status, file.path]);
  useLayoutEffect(() => {
    if (found !== null && lines.current) revealInScroller(lines.current.querySelector(`[data-lah-line="${found.line}"]`), "center");
  }, [found, file.text, only]);

  // Another page led here to a message by its citation: it is read as it stands now and shown over the files.
  useEffect(() => {
    if (chatId === null || message === null) {
      setShown(null);
      return;
    }
    let live = true;
    setShown({ status: "loading", list: [], message: "" });
    app.client.request("lah.chronicle.cited", { chatId, citations: [message] }).then(
      (r) => live && setShown({ status: "ready", list: r.cited, message: "" }),
      (error: unknown) => live && setShown({ status: "failed", list: [], message: errorWords(error) }),
    );
    return () => {
      live = false;
    };
  }, [chatId, message]);

  const pick = (next: string, line: number | null = null): void => {
    setOnly(false);
    if (line === null) setFound(null);
    app.nav.update((n) => ({ ...n, chronicle: { path: learnedPath(agentsPath(next)), line } }));
  };
  const press = (place: LinePlace, line: ChronLine): void => {
    if (chatId === null) return;
    if (samePlace(open, place) && cited?.status !== "failed") {
      setOpen(null);
      setCited(null);
      return;
    }
    const mine = (cites.current += 1);
    setOpen(place);
    setCited({ status: "loading", list: [], message: "" });
    app.client.request("lah.chronicle.cited", { chatId, citations: line.citations.map((c) => c.citation) }).then(
      (r) => mine === cites.current && setCited({ status: "ready", list: r.cited, message: "" }),
      (error: unknown) => mine === cites.current && setCited({ status: "failed", list: [], message: errorWords(error) }),
    );
  };

  if (chatId === null)
    return (
      <div class="lah-stack" data-lah-view="chronicle" data-lah-chronicle="nochat">
        <ChatBar />
        <Empty icon="scroll" title="No chat is open">
          The chronicle is what a story has established, written down so no agent has to read the whole chat again. Open a chat in Lumiverse, or pick one above.
        </Empty>
      </div>
    );
  if (view === null || story === null)
    return (
      <div class="lah-stack" data-lah-view="chronicle" data-lah-chronicle={read.status === "failed" ? "failed" : "loading"}>
        <ChatBar />
        {read.status === "failed" ? (
          <Empty
            icon="alert"
            title="The chronicle couldn't be read"
            action={
              <Button icon="refresh" onClick={() => setAgain(again + 1)}>
                Try again
              </Button>
            }
          >
            {read.message}
          </Empty>
        ) : (
          <Empty icon="hourglass">Reading this chat's chronicle…</Empty>
        )}
      </div>
    );

  const has = hasChronicle(view);
  const card = storyCard({ story, active, held: heldStreams(running), switches: { off, paused }, has, on: chat !== null ? chat.on : null });
  const counts = countsOf(view);
  const quiet = quietWords(counts);
  const failing = only ? failingLines(view) : [];
  const places = failedPlaces(view);
  const toNext = (): void => {
    const next = nextPlace(places, found);
    if (next === null) return;
    setOnly(false);
    setFound(next);
    app.nav.update((n) => ({ ...n, chronicle: { path: learnedPath(agentsPath(next.path)), line: null } }));
  };
  const fileLines = choice !== null && file.path === choice.path && file.status !== "loading" ? linesOf(file.text, choice.own ? marksOf(view, choice.path) : null) : [];
  return (
    <div class="lah-stack" data-lah-view="chronicle" data-lah-chronicle={has ? "ready" : "none"} data-lah-file={path ?? undefined}>
      <ChatBar />
      {read.status === "failed" ? (
        <Banner
          tone="neg"
          title="The chronicle couldn't be read again"
          actions={
            <Button size="sm" icon="refresh" onClick={() => setAgain(again + 1)}>
              Try again
            </Button>
          }
        >
          {`${read.message} What shows is as it was last read.`}
        </Banner>
      ) : null}
      {message !== null && shown !== null ? (
        <section class="lah-chron-shown" data-lah-message={message}>
          <div class="lah-chron-story-head">
            <strong class="lah-h">The message you were led to</strong>
            <Button size="sm" variant="ghost" icon="close" onClick={() => app.nav.update((n) => ({ ...n, message: null }))}>
              Close
            </Button>
          </div>
          <CitedList cited={shown} />
        </section>
      ) : null}
      <div class="lah-chron">
        <div class="lah-chron-col">
          <StoryPanel chatId={chatId} card={card} story={story} agents={read.agents} onChanged={() => setAgain((n) => n + 1)} onPlan={(plan) => pick(plan)} />
          {!has ? (
            <p class="lah-small lah-muted" data-lah-chronicle-about>
              A chronicle is four short files: the story's outline, what it has established, what is still open, and who is who. Each line names the messages it rests on, so an agent can trust it without reading the whole chat again, and a line stops being used once a message under it is swiped, edited or removed.
            </p>
          ) : null}
          {counts.failed > 0 ? (
            <Banner
              tone="warn"
              title={failedWords(counts.failed)}
              actions={
                <>
                  <Button size="sm" pressed={only} onClick={() => setOnly(!only)}>
                    {only ? "Show the files" : "Show only these"}
                  </Button>
                  <Button size="sm" variant="ghost" icon="arrow-right" onClick={toNext}>
                    Go to the next one
                  </Button>
                </>
              }
            >
              A message under each was swiped, edited or removed, so agents are no longer given the line. Press one to see what changed, then edit or delete it in the workspace.
            </Banner>
          ) : has ? (
            <p class="lah-line" data-lah-chronicle-holds>
              <Icon name="check" size={14} />
              <span>Every cited line still holds.</span>
            </p>
          ) : null}
          {quiet !== null ? <p class="lah-small lah-muted">{quiet}</p> : null}
        </div>
        {choices.length > 0 ? (
          <div class="lah-chron-col">
            {only ? (
              <div class="lah-chron-lines" ref={lines} data-lah-chronicle-only>
                {failing.map((group) => (
                  <div key={group.path} class="lah-chron-group">
                    <div class="lah-chron-grouphead">
                      <strong>{group.label}</strong>
                      <Button size="sm" variant="ghost" icon="arrow-right" onClick={() => pick(group.path, group.lines[0]?.n ?? null)}>
                        Open the file
                      </Button>
                    </div>
                    {group.lines.map((line) => {
                      const place = { path: group.path, line: line.n };
                      return <Line key={line.n} line={line} open={samePlace(open, place)} found={false} cited={samePlace(open, place) ? cited : null} onPress={() => press(place, line)} />;
                    })}
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div class="lah-chron-files" role="group" aria-label="The chronicle's files">
                  {choices.map((c) => (
                    <Chip key={c.path} pressed={choice !== null && c.path === choice.path} onClick={() => pick(c.path)}>
                      {c.label}
                      {c.failed > 0 ? (
                        <Badge tone="warn">
                          <Icon name="alert" size={12} />
                          {String(c.failed)}
                        </Badge>
                      ) : null}
                    </Chip>
                  ))}
                </div>
                {choice !== null ? (
                  <>
                    <div class="lah-chron-filehead">
                      <span class="lah-small lah-muted">{choice.about ?? choice.path}</span>
                      <Button size="sm" variant="ghost" icon="edit" onClick={() => app.nav.update((n) => ({ ...n, page: "workspace", file: workspaceTarget(choice.path) }))}>
                        Edit in the workspace
                      </Button>
                    </div>
                    {file.status === "failed" ? (
                      <Banner tone="neg" title="This file couldn't be read">
                        {`${file.message} Pick it again to try once more.`}
                      </Banner>
                    ) : file.status === "loading" || file.path !== choice.path ? (
                      <p class="lah-small lah-muted">Reading the file…</p>
                    ) : fileLines.length === 0 ? (
                      <p class="lah-small lah-muted" data-lah-chronicle-emptyfile>
                        This file is empty.
                      </p>
                    ) : (
                      <div class="lah-chron-lines" ref={lines} data-lah-chronicle-lines>
                        {choice.own ? <p class="lah-chron-hint lah-small lah-muted">Press a line to read the messages it rests on.</p> : null}
                        {fileLines.map((line) => {
                          const place = { path: choice.path, line: line.n };
                          return <Line key={line.n} line={line} open={samePlace(open, place)} found={samePlace(found, place)} cited={samePlace(open, place) ? cited : null} onPress={() => press(place, line)} />;
                        })}
                      </div>
                    )}
                  </>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
