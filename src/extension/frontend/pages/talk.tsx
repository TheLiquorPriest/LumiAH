// Talk (DESIGN §19): a conversation with an agent that is no reply in a chat. The user picks an
// agent and, if they like, the chat it is about; says something; and sees the agent work it as Live
// shows a reply's turn, with the same held calls, notes, pause and stop. A conversation is kept in
// LumiAH's own store and never writes a message to the chat. One column on a phone (the
// conversations, then the one chosen, with Back), the list beside it where there is room.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AgentView, ChatView, RunningTurn, SideSession, SideTurn } from "../../../shared/ui";
import { errorWords, useApp } from "../app";
import { useShownChat } from "../chat";
import { Badge, Banner, Button, Disclosure, Editor, Empty, Field, IconButton, Select, useBusy } from "../components";
import { ago, dateTime } from "../format";
import { Icon } from "../icons";
import { END_STATE_WORDS, spentWords } from "../live-model";
import { RunPane } from "../runs";
import { atFoot, revealInScroller, scrollParent } from "../scroll";
import { useSelect } from "../store";
import { aboutChoices, aboutWords, canSend, noAnswerWords, sessionSub, sessionsInOrder, talkAgents, turnsInOrder } from "../talk-model";

const NO_CHATS: readonly ChatView[] = [];
const NONE_RUNNING: readonly RunningTurn[] = [];

interface Sessions {
  status: "loading" | "ready" | "failed";
  sessions: SideSession[];
  message: string;
}

/** Starting a conversation: with which agent, about which chat. */
function NewTalk(props: { onStarted(session: SideSession): void }) {
  const app = useApp();
  const shown = useShownChat();
  const chats = useSelect(app.client.state, (s) => s?.chats ?? NO_CHATS);
  const defs = useSelect(app.client.state, (s) => s?.defs ?? 0);
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [agent, setAgent] = useState("");
  const [about, setAbout] = useState<string | null>(shown);
  const [busy, run] = useBusy();
  // The definitions are read again when one changes: an agent made or switched off elsewhere is offered, or not, at once.
  useEffect(() => {
    let live = true;
    app.client.request("lah.defs.get", {}).then(
      (r) => live && (setAgents(r.agents), setFailed(null)),
      (e: unknown) => live && setFailed(errorWords(e)),
    );
    return () => {
      live = false;
    };
  }, [defs]);
  const offered = talkAgents(agents ?? []);
  const picked = offered.find((a) => a.id === agent) ?? offered.find((a) => a.id === "main") ?? offered[0] ?? null;
  const choices = aboutChoices(shown, chats);
  const start = (): void => {
    if (picked === null) return;
    run(async () => {
      try {
        const r = await app.client.request("lah.side.start", { agent: picked.id, chatId: about });
        props.onStarted(r.session);
      } catch (error) {
        app.fail(error);
      }
    });
  };
  return (
    <section class="lah-talk-new" data-lah-talk-new>
      <strong class="lah-h">Talk to an agent</strong>
      <p class="lah-lead lah-small">It has the tools, the workspace and the guidance it has in a chat. What is said here is kept with LumiAH and never written to a chat.</p>
      {failed !== null ? (
        <p class="lah-line lah-is-warn">
          <Icon name="alert" size={14} />
          <span>{`The agents couldn't be read: ${failed}`}</span>
        </p>
      ) : null}
      <Field label="The agent" help={picked?.description || undefined}>
        <Select label="The agent to talk to" value={picked?.id ?? ""} options={offered.map((a) => ({ value: a.id, label: a.name }))} disabled={offered.length === 0} onChange={setAgent} />
      </Field>
      <Field label="About" help="A conversation about a chat reads that chat and its workspace; one about none has only your own area.">
        <Select label="The chat it is about" value={about ?? ""} options={[{ value: "", label: "No chat" }, ...choices.map((c) => ({ value: c.chatId, label: c.label }))]} onChange={(id) => setAbout(id === "" ? null : id)} />
      </Field>
      <div class="lah-actions">
        <Button variant="primary" icon="plus" busy={busy} disabled={picked === null} onClick={start}>
          Start a conversation
        </Button>
      </div>
    </section>
  );
}

interface Turns {
  status: "loading" | "ready" | "failed";
  /** Newest first, as the backend gives them. */
  turns: SideTurn[];
  next: string | null;
  message: string;
}

const NO_TURNS: Turns = { status: "loading", turns: [], next: null, message: "" };

/** One conversation: what was said and answered, the agent at work on the latest, and the box to say more. */
function Conversation(props: { session: SideSession; working: boolean; onBack(): void; onChanged(session: SideSession): void; onRemoved(): void }) {
  const app = useApp();
  const { session } = props;
  const chats = useSelect(app.client.state, (s) => s?.chats ?? NO_CHATS);
  const pageTurns = useSelect(app.prefs, (p) => p.pageTurns);
  const coarse = useSelect(app.host.coarse, (c) => c);
  const [page, setPage] = useState<Turns>(NO_TURNS);
  const [text, setText] = useState("");
  const [sending, send] = useBusy();
  const [removing, remove] = useBusy();
  const foot = useRef<HTMLDivElement>(null);
  /** The read that counts: a slower answer to an earlier one is dropped. */
  const asked = useRef(0);
  const read = (): void => {
    const mine = (asked.current += 1);
    app.client.request("lah.side.turns", { session: session.id, cursor: null, limit: pageTurns }).then(
      (r) => mine === asked.current && setPage({ status: "ready", turns: r.turns, next: r.next, message: "" }),
      (e: unknown) => mine === asked.current && setPage((held) => ({ ...held, status: "failed", message: errorWords(e) })),
    );
  };
  const earlier = (): void => {
    if (page.next === null) return;
    const mine = (asked.current += 1);
    app.client.request("lah.side.turns", { session: session.id, cursor: page.next, limit: pageTurns }).then(
      (r) => mine === asked.current && setPage((held) => ({ status: "ready", turns: [...held.turns, ...r.turns], next: r.next, message: "" })),
      (e: unknown) => app.fail(e),
    );
  };
  // A turn that just ended has left its answer and its transcript to read.
  useEffect(() => {
    read();
  }, [session.id, props.working]);
  useEffect(() => app.client.onBack(read), [session.id]);
  // What was just said, and the agent starting on it, come into view: unless the user has scrolled up to read.
  const last = page.turns[0]?.turn;
  useLayoutEffect(() => {
    const scroller = foot.current ? scrollParent(foot.current) : null;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [last]);
  const say = (): void => {
    if (!canSend(text)) return;
    send(async () => {
      try {
        const r = await app.client.request("lah.side.send", { session: session.id, text: text.trim() });
        setText("");
        props.onChanged(r.session);
        read();
      } catch (error) {
        app.fail(error);
      }
    });
  };
  const drop = (): void =>
    remove(async () => {
      if (!(await app.host.confirm({ title: "Delete this conversation?", message: `"${session.title}" with ${session.agentName}, and the record of its ${session.turns === 1 ? "turn" : "turns"}, will be gone. What its agent wrote to the workspace stays.`, confirm: "Delete" }))) return;
      try {
        await app.client.request("lah.side.remove", { session: session.id });
        props.onRemoved();
      } catch (error) {
        app.fail(error);
      }
    });
  const turns = turnsInOrder(page.turns);
  return (
    <>
      <div class="lah-pane-head">
        <span class="lah-back">
          <IconButton icon="chevron-left" label="Back to the conversations" onClick={props.onBack} />
        </span>
        <span class="lah-pane-title">
          <strong class="lah-h">{session.title}</strong>
          <span class="lah-dim lah-small">{`${session.agentName} · ${aboutWords(session, chats)} · started ${dateTime(session.createdAt)}`}</span>
        </span>
        <Button icon="trash" busy={removing} onClick={drop}>
          Delete
        </Button>
      </div>
      {page.status === "failed" ? (
        <Banner
          tone="neg"
          title="The conversation couldn't be read"
          actions={
            <Button size="sm" icon="refresh" onClick={read}>
              Try again
            </Button>
          }
        >
          {page.message}
        </Banner>
      ) : null}
      {page.next !== null ? (
        <div class="lah-actions">
          <Button size="sm" icon="chevron-up" onClick={earlier}>
            Show earlier turns
          </Button>
        </div>
      ) : null}
      {page.status === "loading" ? <Empty icon="hourglass">Reading the conversation…</Empty> : null}
      {page.status === "ready" && turns.length === 0 ? (
        <Empty icon="message" title="Nothing said yet">
          {`Say something to ${session.agentName} below. It works as it does in a chat: you see each step, can answer a tool call it holds for your word, say more while it works, pause it and stop it.`}
        </Empty>
      ) : null}
      <ol class="lah-talk" aria-label="The conversation">
        {turns.map((turn) => {
          const none = noAnswerWords(turn);
          return (
            <li key={turn.turn} class="lah-talk-turn" data-lah-side-turn={turn.turn} data-state={turn.state}>
              <div class="lah-talk-said">
                <span class="lah-talk-who">{`You · ${ago(app.now(), turn.at)}`}</span>
                <p class="lah-talk-text">{turn.said}</p>
              </div>
              {turn.state === "running" ? (
                <RunPane stream={session.id} transcript={null} />
              ) : (
                <div class="lah-talk-answer">
                  <span class="lah-talk-who">
                    {session.agentName}
                    {turn.state !== "done" ? <Badge tone={turn.state === "stopped" ? "warn" : "neg"}>{END_STATE_WORDS[turn.state]}</Badge> : null}
                  </span>
                  {turn.answer !== null ? <p class="lah-talk-text">{turn.answer}</p> : null}
                  {none !== null ? (
                    <p class="lah-line lah-is-warn">
                      <Icon name="alert" size={14} />
                      <span>{none}</span>
                    </p>
                  ) : null}
                  {turn.usage ? <p class="lah-stats">{spentWords(turn.usage)}</p> : null}
                  {turn.transcript !== null ? (
                    <Disclosure summary={<span class="lah-small">Its work, step by step</span>}>
                      <RunPane stream={null} transcript={turn.transcript} />
                    </Disclosure>
                  ) : (
                    <p class="lah-small lah-dim">No transcript of its work was kept.</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div ref={foot} class="lah-talk-foot" data-working={props.working || undefined}>
        {props.working ? (
          <p class="lah-small lah-muted" role="status">{`${session.agentName} is working on what you said. The bar under its work says something more to it, pauses it or stops it.`}</p>
        ) : (
          <div class="lah-say lah-talk-box" data-lah-talk-box>
            <Editor
              prose
              rows={2}
              label={`Say something to ${session.agentName}`}
              placeholder={`Say something to ${session.agentName}`}
              value={text}
              onInput={setText}
              onKeyDown={(event) => {
                // Enter sends where there is a keyboard to hold Shift on; on a touch keyboard Enter is a new line and the button sends.
                if (event.key !== "Enter" || event.shiftKey || coarse || event.isComposing) return;
                event.preventDefault();
                say();
              }}
            />
            <Button variant="primary" icon="send" busy={sending} disabled={!canSend(text)} onClick={say}>
              Send
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

export function TalkPage() {
  const app = useApp();
  const open = useSelect(app.nav, (n) => n.side);
  const chats = useSelect(app.client.state, (s) => s?.chats ?? NO_CHATS);
  const running = useSelect(app.client.state, (s) => s?.running ?? NONE_RUNNING);
  const [list, setList] = useState<Sessions>({ status: "loading", sessions: [], message: "" });
  const read = (): void => {
    app.client.request("lah.side.list", {}).then(
      (r) => setList({ status: "ready", sessions: r.sessions, message: "" }),
      (e: unknown) => setList((held) => ({ ...held, status: "failed", message: errorWords(e) })),
    );
  };
  useEffect(() => {
    read();
    return app.client.onBack(read);
  }, []);
  const select = (id: string | null): void => app.nav.update((n) => ({ ...n, side: id }));
  const sessions = sessionsInOrder(list.sessions);
  const session = open !== null ? (sessions.find((s) => s.id === open) ?? null) : null;
  // A conversation picked from the list starts at its head: the panel may be scrolled far down the list.
  const detail = useRef<HTMLDivElement>(null);
  const shownId = session?.id ?? null;
  useLayoutEffect(() => {
    if (shownId !== null && detail.current && !atFoot(scrollParent(detail.current) ?? detail.current)) revealInScroller(detail.current, "start");
  }, [shownId]);
  const keep = (changed: SideSession): void => setList((held) => ({ ...held, sessions: [changed, ...held.sessions.filter((s) => s.id !== changed.id)] }));
  return (
    <div class="lah-split" data-pane={session ? "detail" : "list"} data-lah-view="talk">
      <div class="lah-split-list">
        <NewTalk
          onStarted={(started) => {
            keep(started);
            select(started.id);
          }}
        />
        {list.status === "failed" ? (
          <Banner
            tone="neg"
            title="The conversations couldn't be read"
            actions={
              <Button size="sm" icon="refresh" onClick={read}>
                Try again
              </Button>
            }
          >
            {list.message}
          </Banner>
        ) : null}
        {list.status === "ready" && sessions.length === 0 ? <p class="lah-lead lah-small">No conversation yet. Start one above.</p> : null}
        {sessions.length > 0 ? (
          <nav class="lah-navlist" aria-label="Your conversations with agents">
            {sessions.map((s) => (
              <button key={s.id} type="button" class="lah-navrow" data-lah-side={s.id} aria-current={s.id === shownId ? "true" : undefined} onClick={() => select(s.id)}>
                <span class="lah-navrow-text">
                  <span class="lah-navrow-title">{s.title}</span>
                  <span class="lah-navrow-sub">{`${sessionSub(s, chats)} · ${ago(app.now(), s.lastAt)}`}</span>
                </span>
                {running.some((r) => r.stream === s.id) ? <span class="lah-pulse" role="img" aria-label="it is working" /> : null}
                <Icon name="chevron-right" size={16} class="lah-chev" />
              </button>
            ))}
          </nav>
        ) : null}
      </div>
      <div class="lah-split-detail" ref={detail}>
        {session ? (
          <Conversation key={session.id} session={session} working={running.some((r) => r.stream === session.id)} onBack={() => select(null)} onChanged={keep} onRemoved={() => (setList((held) => ({ ...held, sessions: held.sessions.filter((s) => s.id !== session.id) })), select(null))} />
        ) : (
          <Empty icon="message" title={open !== null && list.status === "ready" ? "That conversation is gone" : "Pick a conversation, or start one"}>
            {open !== null && list.status === "ready" ? "It may have been deleted on another page." : "Each is a conversation with one agent, kept apart from your chats. The agent's work shows as you talk: what it was told, what it thought and said, each tool call and its result."}
          </Empty>
        )}
      </div>
    </div>
  );
}
