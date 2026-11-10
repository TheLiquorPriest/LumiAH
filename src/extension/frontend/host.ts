// What the pages borrow from Lumiverse, over `SpindleFrontendContext`: the clipboard, a download, a
// confirmation, the chat that is open, the drawer's state, the pointer the device has, and when the
// page should ask the backend again. Optional host APIs are feature-detected. The only file of the
// frontend that reads the host's context beside `setup.tsx`, which mounts the tab.

import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { isRecord } from "../../shared/ui";
import type { HostBridge } from "./app";
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
  return {
    activeChat,
    coarse,
    drawerOpen,
    origin: window.location.origin,
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
      window.addEventListener("online", again);
      document.addEventListener("visibilitychange", shown);
      return () => {
        offConnected();
        offLoaded();
        window.removeEventListener("online", again);
        document.removeEventListener("visibilitychange", shown);
      };
    },
    dispose() {
      for (const cleanup of cleanups) cleanup();
    },
  };
}
