// The tab's shell: the page bar (Live · Sessions · Settings · Runtime) that stays at the top, over
// the page chosen. It measures what the stylesheet can't know and publishes it as custom properties
// (styles/shell.ts says what each is for): where a bar sticks so nothing shows above it, how far it
// bleeds to the host panel's edges, the height the panel shows, the bar's own height, and how far
// the host's chat heads reach into the pages while they overlap them. Moved from LumiRPEngine's drawer.

import { useEffect, useId, useRef } from "preact/hooks";
import { PAGES, type PageId, useApp } from "./app";
import { headGutters, watchChatHeads } from "./chat-heads";
import { Button, Empty, Toasts } from "./components";
import { Icon, type IconName } from "./icons";
import type { Rect } from "./layout";
import { LivePage } from "./pages/live";
import { RuntimePage } from "./pages/runtime";
import { SessionsPage } from "./pages/sessions";
import { SettingsPage } from "./pages/settings";
import { scrollParent } from "./scroll";
import { useSelect } from "./store";

const PAGE_ICON: Readonly<Record<PageId, IconName>> = { live: "pulse", sessions: "layers", settings: "sliders", runtime: "link" };

export function Shell() {
  const app = useApp();
  const page = useSelect(app.nav, (n) => n.page);
  const connection = useSelect(app.client.connection, (c) => c);
  const ready = useSelect(app.client.state, (s) => s !== null);
  const running = useSelect(app.client.state, (s) => (s?.running.length ?? 0) > 0);
  const unlinked = useSelect(app.client.state, (s) => s !== null && (s.runtime.issues.length > 0 || !s.runtime.relays.some((r) => r.link === "linked")));
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
  const select = (next: PageId): void => app.nav.update((n) => ({ ...n, page: next }));
  // WAI-ARIA tabs: Left/Right/Home/End move between pages and focus the new one.
  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    const last = PAGES.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1) : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
    const target = PAGES[next];
    if (!target) return;
    event.preventDefault();
    select(target.id);
    tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div ref={root} class="lah lah-root" data-lah-root data-lah-page={page} data-lah-coarse={coarse || undefined}>
      <div ref={bar} class="lah-bar">
        <div ref={tabs} class="lah-pages" role="tablist" aria-label="LumiAH">
          {PAGES.map((entry, index) => (
            <button key={entry.id} type="button" role="tab" id={`${bodyId}-tab-${entry.id}`} data-lah-tab={entry.id} aria-selected={entry.id === page} aria-controls={entry.id === page ? bodyId : undefined} tabIndex={entry.id === page ? 0 : -1} onClick={() => select(entry.id)} onKeyDown={(event) => onKeyDown(event, index)}>
              <Icon name={PAGE_ICON[entry.id]} size={18} />
              <span class="lah-pages-label">{entry.label}</span>
              {entry.id === "live" && running ? <span class="lah-pulse lah-pages-dot" role="img" aria-label="a turn is running" /> : null}
              {entry.id === "runtime" && unlinked ? <span class="lah-dot lah-is-warn lah-pages-dot" role="img" aria-label="needs attention" /> : null}
            </button>
          ))}
        </div>
      </div>
      <div class="lah-page" id={bodyId} role="tabpanel" aria-labelledby={`${bodyId}-tab-${page}`}>
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
        ) : page === "live" ? (
          <LivePage />
        ) : page === "sessions" ? (
          <SessionsPage />
        ) : page === "settings" ? (
          <SettingsPage />
        ) : (
          <RuntimePage />
        )}
      </div>
      <Toasts />
    </div>
  );
}
