// Runtime → Chat data, for one linked runtime: its copy of chat and lore as it says it stands
// (`lah.runtime.chatdata`), the lines worded in chat-data-model.ts, and the database reader's switch,
// shown to this Lumiverse's operator alone (`lah.runtime.database`). Read when the runtime is shown, and
// again at the user's word. One column of lists, which wrap at any width.

import { useEffect, useState } from "preact/hooks";
import type { ChatDataView, DatabaseSwitchView } from "../../shared/ui";
import { errorWords, useApp } from "./app";
import { type ChatDataLine, chatDataLines, fallbackLines, keptLines, readerLines, readLines, switchWords } from "./chat-data-model";
import { Button, Disclosure, Switch, useBusy } from "./components";
import { counted } from "./format";

const TONE_CLASS: Readonly<Record<ChatDataLine["tone"], string | undefined>> = { neutral: undefined, warn: "lah-warn", neg: "lah-neg" };

function Lines(props: { lines: readonly ChatDataLine[] }) {
  return (
    <ul class="lah-facts">
      {props.lines.map((line) => (
        <li key={line.text}>
          <span class={TONE_CLASS[line.tone]}>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function ChatData(props: { relay: string; now: number; name: string }) {
  const app = useApp();
  const [read, setRead] = useState<{ state: ChatDataView | null; database: DatabaseSwitchView | null; failed: string | null; asked: number }>({ state: null, database: null, failed: null, asked: 0 });
  const [busy, run] = useBusy();
  useEffect(() => {
    let live = true;
    app.client.request("lah.runtime.chatdata", { relay: props.relay }).then(
      (answer) => live && setRead((held) => ({ ...held, state: answer.state, database: answer.database, failed: null })),
      (error: unknown) => live && setRead((held) => ({ ...held, failed: errorWords(error) })),
    );
    return () => {
      live = false;
    };
  }, [props.relay, read.asked]);
  const { state, database } = read;
  const offered = database !== null ? switchWords(database) : null;
  const flip = (on: boolean): void =>
    run(async () => {
      try {
        const answer = await app.client.request("lah.runtime.database", { on });
        // The runtime is told at once; its own state is asked again so the page shows what it reads from now.
        setRead((held) => ({ ...held, database: answer.database, asked: held.asked + 1 }));
      } catch (error) {
        app.fail(error);
      }
    });
  const kept = state === null ? [] : [...state.chats.map((k) => keptLines(k, "chat", props.now)), ...state.books.map((k) => keptLines(k, "book", props.now))];
  return (
    <div class="lah-relay-chatdata lah-stack" data-lah-chatdata={props.relay}>
      <p class="lah-small lah-lead">Chat data: how its agents read your chats and world books.</p>
      {read.failed !== null ? <p class="lah-small lah-warn">{read.failed}</p> : null}
      {state === null ? (
        read.failed === null ? <p class="lah-small">Asking it…</p> : null
      ) : (
        <>
          <Lines lines={chatDataLines(state, props.now, props.name)} />
          {state.reader !== null ? (
            <Disclosure summary="The database reader">
              <Lines lines={readerLines(state.reader, props.now)} />
            </Disclosure>
          ) : null}
          {kept.length > 0 ? (
            <Disclosure summary={`What the copy holds: ${counted(state.chats.length, "chat")}, ${counted(state.books.length, "world book")}`}>
              {kept.map((k) => (
                <div key={k.title} data-lah-kept={k.title}>
                  <p class="lah-small">{k.title}</p>
                  <Lines lines={k.lines} />
                </div>
              ))}
            </Disclosure>
          ) : null}
          {state.reads.length > 0 ? (
            <Disclosure summary="The latest reads whole">
              <Lines lines={readLines(state, props.now)} />
            </Disclosure>
          ) : null}
          {state.fallbacks.latest.length > 0 ? (
            <Disclosure summary={`The latest reads sent to ${props.name}`}>
              <Lines lines={fallbackLines(state, props.now)} />
            </Disclosure>
          ) : null}
        </>
      )}
      {offered !== null && database !== null ? <Switch checked={database.on} label={offered.label} help={offered.help} disabled={busy || (!database.on && database.path === null)} onChange={flip} /> : null}
      <div class="lah-actions">
        <Button size="sm" icon="refresh" onClick={() => setRead((held) => ({ ...held, asked: held.asked + 1 }))}>
          Read again
        </Button>
      </div>
    </div>
  );
}
