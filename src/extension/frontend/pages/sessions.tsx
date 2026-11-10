// Sessions (DESIGN §8): a chat's turns, newest first, from the records on its replies (§5), each
// with its transcript as Live showed it; the session as it stands (what the main agent would carry
// into the next turn); each compaction point with its summary; and rollback. One column on a phone
// (the list, then the turn chosen, with Back), the list beside the turn where there is room.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { LiveView, RollbackState, SessionView, TurnRow } from "../../../shared/ui";
import { errorWords, useApp } from "../app";
import { ChatBar, useShownChat } from "../chat";
import { Badge, Banner, Button, CopyButton, Empty, IconButton, Section, useBusy } from "../components";
import { ago, compact, count, counted, dateTime } from "../format";
import { Icon } from "../icons";
import { costWords, TURN_KIND_WORDS } from "../live-model";
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

type Transcript = { status: "loading" } | { status: "failed"; message: string } | { status: "ready"; view: LiveView; partial: boolean };

/** A stored transcript, read a page at a time until it is whole. */
function useTranscript(chatId: string, hash: string | null): { state: Transcript | null; again(): void } {
  const app = useApp();
  const [state, setState] = useState<Transcript | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (hash === null) {
      setState(null);
      return;
    }
    let live = true;
    // What has been read so far, kept outside the read so a failure part-way shows what there is.
    const held: { view: LiveView | null } = { view: null };
    setState({ status: "loading" });
    void (async () => {
      try {
        let from: number | null = 1;
        while (from !== null) {
          const page: { view: LiveView; next: number | null } = await app.client.request("lah.transcript.get", { chatId, transcript: hash, from });
          if (!live) return;
          const before = held.view;
          // A page that brings nothing yet names more to read would be read for ever.
          if (before !== null && page.view.events.length === 0 && page.next !== null) throw new Error("The transcript's next part came back empty.");
          const view: LiveView = before === null ? page.view : { ...before, events: [...before.events, ...page.view.events], ended: page.view.ended ?? before.ended };
          held.view = view;
          from = page.next;
          setState({ status: "ready", view, partial: false });
        }
      } catch (error) {
        if (!live) return;
        setState(held.view !== null ? { status: "ready", view: held.view, partial: true } : { status: "failed", message: errorWords(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [chatId, hash, tries]);
  return { state, again: () => setTries((n) => n + 1) };
}

/** A stored text (a compaction's summary), read when it shows. */
function useBlob(hash: string | null): { text: string | null; failed: string | null } {
  const app = useApp();
  const [state, setState] = useState<{ text: string | null; failed: string | null }>({ text: null, failed: null });
  useEffect(() => {
    setState({ text: null, failed: null });
    if (hash === null) return;
    let live = true;
    app.client.request("lah.blob.get", { hash }).then(
      (r) => live && setState({ text: r.text, failed: null }),
      (e: unknown) => live && setState({ text: null, failed: errorWords(e) }),
    );
    return () => {
      live = false;
    };
  }, [hash]);
  return state;
}

const ROLLBACK_WORDS: Readonly<Record<Exclude<RollbackState, "available">, string>> = {
  pending: "A rollback is asked for: the chat's next turn reads the turns it replaced again, in full.",
  done: "Rolled back: the session reads the turns it replaced again, in full.",
  none: "It can't be rolled back: a later compaction stands on it, or the turns it replaced are no longer kept.",
};

/** A compaction point: what it replaced, the way to its summary (where it isn't the summary's own page), and its rollback. */
function Compaction(props: { turn: TurnRow; busy: boolean; onSummary?(): void; onRollback(): void }) {
  const c = props.turn.compaction;
  if (c === null) return null;
  return (
    <div class="lah-compaction" data-lah-compaction={c.rollback}>
      <span class="lah-compaction-head">
        <Icon name="layers" size={14} />
        <span>{`Compacted here: a summary took the place of ${counted(c.replaced, "earlier turn")}.`}</span>
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
            Roll back
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The session as it stands, a sentence a line. */
function sessionLines(s: SessionView): string[] {
  const lines = [s.turns === 0 && !s.summary ? "The next turn starts a new session: no earlier turn is carried." : `The next turn reads ${counted(s.turns, "turn")} in full (≈${count(s.tokens)} tokens)${s.summary ? ", after a summary of the ones before" : ""}.`];
  if (s.dropped > 0) lines.push(`${counted(s.dropped, "turn")} ${s.dropped === 1 ? "is" : "are"} off the path and not read: an earlier message changed after ${s.dropped === 1 ? "it" : "them"}.`);
  if (s.missing > 0) lines.push(`${counted(s.missing, "stored part")} ${s.missing === 1 ? "is" : "are"} missing from the store and left out.`);
  return lines;
}

function Detail(props: { chatId: string; turn: TurnRow; kind: Chosen["kind"]; busy: boolean; onBack(): void; onRollback(): void; onKind(kind: Chosen["kind"]): void }) {
  const { turn } = props;
  const transcript = useTranscript(props.chatId, props.kind === "turn" ? turn.transcript : null);
  const summary = useBlob(props.kind === "summary" ? (turn.compaction?.summary ?? null) : null);
  return (
    <>
      <div class="lah-pane-head">
        <span class="lah-back">
          <IconButton icon="chevron-left" label="Back to the turns" onClick={props.onBack} />
        </span>
        <span class="lah-pane-title">
          <strong class="lah-h">{props.kind === "summary" ? `The summary made at reply #${turn.index}` : `Reply #${turn.index} · ${TURN_KIND_WORDS[turn.kind]}`}</strong>
          <span class="lah-dim lah-small">{`${dateTime(turn.at)} · swipe ${turn.swipe + 1} · message ${turn.messageId}`}</span>
        </span>
      </div>
      {turn.onPath ? null : (
        <Banner tone="warn" title="Off the path">
          An earlier message of the chat changed after this turn, so its record no longer fits the chat and the session doesn't read it. Its transcript is still here.
        </Banner>
      )}
      {props.kind === "summary" ? (
        <Section
          title="What the main agent reads in place of the turns before"
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
              Show this turn's transcript
            </Button>
          </div>
        </Section>
      ) : turn.transcript === null ? (
        <Empty icon="file" title="No transcript was kept">
          This turn's record names no transcript, so only its figures are known: {turn.usage ? `${counted(turn.usage.calls, "call")}, ${count(turn.usage.in)} tokens in, ${count(turn.usage.out)} out.` : "none were recorded."}
        </Empty>
      ) : transcript.state === null || transcript.state.status === "loading" ? (
        <Empty icon="hourglass">Reading the transcript…</Empty>
      ) : transcript.state.status === "failed" ? (
        <Empty
          icon="alert"
          title="The transcript couldn't be read"
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
        title: "Roll back this compaction?",
        message: `From its next turn on, the chat's main agent reads the ${counted(target.compaction.replaced, "turn")} this summary replaced again, in full. That takes more tokens each turn, and the session may compact again when it passes its limit. The summary is kept.`,
        confirm: "Roll back",
      });
      if (!agreed) return;
      try {
        const result = await app.client.request("lah.session.rollback", { chatId, messageId: target.messageId, swipe: target.swipe });
        setList((held) => ({ ...held, session: result.session, turns: held.turns.map((t) => (sameTurn(t, result.turn) ? result.turn : t)) }));
        app.toast(result.turn.compaction?.rollback === "done" ? "Rolled back." : "Rollback asked for: the next turn makes it.");
      } catch (error) {
        app.fail(error);
      }
    });
  if (chatId === null)
    return (
      <div class="lah-stack" data-lah-view="sessions">
        <ChatBar />
        <Empty icon="message" title="No chat is open">
          Sessions shows the turns of the chat open in Lumiverse. Open one, or pick a chat LumiAH answers from the list above.
        </Empty>
      </div>
    );
  return (
    <div class="lah-split" data-lah-view="sessions" data-pane={turn ? "detail" : "list"}>
      <div class="lah-split-list">
        <ChatBar aside={<IconButton icon="refresh" label="Read the turns again" onClick={() => read(chatId)} />} />
        {list.session ? (
          <Section title="The session now" id="session">
            <div class="lah-stack" data-lah-session-now>
              {sessionLines(list.session).map((line) => (
                <p key={line}>{line}</p>
              ))}
              {running ? (
                <p class="lah-line">
                  <span class="lah-pulse" aria-hidden="true" />
                  <span>A turn is running now; it joins this list when it ends.</span>
                </p>
              ) : null}
            </div>
          </Section>
        ) : null}
        {list.status === "loading" ? (
          <Empty icon="hourglass">Reading the chat's turns…</Empty>
        ) : list.status === "failed" && list.turns.length === 0 ? (
          <Empty
            icon="alert"
            title="The turns couldn't be read"
            action={
              <Button icon="refresh" onClick={() => read(chatId)}>
                Try again
              </Button>
            }
          >
            {list.message}
          </Empty>
        ) : list.turns.length === 0 ? (
          <Empty icon="layers" title="No turn yet">
            Each reply LumiAH writes leaves a record on its message: what the main agent did, and what it carries on. This chat's messages hold none yet.
          </Empty>
        ) : (
          <>
            <p class="lah-lead lah-small">{`${counted(list.total, "turn")} recorded on this chat's messages, newest first${list.turns.length < list.total ? `; ${count(list.turns.length)} shown` : ""}.`}</p>
            <ol class="lah-turns" aria-label="The chat's turns">
              {list.turns.map((t) => (
                <li key={`${t.messageId}:${t.swipe}`} class="lah-turnrow" data-lah-turnrow={t.turn} data-on-path={t.onPath}>
                  <button type="button" class="lah-navrow" aria-current={chosen !== null && chosen.kind === "turn" && sameTurn(t, chosen)} onClick={() => setChosen({ kind: "turn", messageId: t.messageId, swipe: t.swipe })}>
                    <span class="lah-navrow-text">
                      <span class="lah-turnrow-title">
                        <span>{`#${t.index} · ${TURN_KIND_WORDS[t.kind]}`}</span>
                        {t.onPath ? null : <Badge tone="warn">off the path</Badge>}
                        {t.compaction ? <Badge tone="accent">compacted</Badge> : null}
                      </span>
                      <span class="lah-turnrow-preview">{t.preview === "" ? "(an empty reply)" : t.preview}</span>
                      <span class="lah-navrow-sub lah-num">{[ago(now, t.at), ...(t.usage ? [counted(t.usage.calls, "call"), `${compact(t.usage.in)} in`, `${compact(t.usage.out)} out`, costWords(t.usage)] : []), ...(t.transcript === null ? ["no transcript"] : [])].join(" · ")}</span>
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
                {`Show earlier turns (${count(Math.max(0, list.total - list.turns.length))} more)`}
              </Button>
            ) : null}
          </>
        )}
      </div>
      <div class="lah-split-detail" ref={detail}>
        {turn && chosen ? (
          <Detail key={`${chosen.kind}:${turn.messageId}:${turn.swipe}`} chatId={chatId} turn={turn} kind={chosen.kind} busy={rolling} onBack={() => setChosen(null)} onRollback={() => rollback(turn)} onKind={(kind) => setChosen({ ...chosen, kind })} />
        ) : (
          <Empty icon="layers" title="Pick a turn">
            Its transcript shows here: every agent's steps as Live showed them, with tokens, time and cost, search, filters and export.
          </Empty>
        )}
      </div>
    </div>
  );
}
