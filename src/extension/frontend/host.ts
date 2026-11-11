// What the pages borrow from Lumiverse, over `SpindleFrontendContext`: the clipboard, a download, a
// confirmation, the chat that is open, the drawer's state, the pointer the device has, and when the
// page should ask the backend again. Optional host APIs are feature-detected. The only file of the
// frontend that reads the host's context beside `setup.tsx`, which mounts the tab.

import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { isRecord } from "../../shared/ui";
import type { HostBridge, HostCan } from "./app";
import { createStore } from "./store";

export interface Host extends HostBridge {
  /** Calls `again` each time the page may have missed what the backend sent; returns the stop. */
  watch(again: () => void): () => void;
  dispose(): void;
}

/**
 * Copies by selecting the text in a field off screen, for a page the browser gives no clipboard: one
 * opened over plain http on a home network, as many Lumiverse servers are.
 */
function copyBySelection(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

/** Lumiverse's names for its world book editor and for what its own Stop button runs (its developer docs, "Host Navigation and Actions"): the host's, so no setting. */
const LORE_EDITOR = "world_book_editor";
const STOP_COMMAND = "action-stop-generation";

export function createHost(ctx: SpindleFrontendContext): Host {
  const activeChat = createStore<string | null>(ctx.getActiveChat().chatId);
  const pointer = window.matchMedia?.("(pointer: coarse)");
  const coarse = createStore(pointer?.matches === true);
  const drawerOpen = createStore(ctx.ui.events.getDrawerState().open);
  const cleanups: (() => void)[] = [];
  const syncPointer = (): void => coarse.set(pointer?.matches === true);
  pointer?.addEventListener("change", syncPointer);
  cleanups.push(() => pointer?.removeEventListener("change", syncPointer));
  cleanups.push(ctx.ui.events.onDrawerChange((state) => drawerOpen.set(state.open)));
  // The chat that is open: the host's state where it has selectors, else its events.
  const syncChat = (): void => activeChat.set(ctx.getActiveChat().chatId);
  if (ctx.state) cleanups.push(ctx.state.subscribe<{ chatId: string | null }>("chat.active", (value) => activeChat.set(value.chatId)));
  else for (const event of ["CHAT_CHANGED", "CHAT_SWITCHED"]) cleanups.push(ctx.events.on(event, syncChat));
  // What a page may do in Lumiverse's own UI, from the host's own list of its places and actions (an older Lumiverse has none): its world book editor, and the command its Stop button runs. The list changes (a permission is granted, a chat opens), so it is read again when the host says so.
  const surfaces = ctx.host.surfaces;
  const canNow = (): HostCan => {
    try {
      const listed = surfaces?.list(["modal", "command"]) ?? [];
      const offers = (kind: string, id: string): boolean => listed.some((s) => s.kind === kind && s.id === id && s.invocable !== false);
      return { loreEditor: offers("modal", LORE_EDITOR), stopReply: offers("command", STOP_COMMAND) };
    } catch {
      return { loreEditor: false, stopReply: false };
    }
  };
  const can = createStore<HostCan>(canNow());
  if (surfaces) cleanups.push(surfaces.subscribe(() => can.set(canNow())));
  /** Runs one of the host's own actions; false where it has none such, or it refused. */
  const invoke = async (kind: "modal" | "command", id: string, params?: Record<string, string>): Promise<boolean> => {
    if (!surfaces) return false;
    try {
      await surfaces.invoke({ kind, id }, params);
      return true;
    } catch {
      return false;
    }
  };
  return {
    activeChat,
    coarse,
    drawerOpen,
    can,
    openLoreEntry: (bookId, entryId) => invoke("modal", LORE_EDITOR, { id: bookId, entryId }),
    stopReply: () => invoke("command", STOP_COMMAND),
    origin: window.location.origin,
    activeConnection() {
      // An optional host API (an older Lumiverse has none), and one that reads the host's own state: where it is missing or throws, the page says nothing rather than something wrong.
      try {
        const active = ctx.connections?.getActive?.();
        return active ? active.activeProfileId : undefined;
      } catch {
        return undefined;
      }
    },
    async copy(text) {
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          // The browser refused (no permission, the page not focused): the selection way may still work.
        }
      }
      return copyBySelection(text);
    },
    download(fileName, text, mime) {
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // The browser starts the download from the click; the address is let go once it has had time to.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    async confirm(options) {
      const result = await ctx.ui.showConfirm({ title: options.title, message: options.message, variant: options.danger ? "danger" : "info", confirmLabel: options.confirm });
      return result.confirmed;
    },
    measure(el) {
      const r = ctx.ui.geometry ? ctx.ui.geometry.layoutElementRect(el) : el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    async grant(permissions, reason) {
      // An optional host API: an older Lumiverse has no request a page can make, and grants only in its Extensions panel.
      const request = ctx.permissions?.request;
      if (typeof request !== "function") return "unavailable";
      try {
        const granted = await request.call(ctx.permissions, [...permissions], { reason });
        return permissions.every((p) => granted.includes(p)) ? "granted" : "denied";
      } catch {
        // Lumiverse rejects when the user says no (or when one of them needs an owner's approval they can't give).
        return "denied";
      }
    },
    watch(again) {
      // Lumiverse drops what a page sends while its socket is down and while the extension's worker
      // restarts, without a word. The page learns only that the socket is back (its CONNECTED names
      // the user once Lumiverse has authenticated it) or that its own extension started again.
      const offConnected = ctx.events.on("CONNECTED", (payload) => {
        if (isRecord(payload) && ((typeof payload.userId === "string" && payload.userId !== "") || (typeof payload.role === "string" && payload.role !== ""))) again();
      });
      const offLoaded = ctx.events.on("SPINDLE_EXTENSION_LOADED", (payload) => {
        if (isRecord(payload) && payload.extensionId === ctx.host.extensionInstallationId) again();
      });
      // A tab that was out of view may have slept through pushes; one that comes back on line certainly has.
      const shown = (): void => {
        if (document.visibilityState === "visible") again();
      };
      // The drawer was opened, or brought to another of its tabs and perhaps back to this one: what only a page can tell the backend (the connection profile active in Lumiverse) may have changed in the tab the user came from.
      const offDrawer = ctx.ui.events.onDrawerChange((state) => {
        if (state.open) again();
      });
      window.addEventListener("online", again);
      document.addEventListener("visibilitychange", shown);
      return () => {
        offConnected();
        offLoaded();
        offDrawer();
        window.removeEventListener("online", again);
        document.removeEventListener("visibilitychange", shown);
      };
    },
    dispose() {
      for (const cleanup of cleanups) cleanup();
    },
  };
}
