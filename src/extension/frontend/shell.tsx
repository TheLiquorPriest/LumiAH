// The tab's shell: the page bar that stays at the top, over the page chosen. Sixteen pages don't
// fit one row of a phone, so the bar is two rows (one on a wide panel): the groups, then the pages
// of the group shown (`GROUPS` in app.tsx says why these). Home is a group of one, so on it the bar
// is the groups alone: a newcomer meets five names, not sixteen. A group opens on the page of it
// the user was last on; a mark on a group or a page says something of it is under way or waits for
// them. The shell measures what the stylesheet can't know and publishes it as custom properties
// (styles/shell.ts says what each is for): where a bar sticks so nothing shows above it, how far it
// bleeds to the host panel's edges, the height the panel shows, the bar's own height, and how far
// the host's chat heads reach into the pages while they overlap them. Moved from LumiRPEngine's drawer.

import type { ComponentType } from "preact";
import { useEffect, useId, useMemo, useRef } from "preact/hooks";
import { aboutOf, type GroupId, groupOf, type PageId, ShownPagesContext, useApp } from "./app";
import { AttentionStrip } from "./attention";
import { headGutters, watchChatHeads } from "./chat-heads";
import { Button, Empty, Toasts } from "./components";
import { Icon } from "./icons";
import type { Rect } from "./layout";
import { GROUP_ICON, groupMark, type Mark, PAGE_ICON, pageMarks, shownGroups, shownPage, stripOver } from "./nav-model";
import { AgentsPage } from "./pages/agents";
import { ChroniclePage } from "./pages/chronicle";
import { GuidancePage } from "./pages/guidance";
import { HomePage } from "./pages/home";
import { JobsPage } from "./pages/jobs";
import { LivePage } from "./pages/live";
import { LorePage } from "./pages/lore";
import { RuntimePage } from "./pages/runtime";
import { SessionsPage } from "./pages/sessions";
import { SettingsPage } from "./pages/settings";
import { SkillsPage } from "./pages/skills";
import { SpendPage } from "./pages/spend";
import { TalkPage } from "./pages/talk";
import { ToolsPage } from "./pages/tools";
import { UpkeepPage } from "./pages/upkeep";
import { WorkspacePage } from "./pages/workspace";
import { scrollParent } from "./scroll";
import { useSelect } from "./store";

/** Each page's view. An extension that builds LumiAH into itself mounts these same components in its own drawer (DESIGN §21). */
export const PAGE_VIEW: Readonly<Record<PageId, ComponentType>> = { home: HomePage, live: LivePage, sessions: SessionsPage, jobs: JobsPage, talk: TalkPage, lore: LorePage, chronicle: ChroniclePage, workspace: WorkspacePage, guidance: GuidancePage, agents: AgentsPage, skills: SkillsPage, tools: ToolsPage, settings: SettingsPage, spend: SpendPage, upkeep: UpkeepPage, runtime: RuntimePage };

const MARK_WORDS: Readonly<Record<Mark, string>> = { busy: "something is under way", needs: "needs you" };

function MarkDot(props: { mark: Mark | null | undefined }) {
  if (!props.mark) return null;
  return <span class={props.mark === "busy" ? "lah-pulse lah-pages-dot" : "lah-dot lah-is-warn lah-pages-dot"} role="img" aria-label={MARK_WORDS[props.mark]} />;
}

/**
 * The shell. `pages`, where given, are the only pages it shows (in their usual groups and order; a
 * group none of whose pages is given isn't shown): an extension that builds LumiAH into itself
 * leaves out what it has no use for, or what its own drawer already shows.
 */
export function Shell(props: { pages?: readonly PageId[] }) {
  const app = useApp();
  const only = props.pages;
  const groups = useMemo(() => shownGroups(only), [only]);
  const asked = useSelect(app.nav, (n) => n.page);
  // The page shown is one the shell has: where something leads to one it was not given, its first stands in.
  const page = shownPage(groups, asked);
  const group = groups.find((g) => g.pages.some((p) => p.id === page))?.id ?? groupOf(page);
  const connection = useSelect(app.client.connection, (c) => c);
  const ready = useSelect(app.client.state, (s) => s !== null);
  const state = useSelect(app.client.state, (s) => s);
  const marks = pageMarks(state);
  const coarse = useSelect(app.host.coarse, (c) => c);
  const open = useSelect(app.host.drawerOpen, (o) => o);
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  /** The chat heads as last measured; none while the drawer is closed. */
  const heads = useRef<readonly Rect[]>([]);
  /** Measures again. */
  const relayout = useRef<() => void>(() => {});
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // A percentage min-height can't fill the host's panel: our root's height is its content's. The
    // panel that scrolls us is found again once the host moves the tab elsewhere.
    let scroller: HTMLElement | null = null;
    const observer = new ResizeObserver(() => apply());
    const apply = (): void => {
      const gutters = headGutters(app.host.measure(el), heads.current);
      el.style.setProperty("--lah-gutter-l", `${gutters.left}px`);
      el.style.setProperty("--lah-gutter-r", `${gutters.right}px`);
      if (bar.current) el.style.setProperty("--lah-bar-h", `${bar.current.offsetHeight}px`);
      if (!scroller?.contains(el)) {
        if (scroller) observer.unobserve(scroller);
        scroller = scrollParent(el);
        if (scroller) observer.observe(scroller);
      }
      if (!scroller) return;
      const style = getComputedStyle(scroller);
      const top = parseFloat(style.paddingTop) || 0;
      const fill = scroller.clientHeight - top - (parseFloat(style.paddingBottom) || 0);
      el.style.setProperty("--lah-stick-top", `${-top}px`);
      el.style.setProperty("--lah-bleed-l", `${parseFloat(style.paddingLeft) || 0}px`);
      el.style.setProperty("--lah-bleed-r", `${parseFloat(style.paddingRight) || 0}px`);
      el.style.setProperty("--lah-fill-h", `${Math.max(0, Math.floor(fill))}px`);
    };
    relayout.current = apply;
    apply();
    observer.observe(el);
    if (bar.current) observer.observe(bar.current);
    // The host slides the drawer in with a transform, which no ResizeObserver sees: measure again when it settles.
    document.addEventListener("transitionend", apply, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("transitionend", apply, true);
    };
  }, []);
  // The heads are watched only while the drawer is open: the watcher observes the whole page, and a
  // closed drawer has nothing to keep clear of them.
  useEffect(() => {
    if (!open) return;
    const watch = watchChatHeads(app.host.measure);
    const sync = (): void => {
      heads.current = watch.get();
      relayout.current();
    };
    sync();
    const off = watch.subscribe(sync);
    return () => {
      off();
      watch.dispose();
      heads.current = [];
      relayout.current();
    };
  }, [open]);
  /** The page of each group the user was last on: a group opens there. */
  const lastOf = useRef<Partial<Record<GroupId, PageId>>>({});
  lastOf.current[group] = page;
  const select = (next: PageId): void => app.nav.update((n) => ({ ...n, page: next }));
  const pages = groups.find((g) => g.id === group)?.pages ?? [];
  // WAI-ARIA tabs: Left/Right/Home/End move between the group's pages and focus the new one.
  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    const last = pages.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1) : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
    const target = pages[next];
    if (!target) return;
    event.preventDefault();
    select(target.id);
    tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  const View = PAGE_VIEW[page];
  // A group of one page needs no second row: its own button is the page's.
  const tabbed = pages.length > 1;
  return (
    <div ref={root} class="lah lah-root" data-lah-root data-lah-page={page} data-lah-coarse={coarse || undefined}>
      <div ref={bar} class="lah-bar">
        <div class="lah-nav">
          <div class="lah-pages lah-groups" role="group" aria-label="LumiAH's sections">
            {groups.map((entry) => (
              <button key={entry.id} type="button" id={`${bodyId}-group-${entry.id}`} data-lah-group={entry.id} aria-pressed={entry.id === group} onClick={() => select(lastOf.current[entry.id] ?? entry.pages[0]?.id ?? page)}>
                <Icon name={GROUP_ICON[entry.id]} size={18} />
                <span class="lah-pages-label">{entry.label}</span>
                <MarkDot mark={groupMark(entry.id, marks, groups)} />
              </button>
            ))}
          </div>
          {tabbed ? (
            <div ref={tabs} class="lah-pages lah-subpages" role="tablist" aria-label={`${groups.find((g) => g.id === group)?.label ?? ""} pages`}>
              {pages.map((entry, index) => (
                <button key={entry.id} type="button" role="tab" id={`${bodyId}-tab-${entry.id}`} data-lah-tab={entry.id} title={aboutOf(entry, state?.runtime.only)} aria-selected={entry.id === page} aria-controls={entry.id === page ? bodyId : undefined} tabIndex={entry.id === page ? 0 : -1} onClick={() => select(entry.id)} onKeyDown={(event) => onKeyDown(event, index)}>
                  <Icon name={PAGE_ICON[entry.id]} size={16} />
                  <span class="lah-pages-label">{entry.label}</span>
                  <MarkDot mark={marks[entry.id]} />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div class="lah-page" id={bodyId} role="tabpanel" aria-labelledby={tabbed ? `${bodyId}-tab-${page}` : `${bodyId}-group-${group}`}>
        {!ready ? (
          connection === "failed" ? (
            <Empty
              icon="alert"
              title="LumiAH's extension didn't answer"
              action={
                <Button icon="refresh" onClick={() => void app.client.sync()}>
                  Try again
                </Button>
              }
            >
              The pages show what the extension's backend tells them, and it hasn't answered. If it has just been installed or updated, it may still be starting.
            </Empty>
          ) : (
            <Empty icon="hourglass">Reaching LumiAH's extension…</Empty>
          )
        ) : (
          <ShownPagesContext.Provider value={only ?? null}>
            {stripOver(page) ? <AttentionStrip /> : null}
            {/* Every page but Home opens with the line that says what it is for, in the words Home leads to it with: a term a newcomer meets (a job, a skill, a runtime) is explained where it first appears. */}
            {page !== "home" ? (
              <p class="lah-page-lead" data-lah-page-lead>
                {((entry) => (entry ? aboutOf(entry, state?.runtime.only) : null))(pages.find((p) => p.id === page))}
              </p>
            ) : null}
            <View />
          </ShownPagesContext.Provider>
        )}
      </div>
      <Toasts />
    </div>
  );
}
