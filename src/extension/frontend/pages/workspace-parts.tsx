// What the Workspace and Guidance pages both draw: a pane's head, who wrote a version, a bound with
// its bar, a failure's line, the line diff, the box a text is edited in, and the box that shows what
// someone else wrote meanwhile with the three ways out of it. Also here: how one version of a file
// is read, for a history and for a change set.

import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { FileAuthor, WorkspaceArea, WorkspaceFile } from "../../../shared/ui";
import { errorWords, useApp } from "../app";
import { UiRequestError } from "../client";
import { Banner, Button, Editor, IconButton } from "../components";
import { counted } from "../format";
import { Icon, type IconName } from "../icons";
import { authorWords, type Bound, CHANGE_MARKS, CONFLICT_MARKS, type DiffMarks, diffLines, diffWords, foldDiff, refusalWords } from "../workspace-model";

/** A pane's head: Back (where the pane takes the list's place), what the pane shows, and what stands beside that. */
export function PaneHead(props: { title: ComponentChildren; sub?: ComponentChildren; back: string; onBack(): void; aside?: ComponentChildren }) {
  return (
    <div class="lah-pane-head">
      <span class="lah-back">
        <IconButton icon="chevron-left" label={props.back} onClick={props.onBack} />
      </span>
      <span class="lah-pane-title">
        <strong class="lah-h">{props.title}</strong>
        {props.sub !== undefined ? <span class="lah-dim lah-small">{props.sub}</span> : null}
      </span>
      {props.aside}
    </div>
  );
}

/** The way out of a pane where the list stays beside it, so the pane head's Back doesn't show. */
export function CloseWide(props: { label: string; icon?: IconName; onClose(): void }) {
  return (
    <span class="lah-ws-wide">
      <Button icon={props.icon ?? "close"} onClick={props.onClose}>
        {props.label}
      </Button>
    </span>
  );
}

const AUTHOR_ICON: Readonly<Record<FileAuthor["who"], IconName>> = { user: "user", agent: "agent", job: "clock" };

/** Who wrote a version: a mark for the kind of author, and the words. */
export function Who(props: { by: FileAuthor }) {
  return (
    <span class="lah-ws-who">
      <Icon name={AUTHOR_ICON[props.by.who]} size={14} />
      {authorWords(props.by)}
    </span>
  );
}

/** A failure where it happened, in the words it came with. */
export function Problem(props: { children: ComponentChildren }) {
  return (
    <span class="lah-field-error" role="alert">
      <Icon name="alert" size={16} />
      <span>{props.children}</span>
    </span>
  );
}

/** A request's refusal as a line: the backend's words, and what it said of each value it refused. */
export function refusalOf(error: unknown): string {
  return refusalWords(errorWords(error), error instanceof UiRequestError ? error.problems : []);
}

/** Whether a refusal says the version written over is no longer the file's: someone else wrote it, or took it away. */
export function isConflict(error: unknown): boolean {
  return error instanceof UiRequestError && (error.code === "conflict" || error.code === "not_found");
}

/** One version of a file as the page holds its read: its text, or why it couldn't be read in the backend's words, and the file as it stood when the version was read. All null while it is read, and where there is nothing to read. */
export interface VersionRead {
  text: string | null;
  failed: string | null;
  file: WorkspaceFile | null;
}

const UNREAD: VersionRead = { text: null, failed: null, file: null };

/**
 * A version of a file, read when it shows: `hash` is one a history or a change set names, null
 * where there is no text to read (a deletion, a file that wasn't there before a change). The file
 * itself gives a version's text, so one that is gone, or that no longer keeps the version, is
 * refused, and the refusal is what `failed` says.
 */
export function useFileVersion(chatId: string | null, area: WorkspaceArea, path: string, hash: string | null): VersionRead {
  const app = useApp();
  const [state, setState] = useState(UNREAD);
  useEffect(() => {
    setState(UNREAD);
    if (hash === null) return;
    // An answer that comes after another version was asked for belongs to no version shown.
    let live = true;
    app.client.request("lah.ws.read", { chatId, area, path, version: hash }).then(
      (r) => live && setState({ text: r.text, failed: null, file: r.file }),
      (error: unknown) => live && setState({ text: null, failed: errorWords(error), file: null }),
    );
    return () => {
      live = false;
    };
  }, [chatId, area, path, hash]);
  return state;
}

/** A bound in words over a bar of how much of it is used. A bound that is passed says so in the words and the bar's mark, not by colour alone. */
export function BoundLine(props: { label: string; bound: Bound }) {
  const { bound } = props;
  return (
    <div class="lah-ws-bound" data-over={bound.over > 0}>
      <span class="lah-small lah-num">
        {bound.over > 0 ? <Icon name="alert" size={14} /> : null}
        {`${props.label}: ${bound.words}`}
      </span>
      <span class="lah-ws-meter" aria-hidden="true">
        <span style={{ width: `${Math.round(bound.share * 100)}%` }} />
      </span>
    </div>
  );
}

/**
 * Two texts line against line: what was found in a sentence, then the lines, each one that only one
 * text has marked by a sign and a word as well as by its colour. A long run both share is folded
 * into one row that opens on a press.
 */
export function DiffView(props: { before: string; after: string; marks?: DiffMarks; label: string }) {
  const marks = props.marks ?? CHANGE_MARKS;
  const diff = useMemo(() => diffLines(props.before, props.after), [props.before, props.after]);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  // Folds are numbered within one diff: another pair of texts starts with all of its own folded.
  useEffect(() => setOpen(new Set()), [props.before, props.after]);
  const rows = foldDiff(diff, open);
  return (
    <div class="lah-ws-diffbox" data-lah-diff>
      <p class="lah-small lah-muted" data-lah-diff-words>
        {diffWords(diff, marks)}
      </p>
      {diff.added === 0 && diff.removed === 0 ? null : (
        <div class="lah-ws-diff" role="group" aria-label={props.label}>
          {rows.map((row) =>
            row.kind === "fold" ? (
              <button key={`fold-${row.id}`} type="button" class="lah-ws-fold" onClick={() => setOpen((held) => new Set([...held, row.id]))}>
                <Icon name="more" size={16} />
                <span>{`${counted(row.lines.length, "unchanged line")}: show ${row.lines.length === 1 ? "it" : "them"}`}</span>
              </button>
            ) : (
              <div key={`${row.line.kind}-${row.line.before ?? ""}-${row.line.after ?? ""}`} class="lah-ws-diffline" data-kind={row.line.kind}>
                <span class="lah-ws-diffsign" aria-hidden="true">
                  {row.line.kind === "same" ? "" : marks[row.line.kind].sign}
                </span>
                <span class="lah-ws-diffword">{row.line.kind === "same" ? "" : marks[row.line.kind].word}</span>
                <span class="lah-ws-difftext">{row.line.text}</span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export interface EditBoxProps {
  /** What the editor edits, as its name. */
  label: string;
  value: string;
  /** The text as saved, to set the edits against on request; null where nothing is saved yet. */
  saved: string | null;
  /** What the text's length is bounded by, with its name; null where the bound isn't known (the area's list couldn't be read), and the length alone shows. */
  bound: { label: string; bound: Bound } | null;
  /** Why it can't be saved as it stands: Save rests until it can. */
  problem: string | null;
  /** What the user should know of the text that doesn't keep it from being saved. */
  warning: string | null;
  /** What the backend refused of the last save, in its words. */
  refused: string | null;
  dirty: boolean;
  busy: boolean;
  onInput(text: string): void;
  onSave(): void;
  onCancel(): void;
}

/** A text being edited: the editor, its length against its bound, what is wrong with it, Save and Cancel, and the edits set against the saved text on request. */
export function EditBox(props: EditBoxProps) {
  const [comparing, setComparing] = useState(false);
  return (
    <div class="lah-ws-editbox" data-lah-editor>
      <Editor label={props.label} rows={12} value={props.value} invalid={props.problem !== null} onInput={props.onInput} />
      {props.bound !== null ? <BoundLine label={props.bound.label} bound={props.bound.bound} /> : <span class="lah-small lah-num">{counted(props.value.length, "character")}</span>}
      {props.problem !== null ? <Problem>{props.problem}</Problem> : null}
      {props.warning !== null ? (
        <p class="lah-line lah-is-warn">
          <Icon name="alert" size={14} />
          <span>{props.warning}</span>
        </p>
      ) : null}
      {props.refused !== null ? <Problem>{props.refused}</Problem> : null}
      <div class="lah-actions">
        <Button variant="primary" icon="check" busy={props.busy} disabled={!props.dirty || props.problem !== null} onClick={props.onSave}>
          Save
        </Button>
        <Button icon="close" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </Button>
        {props.saved !== null ? (
          <Button icon="compare" pressed={comparing} disabled={!props.dirty} onClick={() => setComparing((on) => !on)}>
            Compare with the saved text
          </Button>
        ) : null}
      </div>
      <p class="lah-lead lah-small">{props.dirty ? "Not saved yet. What you typed stays here until you save or cancel, even while you look at another page." : "Nothing is changed yet."}</p>
      {comparing && props.dirty && props.saved !== null ? <DiffView before={props.saved} after={props.value} label="The saved text against your edits" /> : null}
    </div>
  );
}

/**
 * What a save met: someone else wrote the same thing meanwhile (or took it away: `theirs` null).
 * Their text is set against the user's, line by line, with the three ways out: keep the user's
 * (written over theirs, which stays in the history), take theirs (the user's text is dropped), or
 * go on editing with theirs known.
 */
export function ConflictBox(props: { what: string; who: string; said: string | null; theirs: string | null; yours: string; busy: boolean; onKeep(): void; onTake(): void; onGoOn(): void }) {
  const gone = props.theirs === null;
  return (
    <div class="lah-ws-conflict" data-lah-conflict>
      <Banner tone="warn" title={gone ? `${props.what} was deleted while you were editing` : `${props.what} was written again while you were editing`}>
        {props.said !== null ? <p>{props.said}</p> : null}
        <p>{`${props.who} Your text is not saved. ${gone ? "Below is your text; nothing of theirs is left to set it against." : "Below, their text is set against yours, line by line."}`}</p>
      </Banner>
      <DiffView before={props.theirs ?? ""} after={props.yours} marks={CONFLICT_MARKS} label="Their text against yours" />
      <div class="lah-actions">
        <Button variant="primary" icon="check" busy={props.busy} onClick={props.onKeep}>
          Keep mine
        </Button>
        <Button icon="undo" disabled={props.busy} onClick={props.onTake}>
          Take theirs…
        </Button>
        <Button icon="edit" disabled={props.busy} onClick={props.onGoOn}>
          Go on editing
        </Button>
      </div>
      <ul class="lah-facts">
        <li>
          <span>{gone ? "Keep mine writes your text as the file again." : "Keep mine writes your text as the newest version. Theirs stays in the history."}</span>
        </li>
        <li>
          <span>{gone ? "Take theirs drops your text: the file stays deleted." : "Take theirs drops your text and shows theirs."}</span>
        </li>
        <li>
          <span>Go on editing leaves your text in the editor, for you to work theirs into before you save.</span>
        </li>
      </ul>
    </div>
  );
}
