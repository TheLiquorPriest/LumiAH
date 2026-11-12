// What every page reads through context: the client and the state it holds, the page shown and the
// chat it shows, this device's preferences, toasts, and what the host lends (the clipboard, a
// download, a confirmation, the chat open in Lumiverse). Pages render state and send requests
// through it; nothing here knows a particular page.

import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { ChronicleFile, SettingPath, WorkspaceArea } from "../../shared/ui";
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
  /** The connection profile active in Lumiverse now: its id, null when none is, undefined where the host doesn't say. A chat with no connection of its own generates on it, and only a page can know which it is. */
  activeConnection(): string | null | undefined;
  /** Whether the device's pointer is coarse (touch), as it changes. */
  coarse: Readable<boolean>;
  /** Whether the drawer the pages sit in is open, as it changes: what watches the whole page (the host's chat heads) rests while it is closed. */
  drawerOpen: Readable<boolean>;
  /** The address the page is open at, for the lines that start a runtime. */
  origin: string;
  /** An element's box in the host's layout pixels (the host scales its UI, which the element's own client box doesn't say). */
  measure(el: Element): Rect;
  /**
   * Asks Lumiverse to grant the extension permissions it lacks (by Lumiverse's names for them),
   * saying why; Lumiverse shows the user its own confirmation. `granted` when the user agreed,
   * `denied` when they didn't, `unavailable` where this Lumiverse has no such request: the page then
   * says where to grant them by hand.
   */
  grant(permissions: readonly string[], reason: string): Promise<"granted" | "denied" | "unavailable">;
  /** What this Lumiverse lets a page do in Lumiverse's own UI, as that changes; every one false on an older Lumiverse, and a page then offers none of them. */
  can: Readable<HostCan>;
  /** Opens Lumiverse's own editor of a world book at one entry; false where it couldn't. */
  openLoreEntry(bookId: string, entryId: string): Promise<boolean>;
  /** Stops the reply being generated in the open chat, as Lumiverse's own Stop does; false where it couldn't. */
  stopReply(): Promise<boolean>;
}

/** What a page may do in Lumiverse's own UI: open its world book editor at an entry, and stop the reply being generated in the open chat. */
export interface HostCan {
  loreEditor: boolean;
  stopReply: boolean;
}

export type PageId = "home" | "live" | "sessions" | "jobs" | "talk" | "lore" | "chronicle" | "workspace" | "guidance" | "agents" | "skills" | "tools" | "settings" | "spend" | "upkeep" | "runtime";

export type GroupId = "home" | "now" | "story" | "agents" | "system";

/** A page as the bar and Home name it: its label, a line that says what it is for in plain words (a term a newcomer meets is explained in it), and whether it is one few people need (`far`: Home folds those away until asked for). */
export interface PageEntry {
  id: PageId;
  label: string;
  about: string;
  far?: true;
}

/**
 * The pages, in the groups the page bar shows them in. Home comes first and stands alone: it is
 * where a newcomer lands, and it leads to every other page in one tap. Then what is happening
 * (Now), what LumiAH knows and keeps of the story (Story), and, further in, what agents are made of
 * (Agents) and what LumiAH runs on (System). Sixteen pages don't fit one row of a phone, so the bar
 * is two rows: the groups, then the pages of the group shown, four at most so their labels stay
 * whole at 360 px. Any page is two taps away at most.
 */
export const GROUPS: readonly { id: GroupId; label: string; pages: readonly PageEntry[] }[] = [
  {
    id: "home",
    label: "Home",
    pages: [{ id: "home", label: "Home", about: "Whether LumiAH is used in this chat, what it last did, and what needs you." }],
  },
  {
    id: "now",
    label: "Now",
    pages: [
      { id: "live", label: "Live", about: "Watch the agents work on a reply, step by step, as it happens." },
      { id: "sessions", label: "Past replies", about: "Each past reply with what the agents did for it, and the notes they carry from one reply to the next." },
      { id: "jobs", label: "Jobs", about: "A job is longer work an agent does in the background, beside a reply or after it." },
      { id: "talk", label: "Talk", about: "Ask an agent something outside the chat, without it becoming a reply." },
    ],
  },
  {
    id: "story",
    label: "Story",
    pages: [
      { id: "lore", label: "Lore", about: "Your world books: which entries reached the last reply, and a search that finds what an agent would find." },
      { id: "chronicle", label: "Chronicle", about: "What the story has established so far, each line with the messages it rests on. A long story is learned here." },
      { id: "workspace", label: "Workspace", about: "The notes and files the agents keep, for this chat and for you." },
      { id: "guidance", label: "Guidance", about: "Standing instructions every agent follows: yours, the character's, this chat's." },
    ],
  },
  {
    id: "agents",
    label: "Agents",
    pages: [
      { id: "agents", label: "Agents", about: "An agent is a model given a task, tools and limits. See them, change them, or make your own.", far: true },
      { id: "skills", label: "Skills", about: "A skill is a written procedure an agent loads when it needs it.", far: true },
      { id: "tools", label: "Tools", about: "What an agent can do: search, read, write. Switch a tool off, or have its calls wait for your word.", far: true },
    ],
  },
  {
    id: "system",
    label: "System",
    pages: [
      { id: "settings", label: "Settings", about: "Models, limits, and every text sent to a model. The defaults work as they are." },
      { id: "spend", label: "Spend", about: "Tokens and cost by day, chat, agent and model, and the caps you set.", far: true },
      { id: "upkeep", label: "Storage", about: "What LumiAH stores, how big it is, and clearing what is no longer needed.", far: true },
      { id: "runtime", label: "Runtime", about: "Needed. A runtime is a program you start beside Lumiverse: LumiAH's agents work there before each reply, and no chat is answered without it." },
    ],
  },
];

export const PAGES: readonly PageEntry[] = GROUPS.flatMap((g) => g.pages);

/** The group a page is in. */
export function groupOf(page: PageId): GroupId {
  return GROUPS.find((g) => g.pages.some((p) => p.id === page))?.id ?? "home";
}

/** A workspace file a page points at: its area and path, a version of it (null: as it stands), and the page that led to it where Back should return there (the Chronicle, for one of its files) rather than to the Workspace's own list. */
export interface FileTarget {
  area: WorkspaceArea;
  path: string;
  hash: string | null;
  from?: PageId;
}

/**
 * Where the pages are: the page shown; the chat the pages about a chat show (null: the chat open in
 * Lumiverse); and what each page that shows one thing of many has open, kept here so another page
 * can lead to it (a tool result to the file it changed, a notice to its job, a cap to its setting)
 * and so it is still open when the user comes back.
 */
export interface Nav {
  page: PageId;
  chatId: string | null;
  /** Workspace: the file open. */
  file: FileTarget | null;
  /** Workspace: the reply whose change set is shown. */
  changes: { messageId: string; swipe: number } | null;
  /** Jobs: the job open. */
  job: string | null;
  /** Talk: the side session open. */
  side: string | null;
  /** Agents, Skills, Tools: the definition open on each, by id (a tool's name). */
  def: { agents: string | null; skills: string | null; tools: string | null };
  /** Settings: a setting to bring into view, taken (set back to null) by the page once shown. */
  setting: SettingPath | null;
  /** Lore: the entry open, by its id. */
  lore: string | null;
  /** Chronicle: the file shown (its path within `learned/`) and the line of it to bring into view (from 1; null: none), taken by the page once shown. */
  chronicle: { path: ChronicleFile["path"]; line: number | null } | null;
  /** A message of the chat to show, by its citation (`[#412 a3f9c27e]`): Chronicle opens the cited message's text. */
  message: string | null;
  /** Chronicle: Learn this story was asked for elsewhere (Home offers it for a long chat nobody has learned), so its form opens; taken (set back to false) by the page once shown. */
  learn: boolean;
}

export const START_NAV: Nav = { page: "home", chatId: null, file: null, changes: null, job: null, side: null, def: { agents: null, skills: null, tools: null }, setting: null, lore: null, chronicle: null, message: null, learn: false };

/** This device's own choices: how the pages behave here, kept in the browser, not with the user's settings. */
export interface Prefs {
  /** How long a request waits for the extension's answer, in seconds. */
  requestSeconds: number;
  /** How many steps a long transcript shows at once; earlier ones show on request. */
  pageSteps: number;
  /** How many rows a list that is read a page at a time reads at once: a chat's turns in Sessions, the jobs in Jobs. */
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
  pageTurns: { min: 5, max: 500, default: 30, step: 5, label: "Rows read at once", unit: "rows", help: "Past replies reads a chat's replies, and Jobs its jobs, this many at a time, newest first." },
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

/** The pages the shell shows, where it shows only some (an extension that mounts LumiAH's pages in its own drawer names them); null: all. Home reads it so it leads only to pages that are there. */
export const ShownPagesContext = createContext<readonly PageId[] | null>(null);

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
  const client = new UiClient(options.channel, {
    timeoutMs: () => prefs.get().requestSeconds * 1000,
    hello: () => {
      const active = options.host.activeConnection();
      return active === undefined ? {} : { active };
    },
  });
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
    nav: createStore<Nav>(START_NAV),
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
