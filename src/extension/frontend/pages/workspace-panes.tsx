// What the Workspace page shows beside its list that is no single file (DESIGN §11): a reply's
// change set, the files each agent is always given, and the form that makes a file.

import { useEffect, useId, useState } from "preact/hooks";
import type { ChangedFile, WorkspaceArea, WorkspaceView } from "../../../shared/ui";
import { errorWords, type FileTarget, useApp } from "../app";
import { Badge, Button, Editor, Empty, Field, IconButton, type Tone, useBusy } from "../components";
import { count, counted } from "../format";
import { Icon } from "../icons";
import { useSelect } from "../store";
import { draftsOf, putDraft } from "../workspace-drafts";
import { AREA_WORDS, boundOf, CHANGE_WORDS, type ChangeKind, type ChangeRow, changeRows, changesSummary, fullPath, isDirty, newDraftKey, normalizePath, pathProblem, pinGroups, replyWords, writeProblem } from "../workspace-model";
import { BoundLine, CloseWide, DiffView, PaneHead, Problem, refusalOf, useFileVersion, Who } from "./workspace-parts";

// ---------------------------------------------------------------- a reply's change set

const CHANGE_TONE: Readonly<Record<ChangeKind, Tone>> = { added: "pos", changed: "accent", removed: "neg", moved: "neutral" };

/** What a reply's agents did to one file, line against line, read when it is asked for: each side is a version of the file at the row's path. */
function ChangeDiff(props: { chatId: string; row: ChangeRow }) {
  const { chatId, row } = props;
  const moved = row.kind === "moved";
  const before = useFileVersion(chatId, row.area, row.path, moved ? null : row.before);
  const after = useFileVersion(chatId, row.area, row.path, moved ? null : row.after);
  if (moved) return <p class="lah-lead lah-small">Its text is as it was: only its path changed.</p>;
  const failed = before.failed ?? after.failed;
  if (failed !== null) return <Problem>{`Its versions couldn't be read: ${failed}`}</Problem>;
  if ((row.before !== null && before.text === null) || (row.after !== null && after.text === null)) return <p class="lah-lead lah-small">Reading its versions…</p>;
  return <DiffView before={before.text ?? ""} after={after.text ?? ""} label={`What changed in ${fullPath(row.area, row.path)}`} />;
}

type ChangeSet = { status: "reading" } | { status: "ready"; changes: ChangedFile[] } | { status: "failed"; message: string };

/** The change set recorded on a reply: each file its agents, and the jobs it started, added, changed, removed or moved, by whom, with its diff on request and the way to the file. */
export function ChangesPane(props: { chatId: string | null; target: { messageId: string; swipe: number }; basis: WorkspaceView["basis"]; onClose(): void; onOpen(file: FileTarget): void }) {
  const app = useApp();
  const { chatId, target } = props;
  const [state, setState] = useState<ChangeSet>({ status: "reading" });
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (chatId === null) return;
    let live = true;
    setState({ status: "reading" });
    app.client.request("lah.ws.changes", { chatId, messageId: target.messageId, swipe: target.swipe }).then(
      (r) => live && setState({ status: "ready", changes: r.changes }),
      (error: unknown) => live && setState({ status: "failed", message: errorWords(error) }),
    );
    const off = app.client.onBack(() => setTries((n) => n + 1));
    return () => {
      live = false;
      off();
    };
  }, [chatId, target.messageId, target.swipe, tries]);
  // The reply's place in the chat is known only where it is the one the chat's area stands on.
  const reply = props.basis !== null && props.basis.messageId === target.messageId && props.basis.swipe === target.swipe ? props.basis : null;
  const rows = state.status === "ready" ? changeRows(state.changes) : [];
  return (
    <>
      <PaneHead
        title={reply ? `What ${replyWords(reply)} changed` : "What this reply changed"}
        sub={reply ? undefined : `message ${target.messageId} · swipe ${target.swipe + 1}`}
        back="Back to the files"
        onBack={props.onClose}
        aside={<CloseWide label="Back to browsing" onClose={props.onClose} />}
      />
      {chatId === null ? (
        <Empty icon="message" title="No chat is open">
          A change set belongs to a reply of a chat. Open the chat in Lumiverse, or pick it from the list above the files.
        </Empty>
      ) : state.status === "reading" ? (
        <Empty icon="hourglass">Reading what the reply changed…</Empty>
      ) : state.status === "failed" ? (
        <Empty
          icon="alert"
          title="The change set couldn't be read"
          action={
            <Button icon="refresh" onClick={() => setTries((n) => n + 1)}>
              Try again
            </Button>
          }
        >
          {state.message}
        </Empty>
      ) : rows.length === 0 ? (
        <Empty icon="folder" title="No file changed">
          The agents that worked on this reply, and the jobs it started, wrote nothing to the workspace.
        </Empty>
      ) : (
        <>
          <p class="lah-lead" data-lah-changes-summary>{`What the agents that worked on this reply, and the jobs it started, wrote. ${changesSummary(rows)}`}</p>
          <ol class="lah-ws-changes" aria-label="The files the reply changed">
            {rows.map((row) => {
              const id = `${row.area}:${row.path}`;
              const open = shown.has(id);
              const name = fullPath(row.area, row.path);
              return (
                <li key={id} class="lah-ws-change" data-lah-change={row.kind}>
                  <div class="lah-ws-change-head">
                    <Badge tone={CHANGE_TONE[row.kind]}>{`${CHANGE_WORDS[row.kind].sign} ${CHANGE_WORDS[row.kind].word}`}</Badge>
                    <span class="lah-ws-path">{row.from !== null ? `${fullPath(row.area, row.from)} → ${name}` : name}</span>
                  </div>
                  <span class="lah-small lah-muted lah-ws-facts">
                    <span>by</span>
                    <Who by={row.by} />
                  </span>
                  <div class="lah-actions">
                    <Button icon="compare" expanded={open} label={open ? `Hide what changed in ${name}` : `Show what changed in ${name}`} onClick={() => setShown((held) => new Set(open ? [...held].filter((x) => x !== id) : [...held, id]))}>
                      {open ? "Hide the diff" : "Show the diff"}
                    </Button>
                    <Button icon={row.kind === "removed" ? "history" : "file"} label={row.kind === "removed" ? `Open the history of ${name}` : `Open ${name}`} onClick={() => props.onOpen({ area: row.area, path: row.path, hash: row.after ?? row.before })}>
                      {row.kind === "removed" ? "Open its history" : "Open the file"}
                    </Button>
                  </div>
                  {open ? <ChangeDiff chatId={chatId} row={row} /> : null}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- what agents are always given

/** The files each agent is always given (pinned for it), across the areas read, against the room one agent has for them; each file leads to itself and can be taken off here. */
export function PinsPane(props: { chatId: string | null; views: readonly WorkspaceView[]; onClose(): void; onOpen(file: FileTarget): void; onChanged(area: WorkspaceArea): void }) {
  const app = useApp();
  const { chatId } = props;
  const [busy, run] = useBusy();
  const groups = pinGroups(props.views);
  const room = props.views[0]?.limits.pinChars;
  const unpin = (area: WorkspaceArea, path: string, agent: string, whom: string): void =>
    run(async () => {
      try {
        await app.client.request("lah.ws.pin", { chatId, area, path, agent, on: false });
        app.toast(`${fullPath(area, path)} is no longer always given to ${whom}.`);
        props.onChanged(area);
      } catch (error) {
        app.fail(error);
      }
    });
  return (
    <>
      <PaneHead title="Files agents are always given" sub="In an agent's prompt at every reply" back="Back to the files" onBack={props.onClose} aside={<CloseWide label="Close" onClose={props.onClose} />} />
      <p class="lah-lead">
        {`A file an agent is always given is put in its prompt at every reply, so the agent has it without looking for it.${room !== undefined ? ` Each agent has room for ${count(room)} characters of such files: past that, the rest are only named to it, with how to read them.` : ""}${chatId === null ? " No chat is open, so only the files of your own area show." : ""}`}
      </p>
      {groups.length === 0 ? (
        <Empty icon="pin" title="No agent is always given a file">
          Open a file and press Always give to the main agent, or Give to another agent… to pick another.
        </Empty>
      ) : (
        groups.map((group) => (
          <section key={group.agent} class="lah-ws-pingroup" data-lah-pins={group.agent}>
            <div class="lah-ws-pingroup-head">
              <Icon name="agent" size={16} />
              <strong>{group.name}</strong>
              {group.known ? null : <Badge tone="warn">no such agent now</Badge>}
            </div>
            <BoundLine label="Always given" bound={group.bound} />
            {group.bound.over > 0 ? (
              <p class="lah-line lah-is-warn">
                <Icon name="alert" size={14} />
                <span>This agent is always given more than it has room for: the files past its room are only named to it. Take one off, or raise the limit in Settings.</span>
              </p>
            ) : null}
            <div class="lah-navlist">
              {group.files.map(({ area, file }) => {
                const name = fullPath(area, file.path);
                return (
                  <div key={`${area}:${file.path}`} class="lah-ws-pinrow">
                    <button type="button" class="lah-navrow" aria-label={`Open ${name}`} onClick={() => props.onOpen({ area, path: file.path, hash: null })}>
                      <Icon name="file" size={16} />
                      <span class="lah-navrow-text">
                        <span class="lah-navrow-title lah-ws-path">{name}</span>
                        <span class="lah-navrow-sub lah-num">{counted(file.chars, "character")}</span>
                      </span>
                    </button>
                    <IconButton icon="close" label={`Stop always giving ${name} to ${group.name}`} disabled={busy} onClick={() => unpin(area, file.path, group.agent, group.name)} />
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}
    </>
  );
}

// ---------------------------------------------------------------- a new file

/** The form that makes a file: its path within the area, checked as it is typed, and its first text. What is typed is a draft, kept until the file is made or the form is cancelled. */
export function NewFilePane(props: { chatId: string | null; area: WorkspaceArea; view: WorkspaceView | null; onClose(): void; onMade(path: string): void }) {
  const app = useApp();
  const { chatId, area, view } = props;
  const key = newDraftKey(chatId, area);
  const draft = useSelect(draftsOf(app), (d) => d.get(key) ?? null);
  const path = draft?.path ?? "";
  const text = draft?.text ?? "";
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const id = useId();
  const put = (next: { path?: string; text?: string }): void => {
    putDraft(app, key, { base: null, from: "", text: next.text ?? text, path: next.path ?? path });
    setRefused(null);
  };
  const pathWrong = pathProblem(area, path, view?.files ?? []);
  const textWrong = view !== null ? writeProblem(view, text, null) : null;
  const make = (): void =>
    run(async () => {
      setRefused(null);
      try {
        const r = await app.client.request("lah.ws.write", { chatId, area, path: normalizePath(path), text, base: null });
        putDraft(app, key, null);
        app.toast(`Made ${fullPath(area, r.file.path)}.`);
        props.onMade(r.file.path);
      } catch (error) {
        setRefused(refusalOf(error));
      }
    });
  const cancel = async (): Promise<void> => {
    if (draft !== null && isDirty(draft) && !(await app.host.confirm({ title: "Drop this new file?", message: "What you typed for it is not saved, and dropping it can't be undone.", confirm: "Drop it", danger: true }))) return;
    putDraft(app, key, null);
    props.onClose();
  };
  return (
    <>
      <PaneHead title="A new file" sub={`In ${AREA_WORDS[area].sign} · ${AREA_WORDS[area].name}`} back="Back to the files: what you typed is kept" onBack={props.onClose} />
      <div class="lah-stack" data-lah-new-file>
        <Field label="Its path, within this area" for={id} error={path.trim() === "" ? null : pathWrong} help={`A slash makes a folder. Agents find the file as ${fullPath(area, normalizePath(path) || "notes/plan.md")}.`}>
          <input id={id} class="lah-input lah-mono" autocomplete="off" spellcheck={false} placeholder="notes/plan.md" value={path} aria-invalid={path.trim() !== "" && pathWrong !== null ? true : undefined} onInput={(event) => put({ path: event.currentTarget.value })} />
        </Field>
        <Editor label="The new file's text" rows={10} placeholder="Its text: markdown, or any text. It may be left empty." value={text} invalid={textWrong !== null} onInput={(next) => put({ text: next })} />
        {view !== null ? <BoundLine label="Length" bound={boundOf(text.length, view.limits.fileChars, "character")} /> : null}
        {textWrong !== null ? <Problem>{textWrong}</Problem> : null}
        {refused !== null ? <Problem>{refused}</Problem> : null}
        <div class="lah-actions">
          <Button variant="primary" icon="check" busy={busy} disabled={pathWrong !== null || textWrong !== null} onClick={make}>
            Make the file
          </Button>
          <Button icon="close" disabled={busy} onClick={() => void cancel()}>
            Cancel
          </Button>
        </div>
      </div>
    </>
  );
}
