// Which chat Live and Sessions show, and the bar that picks it: the chat open in Lumiverse unless
// another is chosen from those LumiAH answers.

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { type ChatView, isReply, type RunningTurn } from "../../shared/ui";
import { useApp } from "./app";
import { Select } from "./components";
import { useSelect } from "./store";

const NO_CHATS: readonly ChatView[] = [];
const NONE_RUNNING: readonly RunningTurn[] = [];

/** The chat Live and Sessions show: the one picked, else the one open in Lumiverse; null when neither. */
export function useShownChat(): string | null {
  const app = useApp();
  const picked = useSelect(app.nav, (n) => n.chatId);
  const active = useSelect(app.host.activeChat, (c) => c);
  return picked ?? active;
}

/** A chat as the backend has it: from the state where it is listed, else asked for; null until known. */
export function useChatView(chatId: string | null): ChatView | null {
  const app = useApp();
  const listed = useSelect(app.client.state, (s) => (chatId === null ? null : (s?.chats.find((c) => c.chatId === chatId) ?? null)));
  const [asked, setAsked] = useState<ChatView | null>(null);
  const known = listed !== null;
  useEffect(() => {
    if (chatId === null || known) return;
    let live = true;
    const ask = (): void => {
      app.client.request("lah.chat.get", { chatId }).then(
        (r) => live && setAsked(r.chat),
        () => {
          // The page says what it doesn't know of the chat; nothing here to report.
        },
      );
    };
    ask();
    const off = app.client.onBack(ask);
    return () => {
      live = false;
      off();
    };
  }, [chatId, known]);
  return listed ?? (asked !== null && asked.chatId === chatId ? asked : null);
}

/** A chat's name where it has one, else its id's first characters, enough to tell two apart. */
export function chatLabel(chat: { chatId: string; name: string | null }): string {
  return chat.name !== null && chat.name !== "" ? chat.name : `Chat ${chat.chatId.slice(0, 8)}`;
}

/** The bar that says which chat is shown and picks another: the open chat first, then each chat LumiAH answers, a running one marked. */
export function ChatBar(props: { aside?: ComponentChildren }) {
  const app = useApp();
  const picked = useSelect(app.nav, (n) => n.chatId);
  const active = useSelect(app.host.activeChat, (c) => c);
  const chats = useSelect(app.client.state, (s) => s?.chats ?? NO_CHATS);
  const running = useSelect(app.client.state, (s) => s?.running ?? NONE_RUNNING);
  const open = useChatView(active);
  const name = (id: string): string => chatLabel(chats.find((c) => c.chatId === id) ?? (open !== null && open.chatId === id ? open : { chatId: id, name: null }));
  const busy = (id: string): string => (running.some((r) => isReply(r.kind) && r.chatId === id) ? " · answering now" : "");
  const others = [...new Set([...chats.map((c) => c.chatId), ...running.flatMap((r) => (isReply(r.kind) && r.chatId !== null ? [r.chatId] : [])), ...(picked !== null ? [picked] : [])])].filter((id) => id !== active);
  const options = [{ value: "", label: active !== null ? `Open chat: ${name(active)}${busy(active)}` : "The open chat (none is open)" }, ...others.map((id) => ({ value: id, label: `${name(id)}${busy(id)}` }))];
  return (
    <div class="lah-chatbar" data-lah-chatbar>
      <Select label="The chat shown" value={picked ?? ""} options={options} onChange={(id) => app.nav.update((n) => ({ ...n, chatId: id === "" ? null : id }))} />
      {props.aside}
    </div>
  );
}
