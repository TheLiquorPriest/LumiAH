// A file's history (DESIGN §11): its versions, newest first, a deletion among them. One is read,
// two are compared line against line, and one is restored: its text written as the newest version.
// A version's text is read from its file (`useFileVersion`), so none is read once the file is gone.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { FileVersion, WorkspaceArea, WorkspaceFile } from "../../../shared/ui";
import { Badge, Banner, Button, CopyButton, Empty, IconButton } from "../components";
import { counted, dateTime } from "../format";
import { Icon } from "../icons";
import { revealInScroller } from "../scroll";
import { pickedPair, pickVersion, replyWords, type VersionRow, versionRows } from "../workspace-model";
import { DiffView, Problem, useFileVersion, Who } from "./workspace-parts";

/** A file's history as the page holds it: not asked for, being read, read, or refused. */
export type Versions = { status: "none" } | { status: "reading" } | { status: "ready"; versions: FileVersion[] } | { status: "failed"; message: string };

/** The file a history is of, as a request names it. */
interface Place {
  chatId: string | null;
  area: WorkspaceArea;
  path: string;
}

/** One version's text, with Copy and the way to restore it. A version the history doesn't list (the link that led here named one it no longer keeps) shows by its hash. */
function VersionText(props: { at: Place; hash: string; row: VersionRow | null; busy: boolean; onClose(): void; onRestore(text: string, base: string): void; onStands(file: WorkspaceFile): void }) {
  const { at, row } = props;
  const { text, failed, file } = useFileVersion(at.chatId, at.area, at.path, props.hash);
  const el = useRef<HTMLDivElement>(null);
  // The version opens under the list, which may be longer than the panel shows.
  useLayoutEffect(() => revealInScroller(el.current, "nearest"), [props.hash]);
  // The read came with the file as it stands, which may be a later version than the pane holds.
  useEffect(() => {
    if (file !== null) props.onStands(file);
  }, [file]);
  return (
    <div class="lah-ws-panel" ref={el} data-lah-version-text>
      <div class="lah-spread">
        <strong>{row ? `The version of ${dateTime(row.version.at)}` : `The version ${props.hash.slice(0, 8)}…`}</strong>
        <IconButton icon="close" label="Close this version" onClick={props.onClose} />
      </div>
      {row ? (
        <span class="lah-small lah-muted lah-ws-facts">
          <Who by={row.version.by} />
          <span>{row.current ? "the file as it stands" : counted(row.version.chars, "character")}</span>
        </span>
      ) : (
        <p class="lah-line">
          <Icon name="info" size={14} />
          <span>The history doesn't list this version: it is older than the history keeps, or it was written on another path of the story.</span>
        </p>
      )}
      {failed !== null ? (
        <Problem>{`This version's text couldn't be read: ${failed}`}</Problem>
      ) : text === null || file === null ? (
        <p class="lah-lead">Reading this version…</p>
      ) : (
        <>
          {text === "" ? <p class="lah-lead">This version is empty.</p> : <pre class="lah-text lah-ws-text">{text}</pre>}
          <div class="lah-actions">
            <CopyButton text={text} label="Copy this version's text" size="md" variant="secondary">
              Copy
            </CopyButton>
            {row?.current ? null : (
              <Button icon="undo" busy={props.busy} onClick={() => props.onRestore(text, file.hash)}>
                Restore this version…
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Two versions line against line, the older first. */
function Compare(props: { at: Place; older: VersionRow; newer: VersionRow; onClose(): void }) {
  const { at, older, newer } = props;
  const before = useFileVersion(at.chatId, at.area, at.path, older.version.hash);
  const after = useFileVersion(at.chatId, at.area, at.path, newer.version.hash);
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => revealInScroller(el.current, "nearest"), [older.key, newer.key]);
  const failed = before.failed ?? after.failed;
  return (
    <div class="lah-ws-panel" ref={el} data-lah-compare>
      <div class="lah-spread">
        <strong>{`From the version of ${dateTime(older.version.at)} to the version of ${dateTime(newer.version.at)}`}</strong>
        <IconButton icon="close" label="Close the comparison" onClick={props.onClose} />
      </div>
      {failed !== null ? <Problem>{`The two versions couldn't be read: ${failed}`}</Problem> : before.text === null || after.text === null ? <p class="lah-lead">Reading the two versions…</p> : <DiffView before={before.text} after={after.text} label="The older version against the newer" />}
    </div>
  );
}

export interface HistoryProps {
  /** The file, as a request names it. */
  at: Place;
  /** The file's name, as the page says it. */
  name: string;
  versions: Versions;
  /** The file's version now; null: the file isn't here, so none of its versions can be read. */
  standing: string | null;
  /** The version shown, by its body's hash; null: none. */
  shown: string | null;
  /** When the version restored just now was first written; null when none was. */
  restored: number | null;
  busy: boolean;
  onShow(hash: string | null): void;
  /** Restores a version: its text, and the version the file had when that text was read, which the write is based on. */
  onRestore(text: string, base: string, version: FileVersion | null): void;
  /** A version's read said how the file stands. */
  onStands(file: WorkspaceFile): void;
  onRetry(): void;
}

export function HistoryView(props: HistoryProps) {
  const { at, versions } = props;
  const [picks, setPicks] = useState<readonly string[]>([]);
  /** The row the user pressed Read on: two versions may hold the same text, and the mark belongs on the one pressed. */
  const [pressed, setPressed] = useState<string | null>(null);
  if (versions.status === "none" || versions.status === "reading") return <Empty icon="hourglass">Reading the history…</Empty>;
  if (versions.status === "failed")
    return (
      <Empty
        icon="alert"
        title="The history couldn't be read"
        action={
          <Button icon="refresh" onClick={props.onRetry}>
            Try again
          </Button>
        }
      >
        {versions.message}
      </Empty>
    );
  const rows = versionRows(versions.versions);
  // A pick may name a version the history has dropped since.
  const picked = picks.filter((key) => rows.some((r) => r.key === key));
  const pair = pickedPair(rows, picked);
  const shownRow = props.shown === null ? null : (rows.find((r) => r.key === pressed && r.version.hash === props.shown) ?? rows.find((r) => r.version.hash === props.shown) ?? null);
  return (
    <div class="lah-stack" data-lah-history>
      {props.restored !== null ? (
        <Banner tone="pos" title="Restored">
          {`The text of ${dateTime(props.restored)} is ${props.name}'s newest version now. The one it took the place of is the next below.`}
        </Banner>
      ) : null}
      {rows.length === 0 ? (
        <Empty icon="history" title="No version is kept">
          The history holds every version written while it is kept. Nothing has been written at this path.
        </Empty>
      ) : (
        <>
          <p class="lah-lead lah-small">{`${counted(rows.length, "version")}, newest first.${props.standing === null ? "" : " Read one, or pick two to compare: picking a third lets go of the first."}`}</p>
          <ol class="lah-ws-versions" aria-label={`The versions of ${props.name}`}>
            {rows.map((row) => {
              const v = row.version;
              const isShown = shownRow === row;
              const isPicked = picked.includes(row.key);
              return (
                <li key={row.key} class="lah-ws-version" data-lah-version={row.key} data-deleted={row.deleted}>
                  <div class="lah-ws-version-text">
                    <span class="lah-ws-version-when">
                      <span>{dateTime(v.at)}</span>
                      {row.current ? <Badge tone="accent">as it stands</Badge> : null}
                      {row.deleted ? <Badge tone="warn">deleted</Badge> : null}
                    </span>
                    <span class="lah-small lah-muted lah-num lah-ws-facts">
                      <Who by={v.by} />
                      {row.deleted ? null : <span>{counted(v.chars, "character")}</span>}
                      {v.turn !== null ? <span>{replyWords(v.turn)}</span> : null}
                    </span>
                  </div>
                  {row.deleted || v.hash === null || props.standing === null ? null : (
                    <div class="lah-actions">
                      <Button
                        icon={isShown ? "check" : "eye"}
                        pressed={isShown}
                        label={isShown ? `Close the version of ${dateTime(v.at)}` : `Read the version of ${dateTime(v.at)}`}
                        onClick={() => {
                          setPressed(row.key);
                          props.onShow(isShown ? null : v.hash);
                        }}
                      >
                        {isShown ? "Shown" : "Read"}
                      </Button>
                      <Button icon={isPicked ? "check" : "compare"} pressed={isPicked} label={isPicked ? `Don't compare the version of ${dateTime(v.at)}` : `Compare the version of ${dateTime(v.at)}`} onClick={() => setPicks(pickVersion(picked, row.key))}>
                        {isPicked ? "Picked" : "Compare"}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {picked.length === 1 ? <p class="lah-lead lah-small">One version is picked: pick another to compare it with.</p> : null}
        </>
      )}
      {pair ? <Compare at={at} older={pair.older} newer={pair.newer} onClose={() => setPicks([])} /> : null}
      {/* A version is read with the file as it stood then, which a restore is based on: once the file has another version, the read is made again. */}
      {props.shown !== null ? (
        <VersionText
          key={`${props.shown}:${props.standing ?? ""}`}
          at={at}
          hash={props.shown}
          row={shownRow}
          busy={props.busy}
          onClose={() => props.onShow(null)}
          onRestore={(text, base) => props.onRestore(text, base, shownRow?.version ?? null)}
          onStands={props.onStands}
        />
      ) : null}
    </div>
  );
}
