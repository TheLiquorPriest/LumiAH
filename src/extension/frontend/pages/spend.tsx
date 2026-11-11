// Spend (DESIGN §20): what the model calls of a period cost. The period's total; its days as a bar
// chart, each bar a button that says its day's figures, with the same figures as a table; the spend
// by chat, by agent, by connection and by model; the caps in force, each leading to its setting;
// and the period as a CSV file. Below the wide width a table's row is its name with its figures
// under it.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { SpendCap, SpendRow, SpendView } from "../../../shared/ui";
import { errorWords, useApp } from "../app";
import { Badge, Banner, Button, Disclosure, Empty, IconButton, Section, Seg, type SegOption } from "../components";
import { count, counted } from "../format";
import { Icon } from "../icons";
import { byCost, capView, chartOf, costCell, dayShort, dayWords, type Measure, MEASURE_WORDS, PERIODS, rowWords, spendCsv, spendCsvName, tokensInWords, unpricedWords } from "../spend-model";
import { useSelect } from "../store";

/** The period the page opens at, in days: the middle one of its three. A choice of the page's own, like the periods themselves. */
const START_DAYS = 30;

const MEASURES: readonly SegOption<Measure>[] = [
  { value: "cost", label: MEASURE_WORDS.cost },
  { value: "tokens", label: MEASURE_WORDS.tokens },
];

/** One figure with its name above it and a word about it below. */
export function Stat(props: { label: string; value: string; sub?: string }) {
  return (
    <div class="lah-statcard" data-lah-stat={props.label}>
      <span class="lah-statcard-label">{props.label}</span>
      <span class="lah-statcard-value">{props.value}</span>
      {props.sub ? <span class="lah-statcard-sub">{props.sub}</span> : null}
    </div>
  );
}

/** The days as bars. A bar is a button named by its day's figures; the day picked is said in words under the chart, where two buttons step a day at a time, so every day is reached without aiming at a thin bar. */
function Chart(props: { days: readonly SpendRow[] }) {
  const { days } = props;
  const [measure, setMeasure] = useState<Measure>("cost");
  const [picked, setPicked] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const chart = chartOf(days, measure);
  const found = picked === null ? -1 : days.findIndex((d) => d.key === picked);
  // Today, the last of the days, is the one picked until another is.
  const at = found >= 0 ? found : days.length - 1;
  const row = days[at];
  // A period opens at its latest days: where its days need more room than the chart has, the oldest are the ones scrolled out.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [days.length]);
  // A day stepped to is brought into the chart's own box; the page is not scrolled.
  useLayoutEffect(() => {
    const box = scroller.current;
    const bar = box?.querySelector<HTMLElement>("[aria-pressed=true]");
    if (!box || !bar || picked === null) return;
    const left = bar.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft;
    if (left < box.scrollLeft) box.scrollLeft = left;
    else if (left + bar.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = left + bar.offsetWidth - box.clientWidth;
  }, [picked]);
  const step = (by: number): void => {
    const next = days[at + by];
    if (next) setPicked(next.key);
  };
  return (
    <div class="lah-chart" data-lah-chart>
      <div class="lah-spread">
        <Seg label="What the bars measure" value={measure} options={MEASURES} onChange={(m) => setMeasure(m)} />
        <span class="lah-small lah-muted">{chart.top > 0 ? `A bar is a day. The top line is ${chart.topWords}; the middle line is half of it.` : measure === "cost" ? "No day of this period had a cost: its calls had no price. Tokens shows what they sent and wrote." : "No day of this period sent or wrote a token."}</span>
      </div>
      <div ref={scroller} class="lah-chart-scroll" style={{ "--lah-days": String(days.length) }}>
        <ol class="lah-chart-plot" aria-label={`${MEASURE_WORDS[measure]} by day, ${counted(days.length, "day")}, oldest first`}>
          {chart.bars.map((bar, i) => (
            <li key={bar.key}>
              <button type="button" class="lah-chart-bar" data-lah-bar={bar.key} data-empty={bar.value === 0 || undefined} aria-pressed={i === at} aria-label={bar.words} title={bar.words} onClick={() => setPicked(bar.key)}>
                <span style={{ "--lah-bar": String(bar.height) }} />
              </button>
            </li>
          ))}
        </ol>
        <div class="lah-chart-ends" aria-hidden="true">
          <span>{dayShort(days[0]?.key ?? "")}</span>
          <span>{dayShort(days.at(-1)?.key ?? "")}</span>
        </div>
      </div>
      {row ? (
        <div class="lah-chart-day">
          <IconButton icon="chevron-left" label="Show the day before" disabled={at <= 0} onClick={() => step(-1)} />
          <p role="status" data-lah-day={row.key}>
            <strong>{dayWords(row.key)}</strong>
            {rowWords(row)}
          </p>
          <IconButton icon="chevron-right" label="Show the day after" disabled={at >= days.length - 1} onClick={() => step(1)} />
        </div>
      ) : null}
    </div>
  );
}

/** Rows of spend as a table: a name, then its calls, tokens and cost. `name` says what a row is (a chat, a day), and names the table. */
function SpendTable(props: { name: string; rows: readonly SpendRow[]; label?(row: SpendRow): string }) {
  const label = props.label ?? ((row: SpendRow) => row.label);
  return (
    <table class="lah-tbl" role="table" aria-label={`Spend by ${props.name.toLowerCase()}`} data-lah-table={props.name.toLowerCase()}>
      <thead role="rowgroup">
        <tr role="row">
          <th role="columnheader" scope="col">
            {props.name}
          </th>
          <th role="columnheader" scope="col">
            Calls
          </th>
          <th role="columnheader" scope="col">
            Tokens in (cached)
          </th>
          <th role="columnheader" scope="col">
            Tokens out
          </th>
          <th role="columnheader" scope="col">
            Cost
          </th>
          <th role="columnheader" scope="col">
            Calls with no price
          </th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        {props.rows.map((row) => (
          <tr key={row.key} role="row" data-lah-row={row.key}>
            <th role="rowheader" scope="row">
              {label(row)}
            </th>
            <td role="cell" data-label="Calls">
              {count(row.calls)}
            </td>
            <td role="cell" data-label="Tokens in (cached)">
              {tokensInWords(row)}
            </td>
            <td role="cell" data-label="Tokens out">
              {count(row.out)}
            </td>
            <td role="cell" data-label="Cost">
              {costCell(row)}
            </td>
            <td role="cell" data-label="Calls with no price">
              {count(row.unpriced)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One cap: what it bounds, how much of it is used as a bar and in numbers, whether it is reached in a word, and the way to its setting. */
function Cap(props: { cap: SpendCap }) {
  const app = useApp();
  const { cap } = props;
  const v = capView(cap);
  return (
    <div class="lah-cap" data-lah-cap={cap.path.join(".")} data-reached={v.reached || undefined}>
      <div class="lah-cap-head">
        <strong>{cap.label}</strong>
        {v.reached ? (
          <Badge tone="neg">
            <Icon name="alert" size={12} />
            reached
          </Badge>
        ) : v.fraction === null ? (
          <Badge>no limit</Badge>
        ) : (
          <Badge tone="pos">within its limit</Badge>
        )}
      </div>
      {v.fraction !== null ? (
        <div class="lah-meter" role="meter" aria-label={cap.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(v.fraction * 100)} aria-valuetext={v.words} data-reached={v.reached || undefined}>
          <span style={{ "--lah-fill": String(v.fraction) }} />
        </div>
      ) : null}
      <div class="lah-cap-foot">
        <p>{v.reached ? `${v.words} The next model call is refused, in words that name this setting.` : v.words}</p>
        <Button icon="sliders" onClick={() => app.nav.update((n) => ({ ...n, page: "settings", setting: cap.path }))}>
          {cap.limit === null ? "Set a limit" : "Open its setting"}
        </Button>
      </div>
    </div>
  );
}

interface Read {
  status: "loading" | "ready" | "failed";
  /** The period read last, with how many days it was asked for; null until one has been, and after a failure. */
  view: SpendView | null;
  message: string;
}

export function SpendPage() {
  const app = useApp();
  // A cap's limit is a setting: when Settings change, what was read is read again.
  const settings = useSelect(app.client.state, (s) => s?.settings.values ?? null);
  const [days, setDays] = useState(START_DAYS);
  const [got, setGot] = useState<Read>({ status: "loading", view: null, message: "" });
  /** The read that counts: a slower answer about a period since left is dropped. */
  const asked = useRef(0);
  const read = (): void => {
    const mine = (asked.current += 1);
    setGot((held) => ({ ...held, status: "loading" }));
    app.client.request("lah.spend.get", { days }).then(
      (view) => mine === asked.current && setGot({ status: "ready", view, message: "" }),
      (e: unknown) => mine === asked.current && setGot({ status: "failed", view: null, message: errorWords(e) }),
    );
  };
  useEffect(() => {
    read();
    return app.client.onBack(read);
  }, [days, settings]);
  const view = got.view;
  const unpriced = view ? unpricedWords(view.total) : null;
  return (
    <div class="lah-spend" data-lah-view="spend" data-status={got.status}>
      <div class="lah-spend-head">
        <Seg label="The period" value={String(days)} options={PERIODS.map((d) => ({ value: String(d), label: `${d} days` }))} onChange={(d) => setDays(Number(d))} />
        <Button icon="download" disabled={view === null} onClick={() => view && app.save(spendCsvName(view), spendCsv(view), "text/csv")}>
          Export as CSV
        </Button>
      </div>
      {got.status === "failed" ? (
        <Banner
          tone="neg"
          title="The spend couldn't be read"
          actions={
            <Button icon="refresh" onClick={read}>
              Try again
            </Button>
          }
        >
          {got.message}
        </Banner>
      ) : null}
      {got.status === "loading" ? (
        view === null ? (
          <Empty icon="hourglass">{`Reading the spend of the last ${days} days…`}</Empty>
        ) : (
          <p class="lah-small lah-muted" role="status">{`Reading the last ${days} days…`}</p>
        )
      ) : null}
      {view !== null ? (
        <>
          <div class="lah-stack" data-lah-total>
            <div class="lah-statgrid">
              <Stat label="Cost" value={costCell(view.total)} sub={`the last ${counted(view.days.length, "day")}, today among them`} />
              <Stat label="Calls" value={count(view.total.calls)} sub={view.total.unpriced > 0 ? `${count(view.total.unpriced)} of them had no price` : view.total.calls > 0 ? "each had a price" : undefined} />
              <Stat label="Tokens in" value={count(view.total.in)} sub={`${count(view.total.cachedIn)} read from cache`} />
              <Stat label="Tokens out" value={count(view.total.out)} />
            </div>
            {unpriced !== null ? (
              <p class="lah-spend-note">
                <Icon name="info" size={14} />
                <span>{unpriced}</span>
              </p>
            ) : null}
          </div>
          {view.total.calls === 0 ? (
            <Empty icon="coins" title={`Nothing was spent in the last ${counted(view.days.length, "day")}`}>
              Every model call an agent makes is recorded here with its chat, its agent, its connection, its model, its tokens and its cost. Send a message in a chat LumiAH answers, or pick a longer period.
            </Empty>
          ) : (
            <>
              <Section title="By day" id="days">
                <Chart days={view.days} />
                <Disclosure summary={`The same figures as a table, ${counted(view.days.length, "day")}, newest first`}>
                  <SpendTable name="Day" rows={[...view.days].reverse()} label={(row) => dayWords(row.key)} />
                </Disclosure>
              </Section>
              <Section title="By chat" flush id="chats">
                <SpendTable name="Chat" rows={byCost(view.chats)} />
              </Section>
              <Section title="By agent" flush id="agents">
                <SpendTable name="Agent" rows={byCost(view.agents)} />
              </Section>
              <Section title="By connection" flush id="connections">
                <SpendTable name="Connection" rows={byCost(view.connections)} />
              </Section>
              <Section title="By model" flush id="models">
                <SpendTable name="Model" rows={byCost(view.models)} />
              </Section>
            </>
          )}
          <Section title="Caps in force" flush id="caps">
            {view.caps.length === 0 ? <p class="lah-lead lah-spend-pad">No cap is in force. Caps are set in Settings, under Spend.</p> : view.caps.map((cap) => <Cap key={cap.path.join(".")} cap={cap} />)}
          </Section>
        </>
      ) : null}
    </div>
  );
}
