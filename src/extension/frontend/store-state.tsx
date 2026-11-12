// Runtime → System, for one linked runtime: its working store as it says it stands
// (`lah.runtime.store`), the lines worded in store-model.ts. Read when the runtime is shown, and again
// at the user's word.

import { useEffect, useState } from "preact/hooks";
import type { StoreStateView } from "../../shared/ui";
import { errorWords, useApp } from "./app";
import { Button } from "./components";
import { storeLead, storeLines } from "./store-model";

const TONE_CLASS: Readonly<Record<"neutral" | "warn" | "neg", string | undefined>> = { neutral: undefined, warn: "lah-warn", neg: "lah-neg" };

export function StoreState(props: { relay: string; now: number; name: string }) {
  const app = useApp();
  const [read, setRead] = useState<{ state: StoreStateView | null; failed: string | null; asked: number }>({ state: null, failed: null, asked: 0 });
  useEffect(() => {
    let live = true;
    app.client.request("lah.runtime.store", { relay: props.relay }).then(
      (answer) => live && setRead((held) => ({ ...held, state: answer.state, failed: null })),
      (error: unknown) => live && setRead((held) => ({ ...held, failed: errorWords(error) })),
    );
    return () => {
      live = false;
    };
  }, [props.relay, read.asked]);
  return (
    <div class="lah-relay-store" data-lah-store={props.relay}>
      <p class="lah-small lah-lead">{storeLead(read.state, props.name)}</p>
      {read.failed !== null ? <p class="lah-small lah-warn">{read.failed}</p> : null}
      {read.state === null ? (
        read.failed === null ? <p class="lah-small">Asking it…</p> : null
      ) : (
        <ul class="lah-facts">
          {storeLines(read.state, props.now, props.name).map((line) => (
            <li key={line.text}>
              <span class={TONE_CLASS[line.tone]}>{line.text}</span>
            </li>
          ))}
        </ul>
      )}
      <div class="lah-actions">
        <Button size="sm" icon="refresh" onClick={() => setRead((held) => ({ ...held, asked: held.asked + 1 }))}>
          Look again
        </Button>
      </div>
    </div>
  );
}
