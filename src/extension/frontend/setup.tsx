// The frontend's entry: one drawer tab holding every page (DESIGN §8). It wires the client to
// Spindle's messaging, lends the pages what they borrow from the host, adds the one stylesheet and
// mounts the shell. The pages render what the backend's messages carry and send its requests; they
// read nothing else of Lumiverse.
//
// An extension that builds LumiAH into itself (DESIGN §21) calls `setup` from its own entry for a
// tab of its own name, or `mountPages` to put the pages (all of them, or those it names) in a root
// of its choosing with a channel of its own.

import { render } from "preact";
import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import type { FrontendToBackend } from "../../shared/ui";
import { type App, AppContext, createApp, type PageId, type PrefsStorage } from "./app";
import { createHost } from "./host";
import { TAB_ICON_SVG } from "./icons";
import { badgeOf } from "./nav-model";
import { Shell } from "./shell";
import { CSS } from "./styles";

/** The drawer tab as Lumiverse lists it. An extension that bundles LumiAH names its own. */
export interface TabOptions {
  id: string;
  title: string;
  shortName: string;
  description: string;
}

export const LUMIAH_TAB: TabOptions = { id: "lumiah", title: "LumiAH", shortName: "LumiAH", description: "The agent harness: switch it on for a chat, watch its agents work, and see their lore, chronicle, workspace and guidance, jobs, agents, skills and tools, spend and settings" };

/** Renders the pages into `root`; returns the unmount. `pages` names the pages to show (all, when left out). The stylesheet (`CSS`) must be in the document. */
export function mountPages(root: HTMLElement, app: App, options: { pages?: readonly PageId[] } = {}): () => void {
  render(
    <AppContext.Provider value={app}>
      <Shell {...(options.pages ? { pages: options.pages } : {})} />
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
  const tab = ctx.ui.registerDrawerTab({ id: tabOptions.id, title: tabOptions.title, shortName: tabOptions.shortName, headerTitle: tabOptions.title, description: tabOptions.description, keywords: ["agent", "harness", "home", "live", "session", "transcript", "lore", "chronicle", "workspace", "guidance", "skills", "tools", "jobs", "approval", "spend", "runtime", "tokens", "cost"], iconSvg: TAB_ICON_SVG });
  const unmount = mountPages(tab.root, app);
  cleanups.push(() => {
    unmount();
    tab.destroy();
  });
  // The signs outside the drawer, where a reply is waited for. The tab's badge says what waits for the user, else that LumiAH is working on the open chat's reply (nav-model's `badgeOf`).
  const badge = (): void => tab.setBadge(badgeOf(app.client.state.get(), host.activeChat.get()));
  cleanups.push(app.client.state.subscribe(badge), host.activeChat.subscribe(badge));
  badge();
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
