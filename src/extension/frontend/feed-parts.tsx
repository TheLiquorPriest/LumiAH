// What the feed and a prompt's view are both made of: a text with the search's finds marked, a long
// text that shows its start first, and the folding block that holds one. The feed's fold state, what
// the search found and where it stands travel as `Folds`.

import { useEffect, useState } from "preact/hooks";
import { useApp } from "./app";
import { Button, CopyButton } from "./components";
import { compact, count } from "./format";
import { Icon } from "./icons";
import { markPieces } from "./live-model";

/** The time now, a second at a time while `ticking`. */
export function useNow(ticking: boolean): number {
  const app = useApp();
  const [now, setNow] = useState(() => app.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(app.now());
    // A second: the times shown while a turn runs are whole seconds, so nothing finer would show.
    const timer = setInterval(() => setNow(app.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** A text with what the search found marked; the find the search stands on (`now`, its place among this text's finds) is marked apart. */
export function Marked(props: { text: string; query: string; now?: number }) {
  if (props.query.trim() === "") return <>{props.text}</>;
  let nth = -1;
  return (
    <>
      {markPieces(props.text, props.query).map((p, i) => {
        if (!p.hit) return p.text;
        nth += 1;
        return (
          <mark key={i} data-lah-now={nth === props.now || undefined}>
            {p.text}
          </mark>
        );
      })}
    </>
  );
}

/** How the feed's blocks fold, what the search found in them, and how much of a long text shows. */
export interface Folds {
  query: string;
  /** How many finds each item holds, by its key. */
  hits: ReadonlyMap<string, number>;
  /** The find the search stands on: its item, which of the item's texts, and its place among that text's finds. */
  current: { key: string; field: number; nth: number } | null;
  /** Whether block `key` shows open: as chosen, else as all were set, else its default. */
  open(key: string, byDefault: boolean): boolean;
  set(key: string, open: boolean): void;
  /** A long text shows this many characters, then the rest on request. */
  clip: number;
  whole(id: string): boolean;
  showWhole(id: string): void;
}

/** A text as written, with the search's finds marked. A long one shows its start and the rest on request, or at once when the search stands on it; one still arriving (`live`) shows whole, since its newest words are at its end. */
export function FeedText(props: { item: string; field: number; text: string; folds: Folds; live?: boolean }) {
  const { folds } = props;
  const id = `${props.item}/${props.field}`;
  const now = folds.current !== null && folds.current.key === props.item && folds.current.field === props.field ? folds.current.nth : -1;
  const whole = props.live === true || props.text.length <= folds.clip || folds.whole(id) || now >= 0;
  return (
    <>
      <pre class="lah-text">
        <Marked text={whole ? props.text : props.text.slice(0, folds.clip)} query={folds.query} now={now} />
        {whole ? null : "…"}
      </pre>
      {whole ? null : (
        <div class="lah-block-actions">
          <Button size="sm" icon="chevron-down" onClick={() => folds.showWhole(id)}>
            {`Show the rest (${compact(props.text.length - folds.clip)} more characters)`}
          </Button>
        </div>
      )}
    </>
  );
}

/** How many finds a folded block holds, said on its line. */
export function Hits(props: { n: number }) {
  return props.n > 0 ? <span class="lah-hits">{`${count(props.n)} found`}</span> : null;
}

/**
 * A folding block of text: its title and the text's first line, then the text as written, with Copy.
 * Its kind is an attribute, not a class: a message's role ("user", "system") as a bare class is
 * exactly what a chat's own stylesheet, or a user's custom CSS, is written to catch. `live` marks a
 * text still arriving from a call in flight.
 */
export function TextBlock(props: { item: string; field?: number; kind: string; title: string; text: string; folds: Folds; byDefault?: boolean; meta?: string; live?: boolean }) {
  const { folds } = props;
  const open = folds.open(props.item, props.byDefault ?? false);
  // The first line, cut at 200 characters: a summary line shows fewer than that at any width, and a line of megabytes would otherwise sit in every folded block.
  const preview = (props.text.trimStart().split("\n", 1)[0] ?? "").slice(0, 200);
  return (
    <details class="lah-block" data-kind={props.kind} data-lah-live={props.live || undefined} open={open} data-lah-key={props.item} data-lah-here={folds.current?.key === props.item || undefined} onToggle={(event) => folds.set(props.item, event.currentTarget.open)}>
      <summary>
        <Icon name="chevron-right" size={14} class="lah-caret" />
        <span class="lah-block-title">{props.title}</span>
        {props.live ? <span class="lah-pulse" role="img" aria-label="still arriving" /> : null}
        <span class="lah-block-preview">{preview}</span>
        <Hits n={folds.hits.get(props.item) ?? 0} />
        <span class="lah-block-meta">{props.meta ?? `${compact(props.text.length)} chars`}</span>
      </summary>
      {open ? (
        <div class="lah-block-body">
          <div class="lah-block-actions">
            <CopyButton text={props.text} label={`Copy ${props.title.toLowerCase()}`}>
              Copy
            </CopyButton>
          </div>
          <FeedText item={props.item} field={props.field ?? 0} text={props.text} folds={folds} live={props.live} />
        </div>
      ) : null}
    </details>
  );
}
