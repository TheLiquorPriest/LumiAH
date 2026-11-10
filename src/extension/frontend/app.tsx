// What every page reads through context: the client and the state it holds, the page shown and the
// chat it shows, this device's preferences, toasts, and what the host lends (the clipboard, a
// download, a confirmation, the chat open in Lumiverse). Pages render state and send requests
// through it; nothing here knows a particular page.

import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { Channel } from "./client";
import { UiClient, UiRequestError } from "./client";
import type { Rect } from "./layout";
import { createStore, type Readable, type Store } from "./store";

/** What the host lends the pages. */
export interface HostBridge {
  /** Copies text to the clipboard; false when the clipboard refused. */
  copy(text: string): Promise<boolean>;
  /** Saves text as a file on the user's device. */
  download(fileName: string, text: string, mime: string): void;
  /** Asks before something that can't be undone; true when the user agreed. */
  confirm(options: { title: string; message: string; confirm: string; danger?: boolean }): Promise<boolean>;
  /** The chat open in Lumiverse, as it changes. */
  activeChat: Readable<string | null>;
  /** Whether the device's pointer is coarse (touch), as it changes. */
  coarse: Readable<boolean>;
  /** Whether the drawer the pages sit in is open, as it changes: what watches the whole page (the host's chat heads) rests while it is closed. */
  drawerOpen: Readable<boolean>;
  /** The address the page is open at, for the lines that start a runtime. */
  origin: string;
  /** An element's box in the host's layout pixels (the host scales its UI, which the element's own client box doesn't say). */
  measure(el: Element): Rect;
}

export type PageId = "live" | "sessions" | "settings" | "runtime";

export const PAGES: readonly { id: PageId; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "sessions", label: "Sessions" },
  { id: "settings", label: "Settings" },
  { id: "runtime", label: "Runtime" },
];

/** Where the pages are: the page shown, and the chat Live and Sessions show (null: the chat open in Lumiverse). */
export interface Nav {
  page: PageId;
  chatId: string | null;
}

/** This device's own choices: how the pages behave here, kept in the browser, not with the user's settings. */
export interface Prefs {
  /** How long a request waits for the extension's answer, in seconds. */
  requestSeconds: number;
  /** How many steps a long transcript shows at once; earlier ones show on request. */
  pageSteps: number;
  /** How many turns Sessions reads at once. */
  pageTurns: number;
  /** How much of a long text shows before "Show the rest", in characters. */
  clipChars: number;
  /** How long a notice stays before it goes, in seconds. */
  toastSeconds: number;
  /** Live keeps the newest step in view while a turn runs. */
  follow: boolean;
  /** A call's thinking shows open. */
  thinkingOpen: boolean;
  /** A tool call shows open, with its arguments and its result. */
  toolsOpen: boolean;
}

type NumberPref = { [K in keyof Prefs]: Prefs[K] extends number ? K : never }[keyof Prefs];
type SwitchPref = { [K in keyof Prefs]: Prefs[K] extends boolean ? K : never }[keyof Prefs];

export const PREF_NUMBERS: Readonly<Record<NumberPref, { min: number; max: number; default: number; step: number; label: string; unit: string; help: string }>> = {
  requestSeconds: { min: 5, max: 600, default: 30, step: 5, label: "Wait for an answer", unit: "seconds", help: "How long a page waits for LumiAH's extension to answer before it says the request failed." },
  pageSteps: { min: 20, max: 5000, default: 150, step: 10, label: "Steps shown at once", unit: "steps", help: "A long transcript shows this many of its latest steps; Show earlier brings the rest, this many at a time." },
  pageTurns: { min: 5, max: 500, default: 30, step: 5, label: "Turns read at once", unit: "turns", help: "Sessions reads a chat's turns this many at a time, newest first." },
  clipChars: { min: 500, max: 1_000_000, default: 6000, step: 500, label: "Long text shown at first", unit: "characters", help: "A longer text shows this much, then Show the rest. A search that finds something further on shows the whole text." },
  toastSeconds: { min: 2, max: 60, default: 4, step: 1, label: "Notices stay", unit: "seconds", help: "How long a notice such as Copied stays before it goes. A failure's notice stays until you dismiss it." },
};

export const PREF_SWITCHES: Readonly<Record<SwitchPref, { default: boolean; label: string; help: string }>> = {
  follow: { default: true, label: "Follow the newest step", help: "While a turn runs, Live keeps its newest step in view until you scroll up." },
  thinkingOpen: { default: false, label: "Show thinking open", help: "A call's thinking shows whole instead of folded under its first line." },
  toolsOpen: { default: false, label: "Show tool calls open", help: "A tool call shows its arguments and its result instead of one line." },
};

export function defaultPrefs(): Prefs {
  return {
    requestSeconds: PREF_NUMBERS.requestSeconds.default,
    pageSteps: PREF_NUMBERS.pageSteps.default,
    pageTurns: PREF_NUMBERS.pageTurns.default,
    clipChars: PREF_NUMBERS.clipChars.default,
    toastSeconds: PREF_NUMBERS.toastSeconds.default,
    follow: PREF_SWITCHES.follow.default,
    thinkingOpen: PREF_SWITCHES.thinkingOpen.default,
    toolsOpen: PREF_SWITCHES.toolsOpen.default,
  };
}

/** Preferences as stored, each number kept within its limits; anything unreadable is its default. */
export function prefsOf(raw: unknown): Prefs {
  const prefs = defaultPrefs();
  if (typeof raw !== "object" || raw === null) return prefs;
  const stored = raw as Record<string, unknown>;
  for (const key of Object.keys(PREF_NUMBERS) as NumberPref[]) {
    const value = stored[key];
    const limit = PREF_NUMBERS[key];
    if (typeof value === "number" && Number.isFinite(value)) prefs[key] = Math.round(Math.min(limit.max, Math.max(limit.min, value)));
  }
  for (const key of Object.keys(PREF_SWITCHES) as SwitchPref[]) {
    const value = stored[key];
    if (typeof value === "boolean") prefs[key] = value;
  }
  return prefs;
}

/** Where this device keeps its preferences. */
export const PREFS_KEY = "lumi_ah.prefs";

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

export interface App {
  client: UiClient;
  nav: Store<Nav>;
  prefs: Store<Prefs>;
  toasts: Store<Toast[]>;
  toast(text: string, tone?: Toast["tone"]): void;
  /** A request's failure as a toast, in its own words. */
  fail(error: unknown): void;
  /** Saves a file to the device and says so (`said`, or "Saved <name>."): the browser's own sign of a download is easy to miss from inside a drawer, and on a phone there may be none. */
  save(name: string, text: string, mime: string, said?: string, tone?: Toast["tone"]): void;
  host: HostBridge;
  now(): number;
}

export const AppContext = createContext<App | null>(null);

export function useApp(): App {
  const app = useContext(AppContext);
  if (app === null) throw new Error("LumiAH's pages need an AppContext provider: mount them through mountPages().");
  return app;
}

/** The storage a device's preferences live in: localStorage where the browser allows it. */
export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AppOptions {
  channel: Channel;
  host: HostBridge;
  storage: PrefsStorage | null;
  now?: () => number;
}

/** What a failure says: its own words. */
export function errorWords(error: unknown): string {
  return error instanceof UiRequestError || error instanceof Error ? error.message : String(error);
}

export function createApp(options: AppOptions): App {
  let stored: unknown = null;
  try {
    const text = options.storage?.getItem(PREFS_KEY);
    stored = text ? JSON.parse(text) : null;
  } catch {
    // Storage can be blocked (a private window) or hold something unreadable: the defaults stand.
  }
  const prefs = createStore<Prefs>(prefsOf(stored));
  prefs.subscribe((value) => {
    try {
      options.storage?.setItem(PREFS_KEY, JSON.stringify(value));
    } catch {
      // Where storage is blocked the choice holds for this page only.
    }
  });
  const client = new UiClient(options.channel, { timeoutMs: () => prefs.get().requestSeconds * 1000 });
  const toasts = createStore<Toast[]>([]);
  let toastId = 0;
  const toast = (text: string, tone: Toast["tone"] = "info"): void => {
    toastId += 1;
    const id = toastId;
    // Three at most: an older one makes room, since a stack taller than that covers what it is about.
    toasts.update((all) => [...all.slice(-2), { id, text, tone }]);
    if (tone === "info") setTimeout(() => toasts.update((all) => all.filter((t) => t.id !== id)), prefs.get().toastSeconds * 1000);
  };
  return {
    client,
    nav: createStore<Nav>({ page: "live", chatId: null }),
    prefs,
    toasts,
    toast,
    fail: (error) => toast(errorWords(error), "error"),
    save: (name, text, mime, said = `Saved ${name}.`, tone = "info") => {
      options.host.download(name, text, mime);
      toast(said, tone);
    },
    host: options.host,
    now: options.now ?? (() => Date.now()),
  };
}
