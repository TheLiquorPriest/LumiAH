// Settings (DESIGN §8): every setting the backend has and every text it sends a model. The settings'
// forms are built from the backend's own schema (`settings-model.ts`), so a setting added there
// shows here with no change to this page: the agents (connection, model, effort, budgets, tools),
// the history cutoff, who writes the reply, and whatever else the schema holds. Beside them: the
// texts by group, this device's own choices, and a backup of everything changed. A search finds a
// setting or a text by its name, its help, its place or its value. One column on a phone (the list,
// then what was picked, with Back); the list beside it where there is room.

import { type ComponentChildren, Fragment } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JsonValue, ModelChoice, SettingPath, TextDef } from "../../../shared/ui";
import { type App, errorWords, PREF_NUMBERS, PREF_SWITCHES, type Prefs, defaultPrefs, useApp } from "../app";
import { UiRequestError } from "../client";
import { Badge, Banner, Button, Check, Disclosure, Empty, IconButton, NumberField, SearchField, Section, Switch, useBusy } from "../components";
import { useRuntimeConnections } from "../connections";
import { clock, count, counted } from "../format";
import { Icon } from "../icons";
import { revealInScroller } from "../scroll";
import { allSections, backupJson, backupOf, besideNumber, changedCount, changesOf, foldHolds, foldOf, formOf, navOf, type NavSection, pathKey, problemsByPath, searchSettings, sectionAt, sectionFor, settingPlace, startHere, valueAt, valueWords } from "../settings-model";
import { createStore, type Store, useSelect } from "../store";
import { FieldNode, Fields, type FormCtx } from "./settings-form";
import { TextEditor, TextList } from "./texts";
import { TimeoutsPane } from "./timeouts";

const DETAILS = new WeakMap<App, Store<boolean>>();

/** Whether an app's Settings show each setting's key: asked for once, for every section, and kept while the pages live (the page's own state goes when the page bar shows another page). */
function detailsOf(app: App): Store<boolean> {
  let store = DETAILS.get(app);
  if (!store) {
    store = createStore(false);
    DETAILS.set(app, store);
  }
  return store;
}

/** What Settings shows beside its list. */
type Chosen = { kind: "section"; key: string } | { kind: "texts"; group: string } | { kind: "text"; id: string } | { kind: "timeouts" } | { kind: "device" } | { kind: "backup" };

function PaneHead(props: { title: string; sub?: string | null; onBack(): void; back: string; aside?: ComponentChildren }) {
  return (
    <div class="lah-pane-head">
      <span class="lah-back">
        <IconButton icon="chevron-left" label={props.back} onClick={props.onBack} />
      </span>
      <span class="lah-pane-title">
        <strong class="lah-h">{props.title}</strong>
        {props.sub ? <span class="lah-lead lah-small">{props.sub}</span> : null}
      </span>
      {props.aside}
    </div>
  );
}

/** The texts a search finds: those whose label, id, note or text (the user's own, else the default) holds each of the query's words. */
function searchTexts(defs: readonly TextDef[], own: Readonly<Record<string, string>>, query: string): TextDef[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return [];
  return defs.filter((d) => {
    const hay = [d.label, d.id, d.group, d.note, own[d.id] ?? d.text].join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** This device's own choices: kept in this browser, not with the user's settings. */
function DevicePane() {
  const app = useApp();
  const prefs = useSelect(app.prefs, (p) => p);
  const defaults = defaultPrefs();
  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]): void => app.prefs.update((p) => ({ ...p, [key]: value }));
  return (
    <>
      <p class="lah-lead">How the pages behave on this device. These are kept in this browser, so another device has its own.</p>
      <div class="lah-set-group" data-lah-group="device">
        {(Object.keys(PREF_NUMBERS) as (keyof typeof PREF_NUMBERS)[]).map((key) => {
          const def = PREF_NUMBERS[key];
          return (
            <div key={key} class="lah-set-row" data-lah-pref={key}>
              <div class="lah-set-about">
                <div class="lah-set-row-head">
                  <span class="lah-set-label">{def.label}</span>
                  {prefs[key] !== defaults[key] ? <Badge tone="accent">changed</Badge> : null}
                </div>
                <p class="lah-field-help">{def.help}</p>
              </div>
              <div class="lah-set-edit">
                <div class="lah-set-control">
                  <NumberField label={def.label} value={prefs[key]} min={def.min} max={def.max} step={def.step} integer onChange={(value) => set(key, value)} />
                  <span class="lah-set-unit">{besideNumber(prefs[key], def.unit)}</span>
                </div>
                {prefs[key] !== defaults[key] ? (
                  <div class="lah-actions">
                    <Button size="sm" variant="ghost" icon="undo" onClick={() => set(key, defaults[key])}>{`Default: ${count(defaults[key])}`}</Button>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
        {(Object.keys(PREF_SWITCHES) as (keyof typeof PREF_SWITCHES)[]).map((key) => (
          <div key={key} class="lah-set-row lah-is-wide" data-lah-pref={key}>
            <div class="lah-set-edit">
              <Switch checked={prefs[key]} label={PREF_SWITCHES[key].label} help={PREF_SWITCHES[key].help} onChange={(on) => set(key, on)} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export function SettingsPage() {
  const app = useApp();
  const settings = useSelect(app.client.state, (s) => s?.settings ?? null);
  const texts = useSelect(app.client.state, (s) => s?.texts ?? null);
  const connections = useRuntimeConnections();
  const form = useMemo(() => (settings ? formOf(settings) : null), [settings]);
  const nav = useMemo(() => (form ? navOf(form) : []), [form]);
  const sections = useMemo(() => allSections(nav), [nav]);
  const starts = useMemo(() => startHere(nav), [nav]);
  const groups = useMemo(() => [...new Set((texts?.defs ?? []).map((d) => d.group))], [texts]);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map());
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [refused, setRefused] = useState<{ id: string; message: string } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [pasted, setPasted] = useState("");
  const [fresh, setFresh] = useState(false);
  const [saving, setSaving] = useState(0);
  const [textBusy, runText] = useBusy();
  const [bulkBusy, runBulk] = useBusy();
  const detail = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  /** Saves wait their turn here, so two changes made in quick succession are both kept, in order. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const modelLists = useRef(new Map<string, Promise<ModelChoice[]>>());
  // A section picked from the list starts at its head: the panel may be scrolled far down the one shown before it or, in one column, far down the list.
  const [picked, setPicked] = useState(0);
  const details = useSelect(detailsOf(app), (on) => on);
  /** The user's own opening or closing of a section's folded part: it holds for that section and that lead, so a new lead into the fold opens it again. */
  const [more, setMore] = useState<{ key: string; found: string | null; open: boolean } | null>(null);
  useLayoutEffect(() => {
    if (picked > 0 && found === null) revealInScroller(detail.current, "start");
  }, [picked]);
  // The search led to a setting: it comes into view once its section shows.
  useLayoutEffect(() => {
    if (found !== null && detail.current) revealInScroller(detail.current.querySelector("[data-lah-found]"), "center");
  }, [found, chosen]);
  // The connections changed, or are another runtime's: a connection's models may have, too.
  useEffect(() => modelLists.current.clear(), [connections.view]);
  // The tools' names, for the tables that hold a row per tool: read when the page shows and again when a definition changes. Where they can't be read a name is typed instead.
  const defsRev = useSelect(app.client.state, (s) => s?.defs ?? 0);
  const [tools, setTools] = useState<readonly string[] | null>(null);
  useEffect(() => {
    let live = true;
    app.client.request("lah.defs.get", {}).then(
      (r) => live && setTools(r.tools.map((t) => t.name)),
      () => live && setTools(null),
    );
    return () => {
      live = false;
    };
  }, [defsRev]);
  // Another page led here to one setting (a cap to its limit, a kind of stored thing to how long it is kept): its section opens with it marked, and the lead is taken so coming back later opens nothing by itself.
  const led = useSelect(app.nav, (n) => n.setting);
  useEffect(() => {
    if (led === null || nav.length === 0 || !settings) return;
    // A page names a setting by its place among the core's own or the transport's: here it is found where these settings keep it.
    const placed = settingPlace(settings.schema, led) ?? [...led];
    const target = sectionFor(nav, placed) ?? sectionAt(nav, placed);
    if (target) {
      setFound(pathKey(placed));
      setChosen({ kind: "section", key: target.key });
      setOpened(true);
    } else {
      // A lead that names nothing here is said, never dropped: the page would otherwise open on its first section as if that were the answer.
      app.toast("That setting isn't among the settings shown here. Search for it by its name.", "error");
    }
    app.nav.update((n) => ({ ...n, setting: null }));
  }, [led, nav]);
  if (!settings || !texts || !form) return <Empty icon="hourglass">Reading the settings…</Empty>;

  const save = (set: { path: SettingPath; value: JsonValue }[], reset: SettingPath[] = []): Promise<boolean> => {
    setSaving((n) => n + 1);
    setStatus("Saving…");
    const run = queue.current.then(async () => {
      try {
        const result = await app.client.request("lah.settings.set", { set, reset });
        app.client.patch({ settings: result.settings });
        setProblems(new Map());
        setStatus(`Saved at ${clock(app.now())}.`);
        return true;
      } catch (error) {
        const refusals = error instanceof UiRequestError ? error.problems : [];
        setProblems(problemsByPath(form, refusals));
        setStatus(refusals.length > 0 ? "Not saved: see the setting marked below." : "Not saved.");
        // A control shows what was pressed until the settings answer; after a refusal the form is drawn again from what is kept.
        setFormKey((n) => n + 1);
        app.fail(error);
        return false;
      } finally {
        setSaving((n) => n - 1);
      }
    });
    queue.current = run;
    return run;
  };
  const ctx: FormCtx = {
    save: (set, reset) => void save(set, reset),
    busy: bulkBusy,
    problems,
    connections,
    found,
    details,
    at: (path) => valueAt(settings.values, path),
    ...(tools !== null ? { tools } : {}),
    models: (connectionId) => {
      const relay = connections.view?.relay.id;
      const key = `${relay ?? ""} ${connectionId ?? ""}`;
      let list = modelLists.current.get(key);
      if (!list) {
        list = app.client.request("lah.connections.models", { ...(relay !== undefined ? { relay } : {}), connectionId }).then((r) => r.models);
        modelLists.current.set(key, list);
        // A list that couldn't be read is asked for again next time.
        list.catch(() => modelLists.current.delete(key));
      }
      return list;
    },
  };
  const open = (next: Chosen): void => {
    setChosen(next);
    setOpened(true);
    setPicked((n) => n + 1);
  };
  // Beside the list (where there is room for both), the first thing most people change shows until something is picked.
  const first = starts[0]?.section ?? sections[0];
  const shown: Chosen = chosen ?? (first ? { kind: "section", key: first.key } : { kind: "device" });
  const section = shown.kind === "section" ? (sections.find((s) => s.key === shown.key) ?? null) : null;
  const text = shown.kind === "text" ? (texts.defs.find((d) => d.id === shown.id) ?? null) : null;
  const ownCount = Object.keys(texts.own).length;
  const changedAll = changedCount(form);
  // An agent's section opens on its connection and model; the rest is folded, and opens by itself where a search or another page led to a setting inside it.
  const fold = section !== null ? foldOf(section.node) : null;
  const moreOpen = section !== null && fold !== null && (more !== null && more.key === section.key && more.found === found ? more.open : found !== null && foldHolds(fold, found));
  const sectionProblem = section !== null ? (problems.get(pathKey(section.node.path)) ?? null) : null;

  const saveText = (def: TextDef, body: string): void =>
    runText(async () => {
      try {
        const result = await app.client.request("lah.text.set", { id: def.id, text: body });
        app.client.patch({ texts: result.texts });
        setDrafts(({ [def.id]: _saved, ...rest }) => rest);
        setRefused(null);
        app.toast(`Saved ${def.label}.`);
      } catch (error) {
        setRefused({ id: def.id, message: errorWords(error) });
      }
    });
  const resetText = (def: TextDef): void =>
    runText(async () => {
      const agreed = await app.host.confirm({ title: `Put ${def.label} back to its default?`, message: "Your text for it is forgotten. Copy it first if you may want it again.", confirm: "Back to the default", danger: true });
      if (!agreed) return;
      try {
        const result = await app.client.request("lah.text.reset", { id: def.id });
        app.client.patch({ texts: result.texts });
        setDrafts(({ [def.id]: _dropped, ...rest }) => rest);
        setRefused(null);
        app.toast(`${def.label} is the default again.`);
      } catch (error) {
        app.fail(error);
      }
    });

  /** Puts a backup's settings and texts in: over what is there, or over the defaults when `fresh`. */
  const restore = (source: string): void =>
    runBulk(async () => {
      const backup = backupOf(source);
      if (typeof backup === "string") {
        app.toast(backup, "error");
        return;
      }
      const agreed = await app.host.confirm({
        title: "Restore this backup?",
        message: `${counted(backup.set.length, "setting")} and ${counted(Object.keys(backup.texts).length, "text")} from the backup replace what you have for them now.${fresh ? " Everything else goes back to its default first." : " What the backup doesn't name stays as it is."}`,
        confirm: "Restore",
        danger: fresh,
      });
      if (!agreed) return;
      if (!(await save(backup.set, fresh ? [[]] : []))) return;
      let failed = 0;
      if (fresh) for (const id of Object.keys(texts.own)) if (!Object.hasOwn(backup.texts, id)) await app.client.request("lah.text.reset", { id }).then((r) => app.client.patch({ texts: r.texts }), () => (failed += 1));
      for (const [id, body] of Object.entries(backup.texts)) await app.client.request("lah.text.set", { id, text: body }).then((r) => app.client.patch({ texts: r.texts }), () => (failed += 1));
      setPasted("");
      app.toast(failed > 0 ? `Restored, but ${counted(failed, "text")} couldn't be: the backup names a text this build doesn't have, or one it refuses.` : "Restored.", failed > 0 ? "error" : "info");
    });
  const resetAll = (): void =>
    runBulk(async () => {
      const agreed = await app.host.confirm({ title: "Put every setting back to its default?", message: `${counted(changedAll, "setting")} you changed ${changedAll === 1 ? "goes" : "go"} back to ${changedAll === 1 ? "its default" : "their defaults"}. Your texts stay. Save a backup first if you may want them again.`, confirm: "Reset the settings", danger: true });
      if (agreed && (await save([], [[]]))) app.toast("Every setting is its default again.");
    });
  const resetTexts = (): void =>
    runBulk(async () => {
      const agreed = await app.host.confirm({ title: "Put every text back to its default?", message: `Your own ${counted(ownCount, "text")} ${ownCount === 1 ? "is" : "are"} forgotten. Save a backup first if you may want ${ownCount === 1 ? "it" : "them"} again.`, confirm: "Reset the texts", danger: true });
      if (!agreed) return;
      let failed = 0;
      for (const id of Object.keys(texts.own)) await app.client.request("lah.text.reset", { id }).then((r) => app.client.patch({ texts: r.texts }), () => (failed += 1));
      setDrafts({});
      app.toast(failed > 0 ? `${counted(failed, "text")} couldn't be reset.` : "Every text is its default again.", failed > 0 ? "error" : "info");
    });

  const q = query.trim();
  const foundSettings = q === "" ? [] : searchSettings(form, q);
  const foundTexts = q === "" ? [] : searchTexts(texts.defs, texts.own, q);
  /** A section's row in the list; a part of a section sits in under it. */
  const sectionRow = (s: NavSection, part: boolean) => {
    const n = changedCount(s.node);
    return (
      <button key={s.key} type="button" class="lah-navrow" data-lah-nav={s.node.path.join(".") || "general"} data-part={part || undefined} aria-current={shown.kind === "section" && shown.key === s.key} onClick={() => (setFound(null), open({ kind: "section", key: s.key }))}>
        <span class="lah-navrow-text">
          <span class="lah-navrow-title">{s.node.label}</span>
          {s.node.help && !part ? <span class="lah-navrow-sub">{s.node.help}</span> : null}
        </span>
        {n > 0 ? <Badge tone="accent">{`${n} changed`}</Badge> : null}
        <Icon name="chevron-right" size={16} class="lah-chev" />
      </button>
    );
  };

  return (
    <div class="lah-split" data-lah-view="settings" data-pane={opened ? "detail" : "list"}>
      <div class="lah-split-list">
        <SearchField value={query} label="Search the settings and texts" placeholder="Search settings and texts" status={q === "" ? undefined : `${foundSettings.length + foundTexts.length} found`} onInput={setQuery} />
        {q !== "" ? (
          foundSettings.length + foundTexts.length === 0 ? (
            <Empty icon="search" title="Nothing found">
              No setting or text holds “{q}”. A search reads names, help, places and values.
            </Empty>
          ) : (
            <div class="lah-found" data-lah-found-list>
              {foundSettings.map(({ node, trail }) => (
                <button
                  key={pathKey(node.path)}
                  type="button"
                  class="lah-navrow"
                  onClick={() => {
                    setFound(pathKey(node.path));
                    open({ kind: "section", key: sectionFor(nav, node.path)?.key ?? sections[0]?.key ?? "" });
                  }}
                >
                  <span class="lah-navrow-text">
                    <span class="lah-navrow-title">{node.label}</span>
                    <span class="lah-navrow-sub">{[...trail, valueWords(node)].join(" › ")}</span>
                  </span>
                  <Icon name="chevron-right" size={16} class="lah-chev" />
                </button>
              ))}
              {foundTexts.map((def) => (
                <button key={def.id} type="button" class="lah-navrow" onClick={() => open({ kind: "text", id: def.id })}>
                  <span class="lah-navrow-text">
                    <span class="lah-navrow-title">{def.label}</span>
                    <span class="lah-navrow-sub">{`Text › ${def.group}`}</span>
                  </span>
                  <Icon name="chevron-right" size={16} class="lah-chev" />
                </button>
              ))}
            </div>
          )
        ) : (
          <nav class="lah-navlist" aria-label="Settings">
            {starts.length > 0 ? (
              <>
                <div class="lah-navhead">Most people change only these</div>
                {starts.map((start) => (
                  <button key={start.path.join(".")} type="button" class="lah-navrow" data-lah-start={start.path.join(".")} aria-current={shown.kind === "section" && shown.key === start.section.key} onClick={() => (setFound(null), open({ kind: "section", key: start.section.key }))}>
                    <span class="lah-navrow-text">
                      <span class="lah-navrow-title">{start.label}</span>
                      <span class="lah-navrow-sub">{start.about}</span>
                    </span>
                    {changedCount(start.section.node) > 0 ? <Badge tone="accent">{`${changedCount(start.section.node)} changed`}</Badge> : null}
                    <Icon name="chevron-right" size={16} class="lah-chev" />
                  </button>
                ))}
              </>
            ) : null}
            {nav.map((group) => {
              const rows = group.sections.flatMap((s) => [sectionRow(s, false), ...s.parts.map((p) => sectionRow(p, true))]);
              // Where the few settings most people change lead the list, the rest is folded under its heading until asked for; the search finds any of it either way.
              if (starts.length === 0)
                return (
                  <Fragment key={group.heading}>
                    <div class="lah-navhead">{group.heading}</div>
                    {rows}
                  </Fragment>
                );
              const changed = group.sections.reduce((n, s) => n + changedCount(s.node), 0);
              return (
                <Disclosure key={group.heading} class="lah-navfold" summary={`Every setting of ${group.heading} (${counted(rows.length, "section")}${changed > 0 ? `, ${changed} changed` : ""})`}>
                  {rows}
                </Disclosure>
              );
            })}
            <Disclosure class="lah-navfold" summary={`Every text sent to a model (${counted(texts.defs.length, "text")}${ownCount > 0 ? `, ${ownCount} yours` : ""})`} defaultOpen={starts.length === 0}>
              {groups.map((group) => {
                const defs = texts.defs.filter((d) => d.group === group);
                const n = defs.filter((d) => Object.hasOwn(texts.own, d.id)).length;
                return (
                  <button key={group} type="button" class="lah-navrow" data-lah-nav={`texts:${group}`} aria-current={(shown.kind === "texts" && shown.group === group) || (text !== null && text.group === group)} onClick={() => open({ kind: "texts", group })}>
                    <span class="lah-navrow-text">
                      <span class="lah-navrow-title">{group}</span>
                      <span class="lah-navrow-sub">{counted(defs.length, "text")}</span>
                    </span>
                    {n > 0 ? <Badge tone="accent">{`${n} yours`}</Badge> : null}
                    <Icon name="chevron-right" size={16} class="lah-chev" />
                  </button>
                );
              })}
            </Disclosure>
            <div class="lah-navhead">Waits</div>
            <button type="button" class="lah-navrow" data-lah-nav="timeouts" aria-current={shown.kind === "timeouts"} onClick={() => open({ kind: "timeouts" })}>
              <span class="lah-navrow-text">
                <span class="lah-navrow-title">Timeouts</span>
                <span class="lah-navrow-sub">Every wait in one place: the runtime, the link, tools, model calls, the store</span>
              </span>
              <Icon name="chevron-right" size={16} class="lah-chev" />
            </button>
            <div class="lah-navhead">Here</div>
            <button type="button" class="lah-navrow" data-lah-nav="device" aria-current={shown.kind === "device"} onClick={() => open({ kind: "device" })}>
              <span class="lah-navrow-text">
                <span class="lah-navrow-title">This device</span>
                <span class="lah-navrow-sub">How the pages behave in this browser</span>
              </span>
              <Icon name="chevron-right" size={16} class="lah-chev" />
            </button>
            <button type="button" class="lah-navrow" data-lah-nav="backup" aria-current={shown.kind === "backup"} onClick={() => open({ kind: "backup" })}>
              <span class="lah-navrow-text">
                <span class="lah-navrow-title">Backup and reset</span>
                <span class="lah-navrow-sub">{changedAll + ownCount === 0 ? "Everything is its default" : `${counted(changedAll, "setting")} changed, ${counted(ownCount, "text")} yours`}</span>
              </span>
              <Icon name="chevron-right" size={16} class="lah-chev" />
            </button>
          </nav>
        )}
      </div>
      <div class="lah-split-detail" ref={detail}>
        {shown.kind === "section" && section ? (
          <>
            <PaneHead title={section.node.label} sub={section.node.help} back="Back to the settings" onBack={() => setOpened(false)} />
            <div class="lah-set-head">
              <span class="lah-set-status" role="status" aria-live="polite">
                {saving > 0 ? "Saving…" : status}
              </span>
              <span class="lah-actions">
                {changedCount(section.node) > 0 ? (
                  <Button size="sm" icon="undo" onClick={() => ctx.save([], section.resets)}>
                    {`Put this section back to its defaults (${changedCount(section.node)} changed)`}
                  </Button>
                ) : null}
                <span data-lah-details={details ? "on" : "off"}>
                  <Button size="sm" variant="ghost" icon="code" pressed={details} onClick={() => detailsOf(app).set(!details)}>
                    Details
                  </Button>
                </span>
              </span>
            </div>
            {details ? <p class="lah-field-help">Each setting shows the key it is kept under, as a backup names it.</p> : null}
            {fold !== null ? (
              <Fragment key={`${section.key}:${formKey}`}>
                {sectionProblem !== null ? (
                  <span class="lah-field-error" role="alert">
                    <Icon name="alert" size={16} />
                    {sectionProblem}
                  </span>
                ) : null}
                <div class="lah-set-group" data-lah-group={section.node.path.join(".")}>
                  <Fields nodes={fold.first} ctx={ctx} />
                </div>
                <Disclosure class="lah-set-more" summary={fold.label} open={moreOpen} onToggle={(open) => setMore({ key: section.key, found, open })}>
                  <div class="lah-set-group" data-lah-more={section.node.path.join(".")}>
                    <Fields nodes={fold.more} ctx={ctx} />
                  </div>
                </Disclosure>
              </Fragment>
            ) : (
              <FieldNode key={`${section.key}:${formKey}`} node={section.node} ctx={ctx} top />
            )}
          </>
        ) : shown.kind === "texts" ? (
          <>
            <PaneHead title={shown.group} sub="Texts LumiAH sends to models. Open one to read it or to replace it with your own." back="Back to the settings" onBack={() => setOpened(false)} />
            <TextList defs={texts.defs.filter((d) => d.group === shown.group)} own={texts.own} drafts={drafts} current={null} onOpen={(id) => open({ kind: "text", id })} />
          </>
        ) : shown.kind === "text" && text ? (
          <>
            <PaneHead
              title={text.label}
              sub={`Text › ${text.group}`}
              back={`Back to ${text.group}`}
              onBack={() => open({ kind: "texts", group: text.group })}
              aside={
                <Button size="sm" variant="ghost" onClick={() => open({ kind: "texts", group: text.group })}>
                  {`All of ${text.group}`}
                </Button>
              }
            />
            <TextEditor
              key={text.id}
              def={text}
              own={texts.own[text.id]}
              draft={drafts[text.id]}
              busy={textBusy}
              refused={refused !== null && refused.id === text.id ? refused.message : null}
              onDraft={(body) => setDrafts(({ [text.id]: _before, ...rest }) => (body === undefined ? rest : { ...rest, [text.id]: body }))}
              onSave={(body) => saveText(text, body)}
              onReset={() => resetText(text)}
            />
          </>
        ) : shown.kind === "timeouts" ? (
          <>
            <PaneHead title="Timeouts" sub={saving > 0 ? "Saving…" : status || null} back="Back to the settings" onBack={() => setOpened(false)} />
            <TimeoutsPane form={form} ctx={ctx} />
          </>
        ) : shown.kind === "device" ? (
          <>
            <PaneHead title="This device" back="Back to the settings" onBack={() => setOpened(false)} />
            <DevicePane />
          </>
        ) : shown.kind === "backup" ? (
          <>
            <PaneHead title="Backup and reset" back="Back to the settings" onBack={() => setOpened(false)} />
            <Section title="Save a backup">
              <p class="lah-lead">A backup holds what you changed: {counted(changedAll, "setting")} and {counted(ownCount, "text")}. It holds nothing of the defaults, no key and no secret.</p>
              <div class="lah-actions">
                <Button icon="download" onClick={() => app.save("lumiah-settings.json", backupJson({ set: changesOf(form), texts: texts.own }, app.now()), "application/json")}>
                  Save lumiah-settings.json
                </Button>
              </div>
            </Section>
            <Section title="Restore a backup">
              <p class="lah-lead">Pick a backup file, or paste its text.</p>
              <input ref={picker} type="file" accept="application/json,.json" hidden onChange={(event) => void event.currentTarget.files?.[0]?.text().then((body) => setPasted(body))} />
              <div class="lah-actions">
                <Button icon="upload" onClick={() => picker.current?.click()}>
                  Pick a file
                </Button>
              </div>
              <textarea class="lah-input" aria-label="A backup's text" placeholder='{ "lumiah": "settings", … }' spellcheck={false} value={pasted} onInput={(event) => setPasted(event.currentTarget.value)} />
              <Check checked={fresh} label="Put everything else back to its default first" help="Off, a setting or a text the backup doesn't name stays as it is." onChange={setFresh} />
              <div class="lah-actions">
                <Button variant="primary" icon="check" busy={bulkBusy} disabled={pasted.trim() === ""} onClick={() => restore(pasted)}>
                  Restore
                </Button>
              </div>
            </Section>
            <Section title="Reset">
              <p class="lah-lead">Back to the defaults LumiAH came with. Neither touches your runtime, your key or your chats.</p>
              <div class="lah-actions">
                <Button variant="danger" icon="undo" busy={bulkBusy} disabled={changedAll === 0} onClick={resetAll}>
                  {`Reset every setting (${changedAll} changed)`}
                </Button>
                <Button variant="danger" icon="undo" busy={bulkBusy} disabled={ownCount === 0} onClick={resetTexts}>
                  {`Reset every text (${ownCount} yours)`}
                </Button>
              </div>
            </Section>
          </>
        ) : (
          <Banner tone="info">Pick what to change from the list.</Banner>
        )}
      </div>
    </div>
  );
}
