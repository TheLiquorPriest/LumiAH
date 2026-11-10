// Live (DESIGN §8): the session view. The chat's turn as its agents work it, opened when the page
// shows and kept current by the backend's pushes (`live-follow.ts` keeps them in order and mends
// gaps); the turn's transcript is `transcript.tsx`. A turn LumiAH answers in another chat is said
// across the top, with the way to it.

import { useEffect, useRef, useState } from "preact/hooks";
import { chatAnswered } from "../../../shared/ui";
import { useApp } from "../app";
import { ChatBar, chatLabel, useChatView, useShownChat } from "../chat";
import { Banner, Button, Empty, IconButton } from "../components";
import { LiveFollower, type LiveState } from "../live-follow";
import { useSelect } from "../store";
import { TurnFeed } from "../transcript";

/** A chat's live view, followed while the page shows it. */
function useLive(chatId: string | null): { state: LiveState; again(): void } {
  const app = useApp();
  const [state, setState] = useState<LiveState>({ status: "opening" });
  const follower = useRef<LiveFollower | null>(null);
  useEffect(() => {
    if (chatId === null) return;
    setState({ status: "opening" });
    const f = new LiveFollower({ open: () => app.client.request("lah.live.open", { chatId }), events: (turn, from) => app.client.request("lah.live.events", { chatId, turn, from }) }, setState);
    follower.current = f;
    const offLive = app.client.onLive((id, change) => {
      if (id === chatId) f.hear(change);
    });
    const offBack = app.client.onBack(() => void f.refresh());
    void f.start();
    return () => {
      offLive();
      offBack();
      f.stop();
      follower.current = null;
      app.client.request("lah.live.close", { chatId }).catch(() => {
        // The page is leaving the view either way; the backend forgets a page that went away.
      });
    };
  }, [chatId]);
  return { state, again: () => void follower.current?.refresh() };
}

export function LivePage() {
  const app = useApp();
  const chatId = useShownChat();
  const chat = useChatView(chatId);
  const { state, again } = useLive(chatId);
  const elsewhere = useSelect(app.client.state, (s) => s?.running.find((r) => r.chatId !== chatId) ?? null);
  const other = useChatView(elsewhere?.chatId ?? null);
  const go = (page: "sessions" | "runtime"): void => app.nav.update((n) => ({ ...n, page }));
  const view = state.status === "ready" ? state.view : null;
  return (
    <div class="lah-stack" data-lah-view="live" style={{ flex: 1 }}>
      <ChatBar aside={chatId !== null ? <IconButton icon="refresh" label="Read the live view again" onClick={again} /> : null} />
      {elsewhere ? (
        <Banner
          tone="info"
          title={`LumiAH is answering ${chatLabel(other ?? { chatId: elsewhere.chatId, name: null })} now`}
          actions={
            <Button size="sm" variant="primary" onClick={() => app.nav.update((n) => ({ ...n, chatId: elsewhere.chatId }))}>
              Show that turn
            </Button>
          }
        />
      ) : null}
      {chatId === null ? (
        <Empty icon="message" title="No chat is open">
          Live shows the chat open in Lumiverse. Open one, or pick a chat LumiAH answers from the list above.
        </Empty>
      ) : state.status === "opening" ? (
        <Empty icon="hourglass">Opening the live view…</Empty>
      ) : state.status === "failed" ? (
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
      ) : view === null ? (
        chat !== null && !chatAnswered(chat) ? (
          <Empty
            icon="link"
            title="LumiAH doesn't answer this chat"
            action={
              <Button icon="link" onClick={() => go("runtime")}>
                Open Runtime
              </Button>
            }
          >
            {chat.connection ? `It generates on ${chat.connection.name}, which isn't the loopback connection.` : "It has no connection LumiAH can see."} LumiAH answers a chat whose connection is the loopback: switch it on for this chat under Runtime → Chats.
          </Empty>
        ) : (
          <Empty
            icon="pulse"
            title="No turn yet"
            action={
              <Button icon="layers" onClick={() => go("sessions")}>
                Open Sessions
              </Button>
            }
          >
            Live shows a turn as its agents work it: what each was told, each answer with its thinking, each tool call with its arguments and result, each stop, and what it all cost. Nothing has run in this chat since the extension started. Earlier turns are in Sessions.
          </Empty>
        )
      ) : (
        <TurnFeed
          view={view}
          live
          partial={state.status === "ready" && state.partial}
          onRetry={again}
          onStop={() =>
            app.client.request("lah.turn.stop", { chatId, turn: view.turn }).then(
              (r) => app.toast(r.stopped ? "Stopping the turn…" : "The turn had already ended."),
              (e: unknown) => app.fail(e),
            )
          }
        />
      )}
    </div>
  );
}
