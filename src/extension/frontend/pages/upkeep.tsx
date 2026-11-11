// Storage (DESIGN §20): what LumiAH's store keeps. Each kind of thing stored, with how many, how
// big, how long Settings keep it (which leads to that setting) and its oldest; the total; the blobs
// nothing refers to, as last counted; the last sweep; and Sweep now, which asks first, says what it
// removes, and then says what it removed.

import { useEffect, useRef, useState } from "preact/hooks";
import type { UpkeepView } from "../../../shared/ui";
import { errorWords, useApp } from "../app";
import { Banner, Button, Empty, Section, useBusy, useTick } from "../components";
import { count, dateTime } from "../format";
import { Icon } from "../icons";
import { ageWords, bytesWords, lastSweepWords, looseWords, percentWords, shareOf, sweepAsk, sweptWords } from "../spend-model";
import { Stat } from "./spend";

/**
 * How often the page looks again, in milliseconds. Nothing is pushed when a sweep another page
 * started ends, so while one runs the page asks until it has; the same pace keeps "2 min ago" true.
 * It is the page's own pace and bounds nothing, so it is no setting.
 */
const LOOK_AGAIN_MS = 2000;

interface Read {
  status: "loading" | "ready" | "failed";
  view: UpkeepView | null;
  message: string;
}

export function UpkeepPage() {
  const app = useApp();
  const now = useTick(LOOK_AGAIN_MS);
  const [got, setGot] = useState<Read>({ status: "loading", view: null, message: "" });
  const [busy, run] = useBusy();
  /** This page's own sweep is under way (it was agreed to and asked for). */
  const [mine, setMine] = useState(false);
  /** What this page's last sweep did, in words; null before one. */
  const [done, setDone] = useState<string | null>(null);
  /** The read that counts: a slower answer to an earlier one is dropped, as is any that a sweep's own answer overtook. */
  const asked = useRef(0);
  const read = (): void => {
    const turn = (asked.current += 1);
    app.client.request("lah.upkeep.get", {}).then(
      (view) => turn === asked.current && setGot({ status: "ready", view, message: "" }),
      (e: unknown) => turn === asked.current && setGot((held) => ({ ...held, status: "failed", message: errorWords(e) })),
    );
  };
  useEffect(() => {
    read();
    return app.client.onBack(read);
  }, []);
  const view = got.view;
  const elsewhere = view !== null && view.sweeping && !mine;
  useEffect(() => {
    if (elsewhere) read();
  }, [now]);
  const sweep = (): void => {
    if (view === null) return;
    run(async () => {
      if (!(await app.host.confirm({ title: "Sweep the store now?", message: sweepAsk(view), confirm: "Sweep now", danger: true }))) return;
      setMine(true);
      setDone(null);
      try {
        const after = await app.client.request("lah.upkeep.sweep", {});
        asked.current += 1;
        setGot({ status: "ready", view: after, message: "" });
        setDone(sweptWords(after));
        app.toast(sweptWords(after));
      } catch (error) {
        app.fail(error);
        read();
      } finally {
        setMine(false);
      }
    });
  };
  const open = (path: string[]): void => app.nav.update((n) => ({ ...n, page: "settings", setting: path }));
  return (
    <div class="lah-upkeep" data-lah-view="upkeep" data-status={got.status} data-sweeping={mine || elsewhere || undefined}>
      {got.status === "failed" ? (
        <Banner
          tone="neg"
          title="What is stored couldn't be read"
          actions={
            <Button icon="refresh" onClick={read}>
              Try again
            </Button>
          }
        >
          {got.message}
        </Banner>
      ) : null}
      {view === null && got.status === "loading" ? <Empty icon="hourglass">Reading what is stored…</Empty> : null}
      {view !== null ? (
        <>
          <div class="lah-statgrid" data-lah-total>
            <Stat label="Stored" value={bytesWords(view.total.bytes)} sub={`in ${count(view.total.count)} stored ${view.total.count === 1 ? "thing" : "things"}`} />
            <Stat label="Nothing refers to" value={view.loose === null ? "Not counted" : bytesWords(view.loose.bytes)} sub={view.loose === null ? "a sweep counts it" : `${count(view.loose.count)} ${view.loose.count === 1 ? "blob" : "blobs"}, as last counted`} />
          </div>
          {view.total.count === 0 ? (
            <Empty icon="database" title="Nothing is stored yet">
              Each model call's prompt, each turn's transcript, the turns a summary replaced, the versions of workspace files and the reports of jobs are stored as agents work. Send a message in a chat LumiAH answers, and they show here.
            </Empty>
          ) : (
            <Section title="What is stored" flush id="kinds">
              <table class="lah-tbl" role="table" aria-label="What is stored, by kind" data-lah-table="kinds">
                <thead role="rowgroup">
                  <tr role="row">
                    <th role="columnheader" scope="col">
                      Kind
                    </th>
                    <th role="columnheader" scope="col">
                      How many
                    </th>
                    <th role="columnheader" scope="col">
                      Size
                    </th>
                    <th role="columnheader" scope="col">
                      Oldest
                    </th>
                    <th role="columnheader" scope="col">
                      Kept for
                    </th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {view.kinds.map((kind) => (
                    <tr key={kind.kind} role="row" data-lah-row={kind.kind}>
                      <th role="rowheader" scope="row">
                        {kind.label}
                      </th>
                      <td role="cell" data-label="How many">
                        {count(kind.count)}
                      </td>
                      <td role="cell" data-label="Size">
                        {bytesWords(kind.bytes)}
                        <span class="lah-tbl-sub">{`${percentWords(shareOf(kind.bytes, view.total.bytes))} of what is stored`}</span>
                      </td>
                      <td role="cell" data-label="Oldest">
                        {kind.oldestAt === null ? (
                          "None stored"
                        ) : (
                          <>
                            {`${ageWords(now, kind.oldestAt)} old`}
                            <span class="lah-tbl-sub">{dateTime(kind.oldestAt)}</span>
                          </>
                        )}
                      </td>
                      <td role="cell" data-label="Kept for" data-wide>
                        {kind.kept !== null ? (
                          <Button icon="sliders" label={`Kept for: ${kind.kept.words}. Open this setting`} onClick={() => kind.kept && open(kind.kept.path)}>
                            {kind.kept.words}
                          </Button>
                        ) : (
                          "As long as something refers to it"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot role="rowgroup">
                  <tr role="row" data-lah-row="total">
                    <th role="rowheader" scope="row">
                      Everything stored
                    </th>
                    <td role="cell" data-label="How many">
                      {count(view.total.count)}
                    </td>
                    <td role="cell" data-label="Size">
                      {bytesWords(view.total.bytes)}
                    </td>
                    <td role="cell" colSpan={2} data-fill />
                  </tr>
                </tfoot>
              </table>
            </Section>
          )}
          <Section title="The sweep" id="sweep">
            <div class="lah-sweep">
              <p class="lah-lead lah-small">A sweep removes what Settings no longer keep, and the blobs nothing refers to: stored texts that no turn, job, file or summary names any more.</p>
              <dl class="lah-sweep-facts">
                <div>
                  <dt>Blobs nothing refers to</dt>
                  <dd data-lah-loose>{looseWords(view.loose, now)}</dd>
                </div>
              </dl>
              <p class="lah-sweep-last" data-lah-last-sweep>
                {lastSweepWords(view.lastSweep, now)}
              </p>
              {mine ? (
                <p class="lah-line" role="status" data-lah-sweep-status>
                  <Icon name="hourglass" size={14} />
                  <span>Sweeping: removing what Settings no longer keep and what nothing refers to. This page says what it removed when it ends.</span>
                </p>
              ) : elsewhere ? (
                <Banner tone="info" title="A sweep is running">
                  It was started from another page or device. What it removed shows here when it ends.
                </Banner>
              ) : null}
              {done !== null ? (
                <Banner tone="pos" title="The sweep is done">
                  {done}
                </Banner>
              ) : null}
              <div class="lah-actions">
                <Button icon="trash" busy={busy} disabled={elsewhere} onClick={sweep}>
                  Sweep now
                </Button>
              </div>
            </div>
          </Section>
        </>
      ) : null}
    </div>
  );
}
