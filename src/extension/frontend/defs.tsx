// What the three Library pages share (DESIGN §13): the definitions as last read, read once for all
// three and again whenever one changes; the edits not saved yet, held for as long as the tab lives,
// so leaving a definition, or the page, loses none of them; and the frame the Agents and Skills
// pages are both drawn in, a list beside the one open (one column with Back on a phone), with
// everything that is the same for an agent and a skill: the filter, making and copying one, saving,
// switching off, deleting and resetting.

import type { ComponentType } from "preact";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { DefsView, Skill, UiProblem } from "../../shared/ui";
import { type App, errorWords, useApp } from "./app";
import { UiRequestError } from "./client";
import { Badge, Banner, Button, Editor, Empty, Field, IconButton, SearchField, Section, useBusy } from "./components";
import { type AgentDraft, copyId, countWords, type Def, filterDefs, idProblem, type KindWords, newKey, ownProblems, removeAsk, savedWords, saveLabel, saveStatus, sourceWords, standingWords, titleOf } from "./defs-model";
import { Icon, type IconName } from "./icons";
import { revealInScroller } from "./scroll";
import { createStore, type Store, useSelect } from "./store";

/** The definitions as last read: the view (null until a read has answered), whether a read is under way, and why the last one failed (null: it didn't). */
export interface DefsRead {
  view: DefsView | null;
  reading: boolean;
  failed: string | null;
}

/** What the Library pages keep between them. */
export interface Library {
  read: Store<DefsRead>;
  /** The edits not saved yet, each under its definition's id, or under the key of one being made. */
  agents: Store<ReadonlyMap<string, AgentDraft>>;
  skills: Store<ReadonlyMap<string, Skill>>;
  /** Which read was asked for last: the answer to an older one is dropped. */
  asked: number;
  /** How many definitions were started here, for the keys of those not saved yet. */
  made: number;
}

// One for each app, kept beside it rather than in a page's own state: the shell shows one page at a
// time and unmounts the rest, and what a page held must still be there when the user comes back.
const LIBRARIES = new WeakMap<App, Library>();

export function libraryOf(app: App): Library {
  let held = LIBRARIES.get(app);
  if (!held) {
    held = { read: createStore<DefsRead>({ view: null, reading: false, failed: null }), agents: createStore<ReadonlyMap<string, AgentDraft>>(new Map()), skills: createStore<ReadonlyMap<string, Skill>>(new Map()), asked: 0, made: 0 };
    LIBRARIES.set(app, held);
  }
  return held;
}

/**
 * The definitions, read when a Library page shows, again whenever one changes anywhere (the state's
 * counter moves) and when the page comes back from being away. `take` is for a change's answer,
 * which is the definitions as they then stand: a read asked for before it is no longer wanted.
 */
export function useDefs(): { read: DefsRead; again(): void; take(view: DefsView): void } {
  const app = useApp();
  const library = libraryOf(app);
  const read = useSelect(library.read, (r) => r);
  const moved = useSelect(app.client.state, (s) => s?.defs ?? null);
  const again = (): void => {
    library.asked += 1;
    const mine = library.asked;
    library.read.update((r) => ({ ...r, reading: true }));
    app.client.request("lah.defs.get", {}).then(
      (view) => mine === library.asked && library.read.set({ view, reading: false, failed: null }),
      (error: unknown) => mine === library.asked && library.read.update((r) => ({ ...r, reading: false, failed: errorWords(error) })),
    );
  };
  useEffect(again, [moved]);
  useEffect(() => app.client.onBack(again), []);
  return {
    read,
    again,
    take: (view) => {
      library.asked += 1;
      library.read.set({ view, reading: false, failed: null });
    },
  };
}

/** What stands in for a Library page until the definitions have been read once, or when they couldn't be. */
export function DefsUnread(props: { failed: string | null; again(): void }) {
  if (props.failed === null) return <Empty icon="hourglass">Reading the definitions…</Empty>;
  return (
    <Empty
      icon="alert"
      title="The definitions couldn't be read"
      action={
        <Button icon="refresh" onClick={props.again}>
          Try again
        </Button>
      }
    >
      {props.failed}
    </Empty>
  );
}

/** Says that what a Library page shows may be out of date, where the definitions couldn't be read again. */
export function DefsStale(props: { read: DefsRead; again(): void }) {
  if (props.read.failed === null) return null;
  return (
    <Banner
      tone="warn"
      title="These may be out of date"
      actions={
        <Button icon="refresh" busy={props.read.reading} onClick={props.again}>
          Read again
        </Button>
      }
    >
      {`The definitions couldn't be read again: ${props.read.failed}`}
    </Banner>
  );
}

/** What a definition's edits have, whatever its kind. */
interface DraftHead {
  id: string;
  name: string;
  description: string;
}

/** What a kind's own fields are given. */
export interface KindFieldsProps<V, D> {
  draft: D;
  /** The definition as it is kept; null for one being made. */
  saved: V | null;
  view: DefsView;
  /** A save is under way: the fields rest. */
  busy: boolean;
  /** What the backend refused of the last save that isn't about the id, the name or the description. */
  problems: readonly UiProblem[];
  onChange(next: D): void;
}

/** A kind of definition the frame shows: an agent or a skill, as `V` when kept and as `D` while edited. */
export interface DefKind<V extends Def, D extends DraftHead> {
  /** What the requests call it. */
  kind: "agent" | "skill";
  /** Where `Nav.def` keeps the one open. */
  nav: "agents" | "skills";
  words: KindWords;
  icon: IconName;
  drafts(app: App): Store<ReadonlyMap<string, D>>;
  list(view: DefsView): readonly V[];
  draftOf(saved: V): D;
  fresh(view: DefsView): D;
  copy(shown: D, id: string): D;
  same(a: D, b: D): boolean;
  /** Sends edits to be kept; answers the definitions as they then stand. */
  save(app: App, draft: D): Promise<DefsView>;
  /** What the kind is, said above the list and where nothing is open. */
  about: string;
  help: { newId: string; madeId: string; name: string; description: string };
  /** The fields that are this kind's own, under the ones every definition has. */
  Fields: ComponentType<KindFieldsProps<V, D>>;
}

/** What the backend said of a save it refused, and of which definition. */
interface Refused {
  key: string;
  message: string;
  problems: readonly UiProblem[];
}

function DefRow(props: { open: boolean; title: string; id: string; standing: string; opening: string; off: boolean; unsaved: boolean; row: string; onOpen(): void }) {
  return (
    <button type="button" class="lah-navrow" aria-current={props.open} data-lah-def={props.row} data-off={props.off || undefined} onClick={props.onOpen}>
      <span class="lah-navrow-text">
        <span class="lah-navrow-title lah-inline">
          <span>{props.title}</span>
          {props.off ? <Badge>off</Badge> : null}
          {props.unsaved ? <Badge tone="warn">not saved</Badge> : null}
        </span>
        <span class="lah-navrow-sub">
          <code>{props.id}</code>
          {` · ${props.standing}`}
        </span>
        <span class="lah-defs-opening">{props.opening}</span>
      </span>
      <Icon name="chevron-right" size={16} class="lah-chev" />
    </button>
  );
}

function DefDetail<V extends Def, D extends DraftHead>(props: {
  kind: DefKind<V, D>;
  view: DefsView;
  saved: V | null;
  draft: D;
  dirty: boolean;
  taken: readonly string[];
  refused: Refused | null;
  saving: boolean;
  acting: boolean;
  onBack(): void;
  onChange(next: D): void;
  onSave(): void;
  onDiscard(): void;
  onCopy(): void;
  onSwitch(off: boolean): void;
  onRemove(): void;
}) {
  const { kind: k, saved, draft } = props;
  const idBox = useId();
  const nameBox = useId();
  const descriptionBox = useId();
  const idWrong = saved === null ? idProblem(draft.id, props.taken) : null;
  const { own, rest } = ownProblems(props.refused?.problems ?? [], ["id", "name", "description"]);
  const named = draft.name.trim() !== "" || draft.id !== "";
  const removal = saved !== null && saved.source === "user" ? removeAsk(saved, k.words, props.dirty) : null;
  return (
    <>
      <div class="lah-pane-head">
        <span class="lah-back">
          <IconButton icon="chevron-left" label={`Back to the ${k.words.many}`} onClick={props.onBack} />
        </span>
        <span class="lah-pane-title">
          <strong class="lah-h">{named ? titleOf(draft) : `New ${k.words.one}`}</strong>
          <span class="lah-dim lah-small">{saved !== null ? `${saved.id} · ${sourceWords(saved)}` : "new, not saved"}</span>
        </span>
        {saved?.off ? <Badge>off</Badge> : null}
        {props.dirty ? <Badge tone="warn">not saved</Badge> : null}
      </div>
      {saved?.off ? (
        <Banner tone="warn" title="Switched off">
          {k.words.off}
        </Banner>
      ) : null}
      <p class="lah-line" data-lah-standing>
        <Icon name="info" size={14} />
        <span>{standingWords(saved, k.words)}</span>
      </p>
      {saved !== null ? (
        <div class="lah-actions" data-lah-def-actions>
          <Button icon="copy" onClick={props.onCopy}>
            Copy
          </Button>
          <Button icon="power" disabled={props.acting} onClick={() => props.onSwitch(!saved.off)}>
            {saved.off ? "Switch on" : "Switch off"}
          </Button>
          {removal !== null ? (
            <Button variant="danger" icon={saved.over === undefined ? "trash" : "undo"} disabled={props.acting} onClick={props.onRemove}>
              {removal.label}
            </Button>
          ) : null}
        </div>
      ) : null}
      <Section title={`What this ${k.words.one} is`} id="what">
        {saved === null ? (
          <Field label="Id" for={idBox} help={k.help.newId} error={own.get("id") ?? (draft.id !== "" ? idWrong : null)}>
            <input id={idBox} class="lah-input lah-mono" value={draft.id} autocomplete="off" autocapitalize="none" spellcheck={false} aria-invalid={(draft.id !== "" && idWrong !== null) || own.has("id") || undefined} disabled={props.saving} onInput={(event) => props.onChange({ ...draft, id: event.currentTarget.value })} />
          </Field>
        ) : (
          <Field label="Id" help={k.help.madeId} error={own.get("id")}>
            <code class="lah-code">{saved.id}</code>
          </Field>
        )}
        <Field label="Name" for={nameBox} help={k.help.name} error={own.get("name")}>
          <input id={nameBox} class="lah-input" value={draft.name} autocomplete="off" aria-invalid={own.has("name") || undefined} disabled={props.saving} onInput={(event) => props.onChange({ ...draft, name: event.currentTarget.value })} />
        </Field>
        <Field label="Description" for={descriptionBox} help={k.help.description} error={own.get("description")}>
          <Editor id={descriptionBox} label="Description" prose rows={3} value={draft.description} invalid={own.has("description")} disabled={props.saving} onInput={(description) => props.onChange({ ...draft, description })} />
        </Field>
      </Section>
      <k.Fields draft={draft} saved={saved} view={props.view} busy={props.saving} problems={rest} onChange={props.onChange} />
      <div class="lah-defs-save" data-lah-save data-state={props.refused !== null ? "refused" : props.dirty ? "unsaved" : "saved"} role="group" aria-label={`Save this ${k.words.one}`}>
        <span class="lah-defs-save-text" role="status">
          {props.refused !== null ? <Icon name="alert" size={16} /> : null}
          <span>{saveStatus({ made: saved !== null, dirty: props.dirty, refused: props.refused?.message ?? null, idWrong }, k.words)}</span>
        </span>
        <span class="lah-actions">
          <Button variant="primary" icon="check" busy={props.saving} disabled={!props.dirty || idWrong !== null} onClick={props.onSave}>
            {saveLabel(saved, k.words)}
          </Button>
          <Button icon="close" disabled={!props.dirty || props.saving} onClick={props.onDiscard}>
            {saved === null ? "Discard" : "Discard edits"}
          </Button>
        </span>
      </div>
    </>
  );
}

/** The Agents page and the Skills page: the kind's definitions as a list, and the one open beside it. */
export function DefsFrame<V extends Def, D extends DraftHead>(props: { kind: DefKind<V, D> }) {
  const k = props.kind;
  const app = useApp();
  const library = libraryOf(app);
  const { read, again, take } = useDefs();
  const store = k.drafts(app);
  const drafts = useSelect(store, (all) => all);
  const openKey = useSelect(app.nav, (n) => n.def[k.nav]);
  const [query, setQuery] = useState("");
  const [refused, setRefused] = useState<Refused | null>(null);
  const [saving, runSave] = useBusy();
  const [acting, runAct] = useBusy();
  const listPane = useRef<HTMLDivElement>(null);
  const detailPane = useRef<HTMLDivElement>(null);
  /** The one that was open last, so the list comes back at its row. */
  const left = useRef<string | null>(null);
  const view = read.view;
  const defs = view !== null ? k.list(view) : [];
  const saved = openKey !== null ? (defs.find((d) => d.id === openKey) ?? null) : null;
  const draft = openKey !== null ? (drafts.get(openKey) ?? null) : null;
  const shown = draft ?? (saved !== null ? k.draftOf(saved) : null);
  const shownKey = shown !== null ? openKey : null;
  const open = (key: string | null): void => app.nav.update((n) => ({ ...n, def: { ...n.def, [k.nav]: key } }));
  // One picked from the list starts at its head: the panel may be scrolled far down the list, or down the one shown before it. Back in the list, the row left is where the eye is.
  useLayoutEffect(() => {
    if (shownKey !== null) revealInScroller(detailPane.current, "start");
    else if (left.current !== null) revealInScroller(listPane.current?.querySelector(`[data-lah-def="${CSS.escape(left.current)}"]`) ?? null, "center");
    left.current = shownKey;
  }, [shownKey]);
  // What is open names nothing any more (deleted on another page of the user's, or being made on a page since reloaded): the list shows instead.
  const gone = view !== null && !read.reading && openKey !== null && shown === null;
  useEffect(() => {
    if (gone) open(null);
  }, [gone]);
  // A refused save marks the fields it is about: the first of them comes into view.
  useLayoutEffect(() => {
    if (refused !== null) revealInScroller(detailPane.current?.querySelector(".lah-field-error") ?? null, "center");
  }, [refused]);
  if (view === null)
    return (
      <div class="lah-stack" data-lah-view={k.nav}>
        <DefsUnread failed={read.failed} again={again} />
      </div>
    );

  const ids = defs.map((d) => d.id);
  const news = [...drafts].filter(([key]) => !ids.includes(key));
  const kept = filterDefs(defs, query);
  const said = refused !== null && refused.key === openKey ? refused : null;
  const setDraft = (key: string, next: D | null): void =>
    store.update((all) => {
      const map = new Map(all);
      if (next === null) map.delete(key);
      else map.set(key, next);
      return map;
    });
  const start = (made: D): void => {
    library.made += 1;
    const key = newKey(library.made);
    setDraft(key, made);
    open(key);
  };
  const change = (next: D): void => {
    if (openKey === null) return;
    const undone = saved !== null && k.same(next, k.draftOf(saved));
    setDraft(openKey, undone ? null : next);
    if (undone) setRefused(null);
  };
  const save = (): void =>
    runSave(async () => {
      if (openKey === null || shown === null) return;
      try {
        const next = await k.save(app, shown);
        take(next);
        setDraft(openKey, null);
        setRefused(null);
        open(shown.id);
        app.toast(savedWords(saved, titleOf(shown)));
      } catch (error) {
        // The bar that saves says why, and stays in view; a toast as well would only cover it.
        setRefused({ key: openKey, message: errorWords(error), problems: error instanceof UiRequestError ? error.problems : [] });
      }
    });
  const discard = (): void =>
    runAct(async () => {
      if (openKey === null || shown === null) return;
      const agreed = await app.host.confirm(
        saved === null
          ? { title: `Discard this new ${k.words.one}?`, message: "It was never saved, so what you typed for it is lost.", confirm: "Discard", danger: true }
          : { title: `Discard your edits to ${titleOf(saved)}?`, message: "It goes back to how it was last saved. What you typed since is lost.", confirm: "Discard", danger: true },
      );
      if (!agreed) return;
      setDraft(openKey, null);
      setRefused(null);
      if (saved === null) open(null);
    });
  const flip = (off: boolean): void =>
    runAct(async () => {
      if (saved === null) return;
      try {
        take(await app.client.request("lah.def.switch", { kind: k.kind, id: saved.id, off }));
        app.toast(`${titleOf(saved)} is ${off ? "off" : "on"}.`);
      } catch (error) {
        app.fail(error);
      }
    });
  const remove = (): void =>
    runAct(async () => {
      if (saved === null) return;
      const ask = removeAsk(saved, k.words, draft !== null);
      const agreed = await app.host.confirm({ title: ask.title, message: ask.message, confirm: ask.confirm, danger: true });
      if (!agreed) return;
      try {
        take(await app.client.request("lah.def.remove", { kind: k.kind, id: saved.id }));
        setDraft(saved.id, null);
        setRefused(null);
        // One that was the user's alone is gone; one that stood over an original shows that original now.
        if (saved.over === undefined) open(null);
        app.toast(ask.done);
      } catch (error) {
        app.fail(error);
      }
    });
  const q = query.trim();
  return (
    <div class="lah-split" data-lah-view={k.nav} data-pane={shown !== null ? "detail" : "list"}>
      <div class="lah-split-list" ref={listPane}>
        <div class="lah-defs-bar">
          <SearchField value={query} label={`Filter the ${k.words.many}`} placeholder={`Filter the ${k.words.many}`} status={q === "" ? undefined : `${kept.length} of ${defs.length} shown`} onInput={setQuery} />
          <Button icon="plus" label={`Make a new ${k.words.one}`} onClick={() => start(k.fresh(view))}>
            New
          </Button>
        </div>
        <DefsStale read={read} again={again} />
        <p class="lah-lead lah-small">{k.about}</p>
        {news.length + defs.length === 0 ? (
          <Empty icon={k.icon} title={`No ${k.words.one} yet`}>
            {`New makes the first ${k.words.one} of yours.`}
          </Empty>
        ) : (
          <>
            <p class="lah-lead lah-small" data-lah-def-count>{`${countWords(defs, k.words)}.`}</p>
            {news.length + kept.length === 0 ? (
              <Empty icon="search" title="Nothing matches">
                {`No ${k.words.one} holds “${q}”. The filter reads names, ids, descriptions and where each comes from.`}
              </Empty>
            ) : (
              <div class="lah-navlist" data-lah-defs>
                {news.map(([key, made]) => (
                  <DefRow key={key} row={key} open={key === openKey} title={made.name.trim() !== "" || made.id !== "" ? titleOf(made) : `New ${k.words.one}`} id={made.id !== "" ? made.id : "no id yet"} standing="new" opening={made.description.trim() !== "" ? made.description : "No description yet."} off={false} unsaved onOpen={() => open(key)} />
                ))}
                {kept.map((def) => (
                  <DefRow key={def.id} row={def.id} open={def.id === openKey} title={titleOf(def)} id={def.id} standing={sourceWords(def)} opening={def.description.trim() !== "" ? def.description : "No description."} off={def.off} unsaved={drafts.has(def.id)} onOpen={() => open(def.id)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div class="lah-split-detail" ref={detailPane}>
        {shown !== null && openKey !== null ? (
          <DefDetail
            key={openKey}
            kind={k}
            view={view}
            saved={saved}
            draft={shown}
            dirty={draft !== null}
            taken={ids}
            refused={said}
            saving={saving}
            acting={acting}
            onBack={() => open(null)}
            onChange={change}
            onSave={save}
            onDiscard={discard}
            onCopy={() => start(k.copy(shown, copyId(shown.id, [...ids, ...news.map(([, made]) => made.id)])))}
            onSwitch={flip}
            onRemove={remove}
          />
        ) : (
          <Empty icon={k.icon} title={`Pick ${k.words.a}`}>
            {k.about}
          </Empty>
        )}
      </div>
    </div>
  );
}
