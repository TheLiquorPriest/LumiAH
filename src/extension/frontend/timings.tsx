// Runtime → Timings (PI-BUILD-PLAN §4.7): where the time goes between this extension and its
// runtimes, from the timing log each end keeps (`lah.timings.get`, one read of each end, never one a
// row). And the road the pages' requests take to each runtime: the faster road through Lumiverse's
// proxy, or the link, with what granting the permission does while it isn't granted.

import { useEffect, useState } from "preact/hooks";
import type { RoadsView, RoadView, TimingsPage, TimingsView } from "../../shared/ui";
import { errorWords, useApp } from "./app";
import { Banner, Button, Disclosure, Section } from "./components";
import { keptWords, opRows, roadLine, slowLine } from "./timings-model";

/** Past this a row's slowest one in twenty is marked: well under any page's wait, far over a request that doesn't queue. */
const SLOW_MS = 5_000;

/** The line a runtime's row says of the road the pages' requests take to it. */
export function RoadLine(props: { road: RoadView | undefined }) {
  const line = roadLine(props.road);
  return (
    <li data-lah-road={props.road?.road ?? "link"}>
      <span class={line.proxy ? undefined : "lah-small"}>{line.text}</span>
    </li>
  );
}

/** What granting the permission the faster road needs does, while it isn't granted. */
export function RoadOffer(props: { road: RoadsView }) {
  if (props.road.offer === null) return null;
  return (
    <Banner tone="info" title="A faster road for the pages">
      {props.road.offer}
    </Banner>
  );
}

/** One end's log: what it holds, a line per op and road, and its slowest crossings. */
function EndTimings(props: { title: string; view: TimingsView; now: number }) {
  const rows = opRows(props.view, SLOW_MS);
  return (
    <div class="lah-timings-end" data-lah-timings={props.title}>
      <p class="lah-set-label">{props.title}</p>
      <p class="lah-small lah-lead">{keptWords(props.view, props.now)}</p>
      {rows.length > 0 ? (
        <ul class="lah-facts">
          {rows.map((r) => (
            <li key={r.key} data-lah-op={r.key}>
              <span class={r.slow ? "lah-warn" : undefined}>{`${r.op} by the ${r.road}: ${r.count}. Median ${r.median}, 95th percentile ${r.p95}, slowest ${r.max}. Waiting ${r.waiting}, working ${r.working} (medians). Largest ${r.largest}.`}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {props.view.slowest.length > 0 ? (
        <Disclosure summary={`The slowest ${props.view.slowest.length} of them`}>
          <ul class="lah-facts">
            {props.view.slowest.map((c, i) => (
              <li key={`${c.at} ${c.op} ${i}`}>
                <span>{slowLine(c, props.now)}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );
}

/** Runtime → Timings: this extension's end and each linked runtime's, read when shown and again at the user's word. */
export function TimingsSection(props: { now: number; name: string }) {
  const app = useApp();
  const [read, setRead] = useState<{ page: TimingsPage | null; failed: string | null; asked: number }>({ page: null, failed: null, asked: 0 });
  useEffect(() => {
    let live = true;
    app.client.request("lah.timings.get", {}).then(
      (page) => live && setRead((held) => ({ ...held, page, failed: null })),
      (error: unknown) => live && setRead((held) => ({ ...held, failed: errorWords(error) })),
    );
    return () => {
      live = false;
    };
  }, [read.asked]);
  const page = read.page;
  return (
    <Section title="Timings" id="timings">
      <p class="lah-small lah-lead">{`How long each request between ${props.name} and its runtimes took, and where: waiting is time on the way and in queues, working is the other end's own time on it. Only sizes and times are kept, never what crossed, and only in memory.`}</p>
      {read.failed !== null ? <p class="lah-small lah-warn">{read.failed}</p> : null}
      {page === null ? (
        read.failed === null ? <p class="lah-small">Reading them…</p> : null
      ) : (
        <>
          <EndTimings title={`${props.name}: what its pages and tools asked a runtime`} view={page.extension} now={props.now} />
          {page.runtimes.map((r) =>
            r.timings !== null ? (
              <EndTimings key={r.id} title={`${r.name}: what it asked ${props.name} over the link`} view={r.timings} now={props.now} />
            ) : (
              <p key={r.id} class="lah-small lah-warn">{`${r.name}: ${r.problem ?? "its timings couldn't be read."}`}</p>
            ),
          )}
        </>
      )}
      <div class="lah-actions">
        <Button size="sm" icon="refresh" onClick={() => setRead((held) => ({ ...held, asked: held.asked + 1 }))}>
          Look again
        </Button>
      </div>
    </Section>
  );
}
