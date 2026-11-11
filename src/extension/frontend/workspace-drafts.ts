// What the Workspace and Guidance pages keep while the user is on another page of LumiAH: the text
// typed and not yet saved, and where the Workspace page was. A page's own state goes when the page
// bar shows another page, and nothing asks before it does; so what must not be lost is held here,
// by the app it belongs to, for as long as the tab's pages live. That is the guard on unsaved text:
// it stays until the user saves it or says to drop it.

import type { App } from "./app";
import { createStore, type Store } from "./store";
import { type Draft, START_KEPT, type WorkspaceKept } from "./workspace-model";

export type Drafts = ReadonlyMap<string, Draft>;

const DRAFTS = new WeakMap<App, Store<Drafts>>();
const KEPT = new WeakMap<App, Store<WorkspaceKept>>();

/** The drafts of an app's pages, each under the key of what it was typed over (`draftKey`, `newDraftKey`, `guidanceDraftKey`). */
export function draftsOf(app: App): Store<Drafts> {
  let store = DRAFTS.get(app);
  if (!store) {
    store = createStore<Drafts>(new Map());
    DRAFTS.set(app, store);
  }
  return store;
}

/** Keeps a draft under its key, or lets it go (`draft` null). */
export function putDraft(app: App, key: string, draft: Draft | null): void {
  draftsOf(app).update((held) => {
    if (draft === null && !held.has(key)) return held;
    const next = new Map(held);
    if (draft === null) next.delete(key);
    else next.set(key, draft);
    return next;
  });
}

/** Where an app's Workspace page is. */
export function keptOf(app: App): Store<WorkspaceKept> {
  let store = KEPT.get(app);
  if (!store) {
    store = createStore<WorkspaceKept>(START_KEPT);
    KEPT.set(app, store);
  }
  return store;
}
