// What a turn's view says of the two ways to run (DESIGN §25) and of the lore and history a reply
// rests on (§24.1, §24.3): the time a built-in turn has left before the reply, what a turn came to
// for its reply (the brief as prose, the lore by name), the cause of a reply that failed or that
// LumiAH had no part in with the step that mends it, the fold of what the prompt held, and the
// entries a `write_reply` call added to and left out of the prompt, each with the way to it on the
// Lore page. The words and the decisions are live-model.ts's; these render them.

import { useState } from "preact/hooks";
import type { LoreChanges, PromptHeld } from "../../shared/ui";
import { useApp } from "./app";
import { Banner, Button, Disclosure } from "./components";
import { Marked } from "./feed-parts";
import { count, counted } from "./format";
import { Icon, type IconName } from "./icons";
import { briefOpening, heldLine, historyWords, indexWords, loreChangeLine, markPieces, type Mend, type MendStep, replyClock } from "./live-model";
import { whyWords } from "./lore-model";
import { Prose } from "./prose";
import { openSetting } from "./setting-links";
import { useGrant } from "./setup-parts";

/** A built-in turn's time before the reply, counted down where the user looks while it works: whole in a turn's head and on Home, `short` in the pinned bar. */
export function ReplyClock(props: { replyBy: number; startedAt: number; now: number; short?: boolean }) {
  const clock = replyClock(props.replyBy, props.startedAt, props.now);
  return (
    <span class={props.short ? "lah-replyclock lah-is-short lah-num" : "lah-replyclock lah-num"} data-lah-clock={clock.over ? "over" : clock.urgent ? "urgent" : "plenty"} role="timer" aria-label={clock.text}>
      <Icon name="hourglass" size={props.short ? 14 : 16} />
      <span>{props.short ? clock.short : clock.over ? `${clock.text}: Lumiverse sends the prompt as it is.` : clock.text}</span>
    </span>
  );
}

/**
 * What a turn came to for its reply (ux B1): the brief the main agent gave the model that writes
 * the reply, as prose (its opening; the rest on request), and the lore it added and left out, by
 * name. Nothing where it did neither.
 */
export function ReplyBrief(props: { brief: string | null; lore: string }) {
  const [whole, setWhole] = useState(false);
  const { brief, lore } = props;
  if (brief === null && lore === "") return null;
  const short = brief !== null ? briefOpening(brief) : null;
  return (
    <div class="lah-brief" data-lah-brief>
      {brief !== null ? (
        <>
          <span class="lah-field-label">What it told the model that writes your reply</span>
          {short !== null && !whole ? <p class="lah-brief-text">{short}</p> : <Prose text={brief} />}
          {short !== null ? (
            <span class="lah-brief-more">
              <Button size="sm" variant="ghost" icon={whole ? "chevron-up" : "chevron-down"} expanded={whole} onClick={() => setWhole(!whole)}>
                {whole ? "Show less" : "Show all of it"}
              </Button>
            </span>
          ) : null}
        </>
      ) : null}
      {lore !== "" ? (
        <p class="lah-line" data-lah-brief-lore>
          <Icon name="book" size={14} />
          <span>{lore}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Takes a mending step: opens the setting or the page it names, asks Lumiverse for the permissions LumiAH lacks, or (`onProblems`) shows the steps that went wrong. */
export function useMendStep(onProblems: () => void): { busy: boolean; take(step: MendStep): void } {
  const app = useApp();
  const grant = useGrant();
  return {
    busy: grant.busy,
    take: (step) => {
      if (step.go === "setting") openSetting(app, step.link);
      else if (step.go === "page") app.nav.update((n) => ({ ...n, page: step.page }));
      else if (step.go === "grant") grant.ask((app.client.state.get()?.permissions ?? []).map((p) => p.id));
      else onProblems();
    },
  };
}

const MEND_ICON: Readonly<Record<MendStep["go"], IconName>> = { setting: "sliders", page: "arrow-right", grant: "shield", problems: "filter" };

/** A reply that failed, or that LumiAH had no part in: the cause as the heading, what happened in a sentence, and the one step that mends it. */
export function MendBanner(props: { mend: Mend; onProblems(): void }) {
  const { mend } = props;
  const step = useMendStep(props.onProblems);
  const action = mend.action;
  return (
    <div data-lah-mend={action?.step.go ?? "none"} data-tone={mend.tone}>
      <Banner
        tone={mend.tone === "neutral" ? "info" : mend.tone}
        title={mend.title}
        actions={
          action !== null ? (
            <Button variant="primary" icon={MEND_ICON[action.step.go]} busy={action.step.go === "grant" && step.busy} onClick={() => step.take(action.step)}>
              {action.label}
            </Button>
          ) : undefined
        }
      >
        {mend.text}
      </Banner>
    </div>
  );
}

/** A lore entry named in a turn: its title, a word on it, and the way to it on the Lore page. */
function EntryRow(props: { entryId: string; title: string; note: string }) {
  const app = useApp();
  return (
    <li>
      <button type="button" class="lah-entryrow" data-lah-entry={props.entryId} onClick={() => app.nav.update((n) => ({ ...n, page: "lore", lore: props.entryId }))}>
        <Icon name="book" size={16} />
        <span class="lah-entryrow-text">
          <span class="lah-entryrow-title">{props.title}</span>
          <span class="lah-entryrow-note">{props.note}</span>
        </span>
        <Icon name="chevron-right" size={16} class="lah-chev" />
      </button>
    </li>
  );
}

/** What the prompt held this turn, as the main agent was told (§24.1): folded, with its sizes on the fold's line. */
export function HeldPrompt(props: { held: PromptHeld }) {
  const { held } = props;
  return (
    <Disclosure
      class="lah-heldprompt"
      summary={
        <>
          <strong>What the prompt held</strong> <span class="lah-heldprompt-sizes">{heldLine(held)}</span>
        </>
      }
    >
      <p class="lah-lead lah-small">Each turn the main agent is told what Lumiverse already put in the prompt, so it looks up only what is missing.</p>
      <div class="lah-heldprompt-part" data-lah-held="lore">
        <span class="lah-field-label">Lore in the prompt</span>
        {held.lore.length === 0 ? (
          <p class="lah-lead lah-small">Lumiverse put no lore entry in this prompt.</p>
        ) : (
          <ul class="lah-entryrows">
            {held.lore.map((e) => (
              <EntryRow key={e.entryId} entryId={e.entryId} title={e.title} note={`${whyWords(e.why)} · ≈${counted(e.tokens, "token")}`} />
            ))}
          </ul>
        )}
      </div>
      <div class="lah-heldprompt-part" data-lah-held="index">
        <span class="lah-field-label">Lore not in the prompt</span>
        <p class="lah-lead lah-small">{indexWords(held.index)}</p>
        {held.index.listed.length > 0 ? (
          <ul class="lah-entryrows">
            {held.index.listed.map((e) => (
              <EntryRow key={e.entryId} entryId={e.entryId} title={e.title} note={e.keys.length > 0 ? `keys: ${e.keys.join(", ")}` : `${count(e.chars)} characters, no keys`} />
            ))}
          </ul>
        ) : null}
      </div>
      <div class="lah-heldprompt-part" data-lah-held="history">
        <span class="lah-field-label">The chat in the prompt</span>
        {historyWords(held.history).map((line) => (
          <p key={line} class="lah-lead lah-small">
            {line}
          </p>
        ))}
      </div>
    </Disclosure>
  );
}

type Changed = "added" | "dropped" | "refused";
const CHANGE_ICON: Readonly<Record<Changed, IconName>> = { added: "plus", dropped: "close", refused: "alert" };
const CHANGE_WORD: Readonly<Record<Changed, string>> = { added: "Added", dropped: "Left out of this prompt", refused: "Refused" };

/**
 * What a `write_reply` call did to the lore the writer saw (§24.3): a line that says it, then each
 * entry added and dropped with the way to it, and each it named that was refused with why. `query`
 * and `now` mark what the transcript's search found in it (`now`: the find the search stands on,
 * counted through the rows in order; -1 when it stands elsewhere).
 */
export function LoreChange(props: { lore: LoreChanges; query: string; now: number }) {
  const app = useApp();
  const { lore } = props;
  const rows: { kind: Changed; entryId: string | null; text: string }[] = [...lore.added.map((e) => ({ kind: "added" as const, entryId: e.entryId, text: e.title })), ...lore.dropped.map((e) => ({ kind: "dropped" as const, entryId: e.entryId, text: e.title })), ...lore.refused.map((r) => ({ kind: "refused" as const, entryId: null, text: `${r.entryId} (${r.reason})` }))];
  // Each row's text is a line of what the search read (`loreChangeText`: "Added: The night key"), so the finds before a row are counted to place the one the search stands on.
  let before = 0;
  return (
    <div class="lah-lorechange" data-lah-lore-change>
      <p class="lah-line">
        <Icon name="book" size={14} />
        <span>{loreChangeLine(lore)}</span>
      </p>
      <ul class="lah-changed">
        {rows.map((row) => {
          const line = `${CHANGE_WORD[row.kind]}: ${row.text}`;
          const now = props.now - before;
          before += props.query.trim() === "" ? 0 : markPieces(line, props.query).filter((p) => p.hit).length;
          const entryId = row.entryId;
          return (
            <li key={`${row.kind}:${row.text}`} class="lah-changed-row" data-change={row.kind}>
              <Icon name={CHANGE_ICON[row.kind]} size={14} />
              <span class="lah-changed-path">
                <Marked text={line} query={props.query} now={now} />
              </span>
              {entryId !== null ? (
                <Button size="sm" icon="book" onClick={() => app.nav.update((n) => ({ ...n, page: "lore", lore: entryId }))}>
                  Open
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
