// A file of the workspace, open (DESIGN §11): its text, read-only at first; the editor, whose save
// names the version the edit started from; what a save meets when someone else wrote the file
// meanwhile (their text against the user's, and three ways out); its pins; its move and its
// deletion; and its history beside (workspace-history.tsx). Text typed and not yet saved is a draft
// kept outside the pane (workspace-drafts.ts), so the editor is open exactly while a draft is.

import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { FileVersion, WorkspaceFile, WorkspaceView } from "../../../shared/ui";
import { errorWords, type FileTarget, PAGES, useApp } from "../app";
import { UiRequestError } from "../client";
import { Banner, Button, CopyButton, Empty, Field, Seg, useBusy } from "../components";
import { ago, dateTime } from "../format";
import { Icon } from "../icons";
import { useSelect } from "../store";
import { draftsOf, putDraft } from "../workspace-drafts";
import { AREA_WORDS, authorWords, boundOf, draftKey, fileBackWords, fileFacts, fullPath, isDirty, isStale, MAIN_AGENT, normalizePath, pathProblem, pinChoices, pinnedWords, writeProblem } from "../workspace-model";
import { HistoryView, type Versions } from "./workspace-history";
import { CloseWide, ConflictBox, EditBox, isConflict, PaneHead, refusalOf } from "./workspace-parts";

/** The file as the pane holds it: being read, read, not there (with why, in the backend's words), or not readable. */
type Read = { status: "reading" } | { status: "ready"; file: WorkspaceFile; text: string } | { status: "gone"; message: string } | { status: "failed"; message: string };

const TABS = [
  { value: "text", label: "Text" },
  { value: "history", label: "History" },
] as const;

export interface FilePaneProps {
  chatId: string | null;
  target: FileTarget;
  /** The file's area as the list has it: its bounds, its agent definitions, and the file's own row; null while the list isn't read. */
  view: WorkspaceView | null;
  /** The file was opened from a reply's change set, which is where Back leads. */
  fromChanges: boolean;
  onClose(): void;
  /** The area changed (a write, a move, a deletion, a pin): its list should be read again. */
  onChanged(): void;
}

export function FilePane(props: FilePaneProps) {
  const app = useApp();
  const { chatId, target, view } = props;
  const { area, path } = target;
  const name = fullPath(area, path);
  const key = draftKey(chatId, area, path);
  const draft = useSelect(draftsOf(app), (d) => d.get(key) ?? null);
  const [read, setRead] = useState<Read>({ status: "reading" });
  const [tab, setTab] = useState<"text" | "history">("text");
  const [versions, setVersions] = useState<Versions>({ status: "none" });
  const [form, setForm] = useState<"none" | "pins" | "move">("none");
  const [to, setTo] = useState(path);
  const [refused, setRefused] = useState<string | null>(null);
  const [moveRefused, setMoveRefused] = useState<string | null>(null);
  const [restored, setRestored] = useState<number | null>(null);
  const [saving, save] = useBusy();
  const [acting, act] = useBusy();
  const moveId = useId();
  const now = app.now();
  const live = useRef(true);
  /** Which read was asked for last: an answer to an earlier one is dropped. */
  const asked = useRef({ file: 0, history: 0 });
  const holding = read.status === "ready" || read.status === "gone";

  const readFile = async (): Promise<void> => {
    asked.current.file += 1;
    const mine = asked.current.file;
    try {
      const r = await app.client.request("lah.ws.read", { chatId, area, path });
      if (live.current && mine === asked.current.file) setRead({ status: "ready", file: r.file, text: r.text });
    } catch (error) {
      if (!live.current || mine !== asked.current.file) return;
      if (error instanceof UiRequestError && error.code === "not_found") setRead({ status: "gone", message: error.message });
      // What the pane holds still shows when reading it again fails; the failure is said beside it.
      else if (holding) app.fail(error);
      else setRead({ status: "failed", message: errorWords(error) });
    }
  };
  const readHistory = (): void => {
    asked.current.history += 1;
    const mine = asked.current.history;
    setVersions((held) => (held.status === "ready" ? held : { status: "reading" }));
    app.client.request("lah.ws.history", { chatId, area, path }).then(
      (r) => live.current && mine === asked.current.history && setVersions({ status: "ready", versions: r.versions }),
      (error: unknown) => live.current && mine === asked.current.history && setVersions({ status: "failed", message: errorWords(error) }),
    );
  };
  const usable = area === "user" || chatId !== null;
  useEffect(() => {
    if (usable) void readFile();
    const off = app.client.onBack(() => usable && void readFile());
    return () => {
      live.current = false;
      off();
    };
  }, []);

  /** The file's version now: a hash, null where it is gone, undefined until that is known. */
  const current = read.status === "ready" ? read.file.hash : read.status === "gone" ? null : undefined;
  // The list was read again: where it has another version of this file than the pane, someone wrote it meanwhile, so the pane reads it again; where it has the same, its row is the newer word on the file's pins.
  useEffect(() => {
    if (view === null) return;
    const row = view.files.find((f) => f.path === path) ?? null;
    if (read.status === "ready") {
      if (row === null || row.hash !== read.file.hash) void readFile();
      else if (row !== read.file) setRead({ ...read, file: row });
    } else if (read.status === "gone" && row !== null) void readFile();
  }, [view]);
  // A link that names the version the file has now names the file as it stands: later versions must not turn this pane into a view of an old one.
  useEffect(() => {
    if (target.hash !== null && target.hash === current) app.nav.update((n) => (n.file === target ? { ...n, file: { ...target, hash: null } } : n));
  }, [target, current]);
  // A draft nothing was typed into holds no text of the user's: where the file moved on, the draft follows it, and no conflict is made of it.
  useEffect(() => {
    if (draft === null || isDirty(draft) || current === undefined || !isStale(draft, current)) return;
    putDraft(app, key, read.status === "ready" ? { base: read.file.hash, from: read.text, text: read.text } : null);
  }, [draft, current]);

  /** A version other than the file's current one, which the link that led here (or the history's Read) asks to see. */
  const version = current !== undefined && target.hash !== null && target.hash !== current ? target.hash : null;
  const inHistory = tab === "history" || version !== null || (read.status === "gone" && draft === null);
  useEffect(() => {
    if (inHistory && current !== undefined) readHistory();
  }, [inHistory, current]);

  // The page that led to the file stays with it through its versions, so Back still returns there.
  const show = (hash: string | null): void => app.nav.update((n) => ({ ...n, file: { ...target, hash } }));
  const drop = (): void => {
    putDraft(app, key, null);
    setRefused(null);
  };
  const dropAsked = async (title: string, confirm: string): Promise<void> => {
    if (draft !== null && isDirty(draft) && !(await app.host.confirm({ title, message: `What you typed into ${name} is not saved, and dropping it can't be undone.`, confirm, danger: true }))) return;
    drop();
  };
  const write = (text: string, base: string | null, said: string): void =>
    save(async () => {
      setRefused(null);
      try {
        const r = await app.client.request("lah.ws.write", { chatId, area, path, text, base });
        putDraft(app, key, null);
        setRead({ status: "ready", file: r.file, text });
        app.toast(said);
        props.onChanged();
      } catch (error) {
        setRefused(refusalOf(error));
        // Someone else wrote it meanwhile, or took it away: read again (the list too, which says who and when), and the draft, which is kept, shows against theirs.
        if (isConflict(error)) {
          props.onChanged();
          await readFile();
        }
      }
    });
  /** Writes a version's text as the newest version, based on the version the file had when that text was read: the one it takes the place of stays in the history. */
  const restore = (text: string, base: string, from: FileVersion | null): void =>
    save(async () => {
      const agreed = await app.host.confirm({
        title: "Restore this version?",
        message: `${from ? `The text of ${dateTime(from.at)}` : "This version's text"} becomes ${name}'s newest version. The version it has now stays in the history.`,
        confirm: "Restore",
      });
      if (!agreed) return;
      try {
        const r = await app.client.request("lah.ws.write", { chatId, area, path, text, base });
        setRead({ status: "ready", file: r.file, text });
        setRestored(from?.at ?? r.file.at);
        setTab("history");
        show(null);
        props.onChanged();
      } catch (error) {
        app.fail(error);
        // Someone else wrote it since the version was read, or took it away: read again (the list too), and the version is read again with it, so the next press is based on the file as it stands then.
        if (isConflict(error)) {
          props.onChanged();
          await readFile();
        }
      }
    });
  /** A version's read came with the file as it stands: where that is another version than the pane holds, someone wrote it meanwhile, so the pane and the list are read again. */
  const stands = (file: WorkspaceFile): void => {
    if (current === undefined || file.hash === current) return;
    props.onChanged();
    void readFile();
  };
  const pin = (agent: string, on: boolean, whom: string): void =>
    act(async () => {
      try {
        const r = await app.client.request("lah.ws.pin", { chatId, area, path, agent, on });
        setRead((held) => (held.status === "ready" ? { ...held, file: r.file } : held));
        app.toast(on ? `Always given to ${whom} from the next reply.` : `No longer always given to ${whom}.`);
        props.onChanged();
      } catch (error) {
        app.fail(error);
      }
    });
  const move = (file: WorkspaceFile): void =>
    act(async () => {
      setMoveRefused(null);
      try {
        const r = await app.client.request("lah.ws.move", { chatId, area, from: path, to: normalizePath(to), base: file.hash });
        app.toast(`Moved to ${fullPath(area, r.file.path)}.`);
        props.onChanged();
        app.nav.update((n) => ({ ...n, file: { ...target, path: r.file.path, hash: null } }));
      } catch (error) {
        setMoveRefused(refusalOf(error));
        if (isConflict(error)) {
          props.onChanged();
          await readFile();
        }
      }
    });
  const remove = (file: WorkspaceFile): void =>
    act(async () => {
      const agreed = await app.host.confirm({
        title: `Delete ${name}?`,
        message: "Agents and you no longer find it in this area, and this page can no longer read its versions: copy its text first if you may want it back.",
        confirm: "Delete",
        danger: true,
      });
      if (!agreed) return;
      try {
        await app.client.request("lah.ws.delete", { chatId, area, path, base: file.hash });
        app.toast(`Deleted ${name}.`);
        props.onChanged();
        setForm("none");
        await readFile();
      } catch (error) {
        app.fail(error);
        if (isConflict(error)) {
          props.onChanged();
          await readFile();
        }
      }
    });

  // A file another page led to (the Chronicle, to one of its own) goes back there, not to whatever the Workspace was showing before.
  const origin = target.from !== undefined && target.from !== "workspace" ? (PAGES.find((p) => p.id === target.from) ?? null) : null;
  const back = fileBackWords(origin?.label ?? null, props.fromChanges);
  const goBack = origin !== null ? (): void => app.nav.update((n) => ({ ...n, page: origin.id, file: null })) : props.onClose;
  const head = (
    <PaneHead
      title={<span class="lah-ws-path">{name}</span>}
      sub={read.status === "ready" ? `${AREA_WORDS[area].name} · ${fileFacts(read.file, now)}` : AREA_WORDS[area].name}
      back={back}
      onBack={goBack}
      aside={origin !== null || props.fromChanges ? <CloseWide icon="chevron-left" label={back} onClose={goBack} /> : undefined}
    />
  );
  if (!usable)
    return (
      <>
        {head}
        <Empty icon="message" title="This file belongs to a chat">
          No chat is open, so it can't be read. Open the chat in Lumiverse, or pick it from the list above the files.
        </Empty>
      </>
    );
  if (read.status === "reading")
    return (
      <>
        {head}
        <Empty icon="hourglass">Reading the file…</Empty>
      </>
    );
  if (read.status === "failed")
    return (
      <>
        {head}
        <Empty
          icon="alert"
          title="The file couldn't be read"
          action={
            <Button icon="refresh" onClick={() => void readFile()}>
              Try again
            </Button>
          }
        >
          {read.message}
        </Empty>
      </>
    );

  const history = <HistoryView at={{ chatId, area, path }} name={name} versions={versions} standing={read.status === "ready" ? read.file.hash : null} shown={version} restored={restored} busy={saving} onShow={show} onRestore={restore} onStands={stands} onRetry={readHistory} />;
  /** The editor, or what its save met: shown while a draft is kept. */
  const editing = (held: NonNullable<typeof draft>) =>
    isStale(held, read.status === "ready" ? read.file.hash : null) ? (
      <ConflictBox
        what={name}
        who={read.status === "ready" ? `${authorWords(read.file.by).replace(/^./, (c) => c.toUpperCase())} wrote it ${ago(now, read.file.at)}.` : "It is no longer in this area."}
        said={refused}
        theirs={read.status === "ready" ? read.text : null}
        yours={held.text}
        busy={saving}
        onKeep={() => write(held.text, read.status === "ready" ? read.file.hash : null, "Saved: your text is the newest version.")}
        onTake={() => void dropAsked("Drop your text and take theirs?", "Drop my text")}
        onGoOn={() => {
          putDraft(app, key, { ...held, base: read.status === "ready" ? read.file.hash : null, from: read.status === "ready" ? read.text : "" });
          setRefused(null);
        }}
      />
    ) : (
      <EditBox
        label={`The text of ${name}`}
        value={held.text}
        saved={read.status === "ready" ? read.text : null}
        bound={view !== null ? { label: "Length", bound: boundOf(held.text.length, view.limits.fileChars, "character") } : null}
        problem={view !== null ? writeProblem(view, held.text, read.status === "ready" ? read.file : null) : null}
        warning={null}
        refused={refused}
        dirty={isDirty(held)}
        busy={saving}
        onInput={(text) => putDraft(app, key, { ...held, text })}
        onSave={() => write(held.text, held.base, "Saved.")}
        onCancel={() => void dropAsked("Drop your edits?", "Drop my edits")}
      />
    );

  if (read.status === "gone") {
    const last = versions.status === "ready" ? versions.versions[0] : undefined;
    const known = versions.status === "ready" && versions.versions.length > 0;
    return (
      <>
        {head}
        {draft !== null ? (
          editing(draft)
        ) : versions.status === "failed" || (versions.status === "ready" && !known && version === null) ? (
          <Empty
            icon="file"
            title={`There is no file at ${name}`}
            action={
              <Button icon="chevron-left" onClick={goBack}>
                {back}
              </Button>
            }
          >
            {read.message}
          </Empty>
        ) : (
          <>
            <Banner tone="info" title="This file isn't here now">
              {last && last.hash === null ? `It was deleted ${ago(now, last.at)} by ${authorWords(last.by)}. ` : ""}
              Its history is below, for who wrote it and when. A version's text is read from its file, so none can be read or restored while the file isn't here.
            </Banner>
            {history}
          </>
        )}
      </>
    );
  }

  const { file, text } = read;
  const choices = pinChoices(file, view?.agents ?? []);
  const destination = normalizePath(to);
  const moveProblem = pathProblem(area, to, view?.files ?? [], path);
  const toggle = (which: "pins" | "move"): void => {
    setForm((shown) => (shown === which ? "none" : which));
    setTo(path);
    setMoveRefused(null);
  };
  return (
    <>
      {head}
      <Seg
        label={`What shows of ${name}`}
        value={inHistory ? "history" : "text"}
        options={TABS}
        onChange={(next) => {
          setTab(next);
          setRestored(null);
          if (next === "text" && version !== null) show(null);
        }}
      />
      {inHistory ? (
        history
      ) : draft !== null ? (
        editing(draft)
      ) : (
        <div class="lah-stack" data-lah-file={path}>
          <div class="lah-actions" data-lah-file-actions>
            <Button
              icon="edit"
              onClick={() => {
                setForm("none");
                putDraft(app, key, { base: file.hash, from: text, text });
              }}
            >
              Edit
            </Button>
            <CopyButton text={text} label={`Copy the text of ${name}`} size="md" variant="secondary">
              Copy
            </CopyButton>
            <Button icon="pin" busy={acting} label={choices.main ? "Stop always giving this file to the main agent" : "Always give this file to the main agent: it is put in its prompt at every reply"} onClick={() => pin(MAIN_AGENT, !choices.main, "the main agent")}>
              {choices.main ? "Stop giving to the main agent" : "Always give to the main agent"}
            </Button>
            <Button icon="agent" expanded={form === "pins"} label="Always give this file to another agent" onClick={() => toggle("pins")}>
              Give to another agent…
            </Button>
            <Button icon="arrow-right" expanded={form === "move"} label="Move or rename this file" onClick={() => toggle("move")}>
              Move…
            </Button>
            <Button variant="danger" icon="trash" busy={acting} onClick={() => remove(file)}>
              Delete…
            </Button>
          </div>
          {form === "pins" ? (
            <div class="lah-menu" data-lah-pin-menu>
              <span class="lah-menu-note">An agent picked here is always given this file: it is put in that agent's prompt at every reply. Press one that has it to stop.</span>
              {choices.others.map((o) => (
                <Button key={o.id} icon={o.on ? "check" : "pin"} pressed={o.on} busy={acting} onClick={() => pin(o.id, !o.on, o.name)}>
                  {o.on ? `${o.name}: always given` : o.name}
                </Button>
              ))}
              {choices.others.length === 0 ? <span class="lah-menu-note">There is no other agent to give it to.</span> : null}
            </div>
          ) : null}
          {form === "move" ? (
            <div class="lah-menu" data-lah-move>
              <Field label="Its new path, within this area" for={moveId} error={destination === path ? null : (moveProblem ?? moveRefused)} help="A rename and a move are the same: the file takes the new path. Its text goes with it, and so does who is always given it.">
                <input
                  id={moveId}
                  class="lah-input lah-mono"
                  autocomplete="off"
                  spellcheck={false}
                  value={to}
                  aria-invalid={destination !== path && moveProblem !== null ? true : undefined}
                  onInput={(event) => {
                    setTo(event.currentTarget.value);
                    setMoveRefused(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && moveProblem === null) move(file);
                  }}
                />
              </Field>
              <div class="lah-actions">
                <Button variant="primary" icon="check" busy={acting} disabled={moveProblem !== null} onClick={() => move(file)}>
                  Move
                </Button>
                <Button icon="close" onClick={() => setForm("none")}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          <p class="lah-line" data-lah-pins-line>
            <Icon name="pin" size={14} />
            <span>{pinnedWords(file, view?.agents ?? [])}</span>
          </p>
          {text === "" ? (
            <p class="lah-lead">This file is empty.</p>
          ) : (
            <pre class="lah-text lah-ws-text" data-lah-file-text>
              {text}
            </pre>
          )}
        </div>
      )}
    </>
  );
}
