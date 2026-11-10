// The frontend's entry: one drawer tab holding every page (DESIGN §8). It wires the client to
// Spindle's messaging, lends the pages what they borrow from the host, adds the one stylesheet and
// mounts the shell. The pages render what the backend's messages carry and send its requests; they
// read nothing else of Lumiverse.
//
// An extension that bundles LumiAH's pieces into its own calls `setup` from its own entry, or
// `mountPages` to put the pages in a root of its choosing with a channel of its own.

import { render } from "preact";
import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import type { FrontendToBackend } from "../../shared/ui";
import { type App, AppContext, createApp, type PrefsStorage } from "./app";
import { createHost } from "./host";
import { TAB_ICON_SVG } from "./icons";
import { Shell } from "./shell";
import { CSS } from "./styles";

/** The drawer tab as Lumiverse lists it. An extension that bundles LumiAH names its own. */
export interface TabOptions {
  id: string;
  title: string;
  shortName: string;
  description: string;
}

export const LUMIAH_TAB: TabOptions = { id: "lumiah", title: "LumiAH", shortName: "LumiAH", description: "The agent harness: its live session, its sessions, its settings and its runtime" };

/** Renders the pages into `root`; returns the unmount. The stylesheet (`CSS`) must be in the document. */
export function mountPages(root: HTMLElement, app: App): () => void {
  render(
    <AppContext.Provider value={app}>
      <Shell />
    </AppContext.Provider>,
    root,
  );
  return () => render(null, root);
}

/** This browser's storage for the device's preferences; null where the browser blocks it (a private window, a sandboxed frame). */
function deviceStorage(): PrefsStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function setup(ctx: SpindleFrontendContext, tabOptions: TabOptions = LUMIAH_TAB): () => void {
  const cleanups: (() => void)[] = [];
  const host = createHost(ctx);
  cleanups.push(() => host.dispose());
  cleanups.push(ctx.dom.addStyle(CSS));
  const app = createApp({ channel: { send: (payload: FrontendToBackend) => ctx.sendToBackend(payload), subscribe: (handler) => ctx.onBackendMessage(handler) }, host, storage: deviceStorage() });
  cleanups.push(() => app.client.dispose());
  const tab = ctx.ui.registerDrawerTab({ id: tabOptions.id, title: tabOptions.title, shortName: tabOptions.shortName, headerTitle: tabOptions.title, description: tabOptions.description, keywords: ["agent", "harness", "live", "session", "transcript", "runtime", "loopback", "tokens", "cost"], iconSvg: TAB_ICON_SVG });
  const unmount = mountPages(tab.root, app);
  cleanups.push(() => {
    unmount();
    tab.destroy();
  });
  // The tab's badge says how many turns LumiAH is answering now, so a running turn shows with the drawer on another tab.
  cleanups.push(
    app.client.state.subscribe((state) => {
      const turns = state?.running.length ?? 0;
      tab.setBadge(turns > 0 ? String(turns) : null);
    }),
  );
  cleanups.push(host.watch(() => app.client.resync()));
  void app.client.sync();
  return () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (error) {
        console.warn("[LumiAH] cleanup failed", error);
      }
    }
  };
}
