// What the pages that show a run share (Live, Talk, Jobs, Sessions): a live view followed by its
// stream, a stored transcript read to its end, a stored text; the cards of the tool calls a run
// asks the user's permission for (DESIGN §17; what each says is approval-model.ts); what the user
// can do to a turn that runs (say something to its main agent, hold it and let it go on: §18); and
// the pane that shows a run either way.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { type ApprovalView, isReply, type LiveView, type StreamId } from "../../shared/ui";
import { errorWords, useApp } from "./app";
import { type ArgRow, ASK_MARKS, askOf, fileAsk, forChatWords, needsFile, type Piece, type Standing, waitWords } from "./approval-model";
import { UiRequestError } from "./client";
import { Badge, Button, Disclosure, Editor, Empty, useBusy, useTick } from "./components";
import { Icon } from "./icons";
import { LiveFollower, type LiveState } from "./live-follow";
import { TIER_WORDS } from "./live-model";
import { DiffView } from "./pages/workspace-parts";
import { useSelect } from "./store";
import { TurnFeed } from "./transcript";

/** A stream's live view, followed while the page shows it. */
export function useLive(stream: StreamId | null): { state: LiveState; again(): void } {
  const app = useApp();
  const [state, setState] = useState<LiveState>({ status: "opening" });
  const follower = useRef<LiveFollower | null>(null);
  useEffect(() => {
    if (stream === null) return;
    setState({ status: "opening" });
    const f = new LiveFollower({ open: () => app.client.request("lah.live.open", { stream }), events: (turn, from) => app.client.request("lah.live.events", { stream, turn, from }) }, setState);
    follower.current = f;
    const offLive = app.client.onLive((id, change) => {
      if (id === stream) f.hear(change);
    });
    const offBack = app.client.onBack(() => void f.refresh());
    void f.start();
    return () => {
      offLive();
      offBack();
      f.stop();
      follower.current = null;
      app.client.request("lah.live.close", { stream }).catch(() => {
        // The page is leaving the view either way; the backend forgets a page that went away.
      });
    };
  }, [stream]);
  return { state, again: () => void follower.current?.refresh() };
}

export type Transcript = { status: "loading" } | { status: "failed"; message: string } | { status: "ready"; view: LiveView; partial: boolean };

/** A stored transcript, read a page at a time until it is whole. */
export function useTranscript(hash: string | null): { state: Transcript | null; again(): void } {
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
          const page: { view: LiveView; next: number | null } = await app.client.request("lah.transcript.get", { transcript: hash, from });
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
  }, [hash, tries]);
  return { state, again: () => setTries((n) => n + 1) };
}

/** A stored text (a compaction's summary, a job's report, an earlier version of a file), read when it shows. */
export function useBlob(hash: string | null): { text: string | null; failed: string | null } {
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

const NO_HELD: readonly ApprovalView[] = [];

const READING: Standing = { status: "reading" };

/**
 * The file a held write or edit would change, as it stands now: read once when the card shows, so
 * the change can be set against it. A file that isn't there is no failure: the call would make it.
 */
function useStanding(call: ApprovalView): Standing {
  const app = useApp();
  const file = fileAsk(call);
  const place = needsFile(file) ? file.place : null;
  const area = place?.area ?? null;
  const path = place?.path ?? null;
  const [state, setState] = useState(READING);
  useEffect(() => {
    setState(READING);
    if (area === null || path === null) return;
    // An answer that comes after the card went to another call belongs to no call shown.
    let live = true;
    app.client.request("lah.ws.read", { chatId: call.chatId !== "" ? call.chatId : null, area, path }).then(
      (r) => live && setState({ status: "ready", text: r.text }),
      (error: unknown) => live && setState(error instanceof UiRequestError && error.code === "not_found" ? { status: "none" } : { status: "failed", message: errorWords(error) }),
    );
    return () => {
      live = false;
    };
  }, [call.id, call.chatId, area, path]);
  return state;
}

/** A sentence in pieces: a file's path, a tool's name and a job's id show as code. */
function Pieces(props: { pieces: readonly Piece[] }) {
  return (
    <>
      {props.pieces.map((piece) =>
        piece.code ? (
          <code key={piece.text} class="lah-mono">
            {piece.text}
          </code>
        ) : (
          piece.text
        ),
      )}
    </>
  );
}

/** A call's arguments, each by its name; a long value shows its opening until it is asked for whole. */
function ArgList(props: { rows: readonly ArgRow[] }) {
  const [whole, setWhole] = useState<ReadonlySet<string>>(new Set());
  return (
    <dl class="lah-ask-args" data-lah-ask-args>
      {props.rows.map((row) => {
        const open = row.short === null || whole.has(row.name);
        return (
          <div key={row.name} class="lah-ask-arg" data-lah-ask-arg={row.name}>
            <dt class="lah-mono lah-muted">{row.name}</dt>
            <dd class="lah-ask-value">
              <span>{open ? row.value : row.short}</span>
              {row.short !== null ? (
                <Button size="sm" variant="ghost" expanded={open} label={open ? `Show less of ${row.name}` : `Show all of ${row.name}`} onClick={() => setWhole((held) => new Set(open ? [...held].filter((name) => name !== row.name) : [...held, row.name]))}>
                  {open ? "Show less" : "Show all"}
                </Button>
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * A tool call that asks the user's permission: who wants to do what to what, the change to a file
 * as the Workspace's diff or the arguments as a list, the call itself folded, how long the wait
 * still is, and the three answers. Refusing asks for a reason first, since the agent is told it and
 * works from it; the reason may be left empty.
 */
function HeldCall(props: { call: ApprovalView }) {
  const app = useApp();
  const call = props.call;
  const now = useTick(1000);
  const [busy, run] = useBusy();
  const [refusing, setRefusing] = useState(false);
  const [reason, setReason] = useState("");
  const standing = useStanding(call);
  const ask = askOf(call, standing);
  const left = call.until === null ? null : Math.max(0, call.until - now);
  const answer = (decision: "once" | "chat" | "refused"): void =>
    run(async () => {
      try {
        const r = await app.client.request("lah.approval.answer", { id: call.id, answer: decision === "refused" ? { decision, ...(reason.trim() !== "" ? { reason: reason.trim() } : {}) } : { decision } });
        if (!r.answered) app.toast("That call was no longer waiting: it was answered elsewhere, or its wait ran out.");
      } catch (error) {
        app.fail(error);
      }
    });
  return (
    <div class="lah-heldcall" data-lah-held={call.id} data-lah-ask={ask.change !== null ? "change" : ask.args.length > 0 ? "args" : "words"} role="group" aria-label={ask.sentence}>
      <div class="lah-heldcall-head">
        <Icon name="shield" size={18} />
        <span class="lah-heldcall-what" data-lah-ask-words>
          <Pieces pieces={ask.pieces} />
        </span>
        <Badge tone={call.tier === "read" ? "neutral" : "warn"}>{TIER_WORDS[call.tier]}</Badge>
      </div>
      {/* While the reason is written the change steps aside: on a phone the box and its two buttons must stay in reach above the keyboard. */}
      {refusing ? null : (
        <>
          {ask.note !== null ? (
            <p class="lah-small lah-muted" data-lah-ask-note>
              {ask.note}
            </p>
          ) : null}
          {ask.change !== null ? (
            <div class="lah-ask-box" data-lah-ask-change>
              <DiffView before={ask.change.before} after={ask.change.after} marks={ASK_MARKS} label="What the call would change" />
            </div>
          ) : null}
          {ask.args.length > 0 ? (
            <div class="lah-ask-box">
              <ArgList rows={ask.args} />
            </div>
          ) : null}
          <Disclosure summary={<span class="lah-small">Details</span>}>
            <p class="lah-small lah-muted">
              The call as the agent made it, of the tool <code class="lah-mono">{call.tool}</code>:
            </p>
            <pre class="lah-text lah-heldcall-args" data-lah-ask-json>
              {ask.json}
            </pre>
          </Disclosure>
          <p class="lah-small lah-muted" role="timer" aria-live="off">
            {waitWords(left)}
          </p>
        </>
      )}
      {refusing ? (
        <div class="lah-stack">
          <Editor prose rows={2} label="Why you refuse: the agent is told" placeholder="Why not (the agent is told this)" value={reason} onInput={setReason} />
          <div class="lah-actions">
            <Button variant="danger" icon="close" busy={busy} onClick={() => answer("refused")}>
              Refuse
            </Button>
            <Button variant="ghost" onClick={() => setRefusing(false)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div class="lah-actions">
            <Button variant="primary" icon="check" busy={busy} onClick={() => answer("once")}>
              Approve once
            </Button>
            {call.chatId !== "" ? (
              <Button icon="check" busy={busy} onClick={() => answer("chat")}>
                Approve for this chat
              </Button>
            ) : null}
            <Button icon="close" onClick={() => setRefusing(true)}>
              Refuse…
            </Button>
          </div>
          {call.chatId !== "" ? (
            <p class="lah-small lah-muted" data-lah-ask-chat>
              <Pieces pieces={forChatWords(call.tool)} />
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The tool calls a stream's turn asks the user's permission for, each a card. */
export function HeldCalls(props: { stream: StreamId }) {
  const app = useApp();
  const held = useSelect(app.client.state, (s) => s?.approvals ?? NO_HELD);
  const mine = held.filter((a) => a.stream === props.stream);
  if (mine.length === 0) return null;
  return (
    <div class="lah-held" data-lah-held-calls>
      {mine.map((a) => (
        <HeldCall key={a.id} call={a} />
      ))}
    </div>
  );
}

/**
 * What the user can do to a turn that runs besides ending it (DESIGN §18): say something to its
 * main agent (it receives the note at its next round, marked as the user's), and hold every agent
 * of it at its next round or let them go on. The two buttons stand in the pinned bar at the top;
 * the box to write in opens under the bar. Enter sends the note where there is a keyboard to hold
 * Shift on; on a touch keyboard Enter is a new line and the button sends.
 */
function useTurnTalk(stream: StreamId, turn: string): { controls: ComponentChildren; box: ComponentChildren } {
  const app = useApp();
  const paused = useSelect(app.client.state, (s) => s?.running.find((r) => r.stream === stream && r.turn === turn)?.paused ?? false);
  const coarse = useSelect(app.host.coarse, (c) => c);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saying, say] = useBusy();
  const [holding, hold] = useBusy();
  const send = (): void => {
    const note = text.trim();
    if (note === "") return;
    say(async () => {
      try {
        const r = await app.client.request("lah.turn.say", { stream, turn, text: note });
        if (r.said) {
          setText("");
          setOpen(false);
        }
        app.toast(r.said ? "Sent: the main agent reads it at its next round." : "The turn had already ended.");
      } catch (error) {
        app.fail(error);
      }
    });
  };
  // No notice says the turn is paused or goes on: the bar's own state line does, and a notice would cover that bar on a phone for as long as it stays.
  const toggle = (): void =>
    hold(async () => {
      try {
        await app.client.request("lah.turn.pause", { stream, turn, on: !paused });
      } catch (error) {
        app.fail(error);
      }
    });
  // On a narrow panel the two say what they are by their sign and their name read out, so the bar keeps room for the turn's state.
  const controls = (
    <>
      <Button size="sm" icon="message" label="Say something to the main agent" expanded={open} onClick={() => setOpen((shown) => !shown)}>
        <span class="lah-pinned-word">Say</span>
      </Button>
      <Button size="sm" icon={paused ? "play" : "pause"} label={paused ? "Let the turn go on" : "Pause the turn"} pressed={paused} busy={holding} onClick={toggle}>
        <span class="lah-pinned-word">{paused ? "Resume" : "Pause"}</span>
      </Button>
    </>
  );
  const box = (
    <>
      {paused ? (
        <p class="lah-say-state" role="status" data-lah-paused>
          <Icon name="pause" size={14} />
          <span>Paused: its agents wait before their next round. What they had started finishes first.</span>
        </p>
      ) : null}
      {open ? (
        <div class="lah-say" data-lah-say>
          <Editor
            prose
            rows={2}
            label="Say something to the main agent"
            placeholder="Say something to the agent: it reads this at its next round"
            value={text}
            onInput={setText}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || coarse || event.isComposing) return;
              event.preventDefault();
              send();
            }}
          />
          <Button variant="primary" icon="send" busy={saying} disabled={text.trim() === ""} onClick={send}>
            Send
          </Button>
        </div>
      ) : null}
    </>
  );
  return { controls, box };
}

/** A stream's live turn with everything the user can do to it while it runs. */
export function LiveTurn(props: { stream: StreamId; view: LiveView; partial: boolean; onRetry(): void }) {
  const app = useApp();
  const { stream, view } = props;
  const talk = useTurnTalk(stream, view.turn);
  return (
    <TurnFeed
      view={view}
      live
      partial={props.partial}
      onRetry={props.onRetry}
      onStop={() =>
        app.client.request("lah.turn.stop", { stream, turn: view.turn }).then(
          (r) => app.toast(r.stopped ? "Stopping the turn…" : "The turn had already ended."),
          (e: unknown) => app.fail(e),
        )
      }
      controls={talk.controls}
      below={talk.box}
      dock={<HeldCalls stream={stream} />}
    />
  );
}

/** A stored run. */
function StoredRun(props: { transcript: string }) {
  const { state, again } = useTranscript(props.transcript);
  if (state === null || state.status === "loading") return <Empty icon="hourglass">Reading the transcript…</Empty>;
  if (state.status === "failed")
    return (
      <Empty
        icon="alert"
        title="The transcript couldn't be read"
        action={
          <Button icon="refresh" onClick={again}>
            Try again
          </Button>
        }
      >
        {state.message}
      </Empty>
    );
  return <TurnFeed view={state.view} live={false} partial={state.partial} onRetry={again} />;
}

/** A run as its stream has it now. */
function LiveRun(props: { stream: StreamId; none?: ComponentChildren }) {
  const { state, again } = useLive(props.stream);
  if (state.status === "opening") return <Empty icon="hourglass">Opening the live view…</Empty>;
  if (state.status === "failed")
    return (
      <Empty
        icon="alert"
        title="The live view didn't open"
        action={
          <Button icon="refresh" onClick={again}>
            Try again
          </Button>
        }
      >
        {state.message}
      </Empty>
    );
  if (state.view === null) return <>{props.none ?? <Empty icon="pulse">Nothing of this run is held now: it hasn't started, or the extension started again since it ran.</Empty>}</>;
  return <LiveTurn stream={props.stream} view={state.view} partial={state.partial} onRetry={again} />;
}

/**
 * A run that is no reply in a chat (a job's, a side session's turn): its stored transcript where it
 * has one, else its stream's turn as it is worked; `none` where there is neither.
 */
export function RunPane(props: { stream: StreamId | null; transcript: string | null; none?: ComponentChildren }) {
  if (props.transcript !== null) return <StoredRun transcript={props.transcript} />;
  if (props.stream !== null) return <LiveRun stream={props.stream} none={props.none} />;
  return <>{props.none ?? null}</>;
}
