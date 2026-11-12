// How one runtime is run and kept, on the Runtime page (one per runtime, in its row): its update
// (taken by itself once nothing is under way; the Update now button takes it at once and says what
// that ended), whether it updates by itself, its memory limit and what holds it there, and its
// restart where a new limit needs one. A runtime that can't take the extension's offer keeps its
// update line, with the reason. Read from the runtime itself while it is linked; read again when
// its build or its link changes, so a runtime back on a new build shows it without a reload.

import { useEffect, useState } from "preact/hooks";
import type { RelayView, ServiceView } from "../../shared/ui";
import { errorWords, useApp } from "./app";
import { Banner, Button, CopyLine, Field, Switch, TextInput, useBusy } from "./components";
import { copyWords, cutWords, memoryWords, updateStanding } from "./runtime-service-model";
import { useSelect } from "./store";

export function RuntimeService(props: { relay: RelayView }) {
  const app = useApp();
  const runtime = useSelect(app.client.state, (s) => s?.runtime ?? null);
  const r = props.relay;
  const [service, setService] = useState<ServiceView | null>(null);
  /** Why the runtime gave no answer when asked how it is kept; null while nothing failed. */
  const [unread, setUnread] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const linked = r.link === "linked";
  // The extension as its pages name it: LumiAH, or the extension LumiAH is built into.
  const name = runtime?.switchedBy ?? "LumiAH";
  useEffect(() => {
    setUnread(null);
    if (!linked) {
      setService(null);
      return;
    }
    let live = true;
    app.client.request("lah.runtime.service.get", { relay: r.id }).then(
      (result) => live && setService(result.service),
      (error: unknown) => {
        if (!live) return;
        setService(null);
        setUnread(errorWords(error));
      },
    );
    return () => {
      live = false;
    };
  }, [r.id, r.build, linked]);

  const standing = updateStanding(r, service, { build: runtime?.build ?? "", selfUpdate: runtime?.selfUpdate ?? false, name }, unread);
  const change = (body: { memory?: string; autoUpdate?: boolean; restart?: boolean }): void =>
    run(async () => {
      try {
        const result = await app.client.request("lah.runtime.service.set", { relay: r.id, ...body });
        setService(result.service);
        if (result.restart === "restarting") setSaid("The runtime restarts now for its new limit.");
        else if (result.restart === "needed") setSaid("The new limit holds once the runtime restarts.");
      } catch (error) {
        app.fail(error);
      }
    });
  const updateNow = (): void =>
    run(async () => {
      if (standing.at !== "waiting") return;
      if (standing.ends !== null) {
        const agreed = await app.host.confirm({ title: `Update ${r.name} now?`, message: `It restarts at once, which ends ${standing.ends}.`, confirm: "Update now", danger: true });
        if (!agreed) return;
      }
      try {
        const result = await app.client.request("lah.runtime.update.apply", { relay: r.id });
        setService(result.service);
        setSaid(cutWords(result.cut, standing.build));
      } catch (error) {
        app.fail(error);
      }
    });

  return (
    <div class="lah-stack" data-lah-service={r.name} data-update={standing.at}>
      {said !== null ? <Banner tone="info">{said}</Banner> : null}
      {standing.at === "updating" ? <Banner tone="info">It is updating and restarting: it is back in a moment, on its new build.</Banner> : null}
      {standing.at === "waiting" ? (
        <Banner
          tone="warn"
          title={`Build ${standing.build} waits`}
          actions={
            <Button size="sm" variant="primary" icon="refresh" busy={busy} onClick={updateNow}>
              Update now
            </Button>
          }
        >
          {standing.why}
        </Banner>
      ) : null}
      {standing.at === "asking" ? <p class="lah-lead lah-small">Asking it how its update stands…</p> : null}
      {standing.at === "line" ? (
        <>
          <p class="lah-lead lah-small">{standing.why}</p>
          {service?.line ? <CopyLine id={`service-line-${r.name}`} label="Do it yourself" text={service.line} /> : null}
          {r.lines.update !== null ? <CopyLine id={`update-${r.name}`} label="Update and restart it" text={r.lines.update} help="Run this on the machine it runs on." /> : null}
        </>
      ) : null}
      {service !== null ? (
        <>
          {copyWords(service, app.now()).map((words) => (
            <Banner key={words} tone="warn">
              {words}
            </Banner>
          ))}
          <Switch checked={service.autoUpdate} disabled={busy} label="Updates by itself" help={`Takes ${name}'s new build once no reply or job is under way. Off: only from the Update now button.`} onChange={(on) => change({ autoUpdate: on })} />
          <Field label="Memory limit" for={`memory-${r.name}`} help={memoryWords(service)}>
            <TextInput id={`memory-${r.name}`} value={service.memory} maxLength={32} mono disabled={busy} onCommit={(memory) => memory.trim() !== service.memory && change({ memory: memory.trim() })} />
          </Field>
          {service.restartNeeded ? (
            <Banner
              tone="warn"
              actions={
                <Button size="sm" icon="refresh" busy={busy} onClick={() => change({ restart: true })}>
                  Restart it
                </Button>
              }
            >
              {`The limit ${service.memory} holds once it restarts.${service.busy ? " Restarting now ends what is under way." : ""}`}
            </Banner>
          ) : null}
        </>
      ) : linked ? null : (
        <p class="lah-lead lah-small">Its update and memory settings show while it is linked.</p>
      )}
    </div>
  );
}
