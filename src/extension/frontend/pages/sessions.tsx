// Sessions (DESIGN §8): a chat's turns, newest first, from the records on its replies (§5), each
// with its transcript as Live showed it; the session as it stands (what the main agent would carry
// into the next turn); each compaction point with its summary; and rollback. One column on a phone
// (the list, then the turn chosen, with Back), the list beside the turn where there is room.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { RollbackState, SessionView, TurnRow } from "../../../shared/ui";
import { errorWords, useApp } from "../app";
import { ChatBar, useShownChat } from "../chat";
import { Badge, Banner, Button, CopyButton, Empty, IconButton, Section, useBusy } from "../components";
import { ago, compact, count, counted, dateTime } from "../format";
import { Icon } from "../icons";
import { costWords, TURN_KIND_WORDS } from "../live-model";
import { useBlob, useTranscript } from "../runs";
import { PLACE_LABEL } from "../setup-model";
import { useSelect } from "../store";
import { revealInScroller } from "../scroll";
import { TurnFeed } from "../transcript";

interface TurnList {
  status: "loading" | "ready" | "failed";
  turns: TurnRow[];
  next: string | null;
  total: number;
  session: SessionView | null;
  message: string;
}

const NO_LIST: TurnList = { status: "loading", turns: [], next: null, total: 0, session: null, message: "" };

/** What the Sessions page shows beside the list: a turn's transcript, or the summary a turn's compaction made. */
interface Chosen {
  kind: "turn" | "summary";
  messageId: string;
  swipe: number;
}

const sameTurn = (t: TurnRow, c: { messageId: string; swipe: number }): boolean => t.messageId === c.messageId && t.swipe === c.swipe;

const ROLLBACK_WORDS: Readonly<Record<Exclude<RollbackState, "available">, string>> = {
  pending: "You asked to undo this summary: at the chat's next reply the main agent reads the notes it replaced again, in full.",
  done: "This summary was undone: the main agent reads the notes it replaced again, in full.",
  none: "This summary can't be undone: a later summary stands on it, or the notes it replaced are no longer kept.",
};

/** A compaction point: what it replaced, the way to its summary (where it isn't the summary's own page), and its rollback. */
function Compaction(props: { turn: TurnRow; busy: boolean; onSummary?(): void; onRollback(): void }) {
  const c = props.turn.compaction;
  if (c === null) return null;
  return (
    <div class="lah-compaction" data-lah-compaction={c.rollback}>
      <span class="lah-compaction-head">
        <Icon name="layers" size={14} />
        <span>{`A summary was made here: it took the place of the main agent's notes of ${counted(c.replaced, "earlier reply", "earlier replies")}.`}</span>
      </span>
      {c.rollback === "available" ? null : <span>{ROLLBACK_WORDS[c.rollback]}</span>}
      <div class="lah-actions">
        {props.onSummary ? (
          <Button size="sm" icon="file" onClick={props.onSummary}>
            Read the summary
          </Button>
        ) : null}
        {c.rollback === "available" ? (
          <Button size="sm" icon="undo" busy={props.busy} onClick={props.onRollback}>
            Undo the summary
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The session as it stands, a sentence a line. */
function sessionLines(s: SessionView): string[] {
  const lines = [s.turns === 0 && !s.summary ? "Nothing is carried yet: the next reply starts the main agent's notes." : `For the next reply the main agent reads its notes of the last ${counted(s.turns, "reply", "replies")} in full (≈${count(s.tokens)} tokens)${s.summary ? ", and a summary of the ones before" : ""}.`];
  if (s.dropped > 0) lines.push(`Its notes of ${counted(s.dropped, "reply", "replies")} are no longer used: an earlier message of the chat was changed or swiped after ${s.dropped === 1 ? "it" : "them"}.`);
  if (s.missing > 0) lines.push(`${counted(s.missing, "stored part")} of the notes can't be found and ${s.missing === 1 ? "is" : "are"} left out.`);
  return lines;
}

function Detail(props: { chatId: string; turn: TurnRow; kind: Chosen["kind"]; busy: boolean; onBack(): void; onRollback(): void; onKind(kind: Chosen["kind"]): void; onChanges(): void }) {
  const { turn } = props;
  const transcript = useTranscript(props.kind === "turn" ? turn.transcript : null);
  const summary = useBlob(props.kind === "summary" ? (turn.compaction?.summary ?? null) : null);
  return (
    <>
      <div class="lah-pane-head">
        <span class="lah-back">
          <IconButton icon="chevron-left" label="Back to the replies" onClick={props.onBack} />
        </span>
        <span class="lah-pane-title">
          <strong class="lah-h">{props.kind === "summary" ? `The summary made at reply #${turn.index}` : `Reply #${turn.index} · ${TURN_KIND_WORDS[turn.kind]}`}</strong>
          <span class="lah-dim lah-small">{[dateTime(turn.at), ...(turn.place !== undefined ? [PLACE_LABEL[turn.place].toLowerCase()] : []), `swipe ${turn.swipe + 1}`].join(" · ")}</span>
        </span>
        {turn.changes > 0 ? (
          <Button size="sm" icon="folder" onClick={props.onChanges}>
            {`${counted(turn.changes, "file")} changed`}
          </Button>
        ) : null}
      </div>
      {turn.onPath ? null : (
        <Banner tone="warn" title="No longer used">
          An earlier message of the chat was changed or swiped after this reply, so the main agent's notes of it no longer fit the chat and it doesn't read them. What the agents did for it is still here.
        </Banner>
      )}
      {props.kind === "summary" ? (
        <Section
          title="What the main agent reads in place of its notes of the replies before"
          aside={summary.text !== null ? <CopyButton text={summary.text} label="Copy the summary" /> : undefined}
        >
          {summary.failed !== null ? (
            <p class="lah-line lah-is-warn">
              <Icon name="alert" size={14} />
              <span>{`The summary couldn't be read: ${summary.failed}`}</span>
            </p>
          ) : summary.text === null ? (
            <p class="lah-lead">Reading the summary…</p>
          ) : (
            <pre class="lah-text" data-lah-summary>
              {summary.text}
            </pre>
          )}
          <Compaction turn={turn} busy={props.busy} onRollback={props.onRollback} />
          <div class="lah-actions">
            <Button size="sm" icon="list" onClick={() => props.onKind("turn")}>
              Show what the agents did for this reply
            </Button>
          </div>
        </Section>
      ) : turn.transcript === null ? (
        <Empty icon="file" title="Its steps weren't kept">
          This reply's record doesn't hold what the agents did, so only its figures are known: {turn.usage ? `${counted(turn.usage.calls, "call")}, ${count(turn.usage.in)} tokens in, ${count(turn.usage.out)} out.` : "none were recorded."}
        </Empty>
      ) : transcript.state === null || transcript.state.status === "loading" ? (
        <Empty icon="hourglass">Reading what the agents did…</Empty>
      ) : transcript.state.status === "failed" ? (
        <Empty
          icon="alert"
          title="What the agents did couldn't be read"
          action={
            <Button icon="refresh" onClick={transcript.again}>
              Try again
            </Button>
          }
        >
          {transcript.state.message}
        </Empty>
      ) : (
        <TurnFeed view={transcript.state.view} live={false} partial={transcript.state.partial} onRetry={transcript.again} />
      )}
    </>
  );
}

export function SessionsPage() {
  const app = useApp();
  const chatId = useShownChat();
  const pageTurns = useSelect(app.prefs, (p) => p.pageTurns);
  const running = useSelect(app.client.state, (s) => chatId !== null && (s?.running.some((r) => r.chatId === chatId) ?? false));
  const [list, setList] = useState<TurnList>(NO_LIST);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [more, readMore] = useBusy();
  const [rolling, roll] = useBusy();
  const now = app.now();
  /** Which read the list last asked for: an answer to an older one (another chat's) is dropped. */
  const asked = useRef(0);
  const read = (chat: string): void => {
    asked.current += 1;
    const mine = asked.current;
    setList((held) => ({ ...held, status: held.turns.length > 0 ? held.status : "loading" }));
    app.client.request("lah.turns.list", { chatId: chat, cursor: null, limit: pageTurns }).then(
      (page) => mine === asked.current && setList({ status: "ready", turns: page.turns, next: page.next, total: page.total, session: page.session, message: "" }),
      (error: unknown) => mine === asked.current && setList((held) => ({ ...held, status: "failed", message: errorWords(error) })),
    );
  };
  // Another chat is another list; a turn of this chat that just ended has left a new record to list.
  useEffect(() => {
    setList(NO_LIST);
    setChosen(null);
    if (chatId !== null) read(chatId);
  }, [chatId]);
  useEffect(() => {
    if (chatId !== null && !running) read(chatId);
  }, [running]);
  useEffect(() => (chatId === null ? undefined : app.client.onBack(() => read(chatId))), [chatId]);
  const turn = chosen ? (list.turns.find((t) => sameTurn(t, chosen)) ?? null) : null;
  // A turn picked from the list starts at its head: the panel may be scrolled far down the list, or down the turn shown before it.
  const detail = useRef<HTMLDivElement>(null);
  const shownKey = chosen && turn ? `${chosen.kind}:${chosen.messageId}:${chosen.swipe}` : null;
  useLayoutEffect(() => {
    if (shownKey !== null) revealInScroller(detail.current, "start");
  }, [shownKey]);
  const rollback = (target: TurnRow): void =>
    roll(async () => {
      if (chatId === null || target.compaction === null) return;
      const agreed = await app.host.confirm({
        title: "Undo this summary?",
        message: `From the chat's next reply on, the main agent reads its notes of the ${counted(target.compaction.replaced, "reply", "replies")} this summary replaced again, in full. That takes more tokens each reply, and the notes may be summarized again when they pass their limit. The summary is kept.`,
        confirm: "Undo the summary",
      });
      if (!agreed) return;
      try {
        const result = await app.client.request("lah.session.rollback", { chatId, messageId: target.messageId, swipe: target.swipe });
        setList((held) => ({ ...held, session: result.session, turns: held.turns.map((t) => (sameTurn(t, result.turn) ? result.turn : t)) }));
        app.toast(result.turn.compaction?.rollback === "done" ? "The summary was undone." : "Asked: the chat's next reply undoes the summary.");
      } catch (error) {
        app.fail(error);
      }
    });
  const [summarizing, askSummary] = useBusy();
  const summarize = (): void =>
    askSummary(async () => {
      if (chatId === null) return;
      try {
        const result = await app.client.request("lah.session.summarize", { chatId });
        setList((held) => ({ ...held, session: result.session }));
        app.toast("Asked: the chat's next reply summarizes the notes.");
      } catch (error) {
        app.fail(error);
      }
    });
  if (chatId === null)
    return (
      <div class="lah-stack" data-lah-view="sessions">
        <ChatBar />
        <Empty icon="message" title="No chat is open">
          Past replies shows what the agents did for each reply of the chat open in Lumiverse, and the notes the main agent carries on. Open a chat, or pick one above.
        </Empty>
      </div>
    );
  return (
    <div class="lah-split" data-lah-view="sessions" data-pane={turn ? "detail" : "list"}>
      <div class="lah-split-list">
        <ChatBar aside={<IconButton icon="refresh" label="Read the list again" onClick={() => read(chatId)} />} />
        {list.session ? (
          <Section title="What carries into the next reply" id="session">
            <div class="lah-stack" data-lah-session-now>
              {sessionLines(list.session).map((line) => (
                <p key={line}>{line}</p>
              ))}
              {list.session.held === true && !list.session.asked ? <p class="lah-dim">You undid a summary, so the notes stay in full for now: they are summarized again once they have grown by the margin Settings give, or when you ask.</p> : null}
              {list.session.asked ? (
                <p class="lah-line" data-lah-summary-asked>
                  <Icon name="check" size={14} />
                  <span>{`You asked for a summary ${ago(now, list.session.asked)}: the chat's next reply makes it.`}</span>
                </p>
              ) : list.session.turns > 0 ? (
                <div class="lah-actions">
                  <Button size="sm" icon="layers" busy={summarizing} onClick={summarize}>
                    Summarize the notes at the next reply
                  </Button>
                </div>
              ) : null}
              {running ? (
                <p class="lah-line">
                  <span class="lah-pulse" aria-hidden="true" />
                  <span>A reply is being worked on now; it joins this list when it ends.</span>
                </p>
              ) : null}
            </div>
          </Section>
        ) : null}
        {list.status === "loading" ? (
          <Empty icon="hourglass">Reading the chat's past replies…</Empty>
        ) : list.status === "failed" && list.turns.length === 0 ? (
          <Empty
            icon="alert"
            title="The past replies couldn't be read"
            action={
              <Button icon="refresh" onClick={() => read(chatId)}>
                Try again
              </Button>
            }
          >
            {list.message}
          </Empty>
        ) : list.turns.length === 0 ? (
          <Empty icon="layers" title="No reply yet">
            Each reply LumiAH works on leaves a record with its message: what the agents did, and the notes the main agent carries on. This chat has none yet: send a message in a chat LumiAH answers, and its reply shows here.
          </Empty>
        ) : (
          <>
            <p class="lah-lead lah-small">{`${counted(list.total, "reply", "replies")} LumiAH worked on, newest first${list.turns.length < list.total ? `; ${count(list.turns.length)} shown` : ""}.`}</p>
            <ol class="lah-turns" aria-label="The chat's past replies">
              {list.turns.map((t) => (
                <li key={`${t.messageId}:${t.swipe}`} class="lah-turnrow" data-lah-turnrow={t.turn} data-on-path={t.onPath}>
                  <button type="button" class="lah-navrow" aria-current={chosen !== null && chosen.kind === "turn" && sameTurn(t, chosen)} onClick={() => setChosen({ kind: "turn", messageId: t.messageId, swipe: t.swipe })}>
                    <span class="lah-navrow-text">
                      <span class="lah-turnrow-title">
                        <span>{`#${t.index} · ${TURN_KIND_WORDS[t.kind]}`}</span>
                        {t.noPart !== undefined ? <Badge tone="warn">Lumiverse's own reply</Badge> : null}
                        {t.onPath ? null : <Badge tone="warn">no longer used</Badge>}
                        {t.compaction ? <Badge tone="accent">summary made</Badge> : null}
                      </span>
                      <span class="lah-turnrow-preview">{t.preview === "" ? "(an empty reply)" : t.preview}</span>
                      {/* LumiAH had no part in the reply: the row says why in the backend's own words, as Live does. */}
                      {t.noPart !== undefined ? <span class="lah-navrow-sub" data-lah-nopart>{`LumiAH had no part in it. ${t.noPart.text}`}</span> : null}
                      <span class="lah-navrow-sub lah-num">
                        {[ago(now, t.at), ...(t.place !== undefined ? [PLACE_LABEL[t.place].toLowerCase()] : []), ...(t.usage ? [counted(t.usage.calls, "call"), `${compact(t.usage.in)} in`, `${compact(t.usage.out)} out`, costWords(t.usage)] : []), ...(t.changes > 0 ? [`${counted(t.changes, "file")} changed`] : []), ...(t.transcript === null ? ["steps not kept"] : [])].join(" · ")}
                      </span>
                    </span>
                    <Icon name="chevron-right" size={16} class="lah-chev" />
                  </button>
                  <Compaction turn={t} busy={rolling} onSummary={() => setChosen({ kind: "summary", messageId: t.messageId, swipe: t.swipe })} onRollback={() => rollback(t)} />
                </li>
              ))}
            </ol>
            {list.next !== null ? (
              <Button
                icon="chevron-down"
                busy={more}
                onClick={() =>
                  readMore(() =>
                    app.client.request("lah.turns.list", { chatId, cursor: list.next, limit: pageTurns }).then(
                      (page) => setList((held) => ({ ...held, turns: [...held.turns, ...page.turns], next: page.next, total: page.total, session: page.session })),
                      (error: unknown) => app.fail(error),
                    ),
                  )
                }
              >
                {`Show earlier replies (${count(Math.max(0, list.total - list.turns.length))} more)`}
              </Button>
            ) : null}
          </>
        )}
      </div>
      <div class="lah-split-detail" ref={detail}>
        {turn && chosen ? (
          <Detail
            key={`${chosen.kind}:${turn.messageId}:${turn.swipe}`}
            chatId={chatId}
            turn={turn}
            kind={chosen.kind}
            busy={rolling}
            onBack={() => setChosen(null)}
            onRollback={() => rollback(turn)}
            onKind={(kind) => setChosen({ ...chosen, kind })}
            onChanges={() => app.nav.update((n) => ({ ...n, page: "workspace", changes: { messageId: turn.messageId, swipe: turn.swipe } }))}
          />
        ) : (
          <Empty icon="layers" title="Pick a reply">
            What the agents did for it shows here, step by step as Live showed it, with what it took and cost.
          </Empty>
        )}
      </div>
    </div>
  );
}
