// Live (DESIGN §8): the session view. The chat's turn as its agents work it, opened when the page
// shows and kept current by the backend's pushes (`live-follow.ts` keeps them in order and mends
// gaps); the turn's transcript is `transcript.tsx`, and what the user can do to it while it runs
// (answer a held tool call, say something, pause) is `runs.tsx`. A reply LumiAH works on in another
// chat is said across the top, with the way to it; so is a chat whose runtime isn't answering, with
// the one press that runs it built in (none for a chat its extension plays only in the runtime).

import { chatAnswered, isReply } from "../../../shared/ui";
import { useApp } from "../app";
import { ChatBar, chatLabel, useChatView, useShownChat } from "../chat";
import { Banner, Button, Empty, IconButton, useBusy } from "../components";
import { LiveTurn, useLive } from "../runs";
import { useSelect } from "../store";

export function LivePage() {
  const app = useApp();
  const chatId = useShownChat();
  const chat = useChatView(chatId);
  // A chat's replies are followed under the chat's own id.
  const { state, again } = useLive(chatId);
  const elsewhere = useSelect(app.client.state, (s) => s?.running.find((r) => isReply(r.kind) && r.chatId !== null && r.chatId !== chatId)?.chatId ?? null);
  const other = useChatView(elsewhere);
  const go = (page: "sessions" | "home"): void => app.nav.update((n) => ({ ...n, page }));
  const view = state.status === "ready" ? state.view : null;
  const [fixing, fix] = useBusy();
  const runBuiltIn = (): void =>
    fix(async () => {
      if (chat === null) return;
      try {
        await app.client.request("lah.chat.set", { chatId: chat.chatId, on: true, place: "builtin" });
        app.toast(`${chatLabel(chat)} runs built in from its next reply.`);
      } catch (error) {
        app.fail(error);
      }
    });
  return (
    <div class="lah-stack" data-lah-view="live" style={{ flex: 1 }}>
      <ChatBar aside={chatId !== null ? <IconButton icon="refresh" label="Read the live view again" onClick={again} /> : null} />
      {elsewhere ? (
        <Banner
          tone="info"
          title={`LumiAH is answering ${chatLabel(other ?? { chatId: elsewhere, name: null })} now`}
          actions={
            <Button size="sm" variant="primary" onClick={() => app.nav.update((n) => ({ ...n, chatId: elsewhere }))}>
              Show that turn
            </Button>
          }
        />
      ) : null}
      {chat !== null && chat.away === true ? (
        <div data-lah-away>
          <Banner
            tone="warn"
            title="Your runtime isn't answering"
            actions={
              chat.needsRuntime === undefined ? (
                <Button size="sm" variant="primary" busy={fixing} onClick={runBuiltIn}>
                  Run it built in
                </Button>
              ) : (
                <Button size="sm" variant="primary" icon="link" onClick={() => app.nav.update((n) => ({ ...n, page: "runtime" }))}>
                  Start the runtime
                </Button>
              )
            }
          >
            {chat.needsRuntime === undefined ? "This chat is set to run in it, so replies here may fail until it is back." : `${chat.needsRuntime.by} plays this chat only in your runtime, so it can't play until the runtime is back. Its line is on the Runtime page.`}
          </Banner>
        </div>
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
            icon="power"
            title="LumiAH isn't used in this chat"
            action={
              <Button icon="home" onClick={() => go("home")}>
                Switch it on, on Home
              </Button>
            }
          >
            Live shows LumiAH's agents at work on a reply. It isn't switched on for this chat, so there is nothing of it to show: its switch is on Home.
          </Empty>
        ) : (
          <Empty
            icon="pulse"
            title="No reply yet"
            action={
              <Button icon="layers" onClick={() => go("sessions")}>
                Open Past replies
              </Button>
            }
          >
            Live shows a reply being prepared: what each agent was told, each answer with its thinking, each tool call with its arguments and result, each stop, and what it all cost. Nothing has run in this chat since the extension started. Earlier ones are in Past replies.
          </Empty>
        )
      ) : (
        <LiveTurn stream={chatId} view={view} partial={state.status === "ready" && state.partial} onRetry={again} />
      )}
    </div>
  );
}
