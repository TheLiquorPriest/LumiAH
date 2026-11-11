// A stand-in for Lumiverse's page, for the preview: the drawer with its tab's root, header and
// badge, the confirmation, the chat that is open, the host's events, and the messaging bridge to
// the mock backend. It gives the frontend's `setup` the parts of `SpindleFrontendContext` it reads
// and nothing more. Moved from LumiRPEngine's preview and cut to what one drawer tab needs.

import type { SpindleFrontendContext } from "lumiverse-spindle-types";

type Listener<T> = (value: T) => void;

export interface MockHost {
  ctx: SpindleFrontendContext;
  /** A message from the backend reaches the page. */
  deliver(payload: unknown): void;
  /** What the page sends the backend goes here. */
  onSend: (payload: unknown) => void;
  setDrawer(open: boolean): void;
  /** Another chat is opened in the host. */
  openChat(chatId: string | null): void;
  /** The socket comes back, as Lumiverse says it once it has authenticated it. */
  reconnect(): void;
  /** The user agreed to grant the extension these permissions, in the host's own confirmation. */
  onGrant: (permissions: string[]) => void;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`The preview page has no #${id}.`);
  return el as T;
}

export function createMockHost(options: { drawerOpen: boolean; chatId: string | null; canGrant: boolean }): MockHost {
  const backendListeners = new Set<Listener<unknown>>();
  const drawerListeners = new Set<Listener<{ open: boolean; tabId: string | null }>>();
  const eventListeners = new Map<string, Set<Listener<unknown>>>();
  let drawerOpen = options.drawerOpen;
  let chatId = options.chatId;
  let tabId: string | null = null;
  const drawer = byId("drawer");
  const drawerPanel = byId("drawer-panel");
  const drawerTitle = byId("drawer-title-text");
  const badge = byId("host-tab-badge");
  const applyDrawer = (): void => {
    drawer.dataset.open = String(drawerOpen);
    document.body.dataset.drawer = drawerOpen ? "open" : "closed";
    for (const listener of drawerListeners) listener({ open: drawerOpen, tabId: drawerOpen ? tabId : null });
  };
  applyDrawer();
  byId("drawer-close").addEventListener("click", () => host.setDrawer(false));
  byId("drawer-open").addEventListener("click", () => host.setDrawer(true));

  // The host's confirmation: one at a time, answered in the page.
  const confirmBox = byId("confirm");
  let answer: ((confirmed: boolean) => void) | null = null;
  const settle = (confirmed: boolean): void => {
    confirmBox.hidden = true;
    answer?.(confirmed);
    answer = null;
  };
  byId("confirm-yes").addEventListener("click", () => settle(true));
  byId("confirm-no").addEventListener("click", () => settle(false));

  const emit = (event: string, payload: unknown): void => {
    for (const listener of eventListeners.get(event) ?? []) listener(payload);
  };

  const host: MockHost = {
    onSend: () => {},
    onGrant: () => {},
    deliver(payload) {
      // A copy, as a message that crossed a socket is: the page can't share an object with the backend.
      for (const listener of backendListeners) listener(structuredClone(payload));
    },
    setDrawer(open) {
      drawerOpen = open;
      applyDrawer();
    },
    openChat(next) {
      chatId = next;
      emit("CHAT_SWITCHED", { chatId: next });
    },
    reconnect() {
      emit("CONNECTED", { userId: "preview-user" });
    },
    ctx: null as unknown as SpindleFrontendContext,
  };

  const ui = {
    events: {
      getDrawerState: () => ({ open: drawerOpen, tabId: drawerOpen ? tabId : null }),
      onDrawerChange(listener: Listener<{ open: boolean; tabId: string | null }>) {
        drawerListeners.add(listener);
        return () => drawerListeners.delete(listener);
      },
    },
    geometry: {
      getUiScale: () => 1,
      toLayoutPx: (px: number) => px,
      layoutViewportSize: () => ({ width: window.innerWidth, height: window.innerHeight }),
      layoutElementRect: (node: Element) => node.getBoundingClientRect(),
    },
    registerDrawerTab(tab: { id: string; title: string; shortName?: string; iconSvg?: string }) {
      const root = document.createElement("div");
      root.dataset.tab = tab.id;
      tabId = tab.id;
      drawerTitle.textContent = tab.title;
      byId("host-tab-name").textContent = tab.shortName ?? tab.title;
      // The tab's icon is the extension's own markup, as the host draws it.
      if (tab.iconSvg) byId("host-tab-icon").innerHTML = tab.iconSvg;
      drawerPanel.appendChild(root);
      return {
        root,
        tabId: tab.id,
        setTitle: (title: string) => {
          drawerTitle.textContent = title;
        },
        setShortName: () => {},
        setBadge: (text: string | null) => {
          badge.hidden = text === null;
          badge.textContent = text ?? "";
        },
        activate: () => host.setDrawer(true),
        destroy: () => root.remove(),
        onActivate: () => () => {},
      };
    },
    showConfirm(confirm: { title: string; message: string; variant?: string; confirmLabel?: string }) {
      byId("confirm-title").textContent = confirm.title;
      byId("confirm-message").textContent = confirm.message;
      byId("confirm-yes").textContent = confirm.confirmLabel ?? "Confirm";
      confirmBox.dataset.variant = confirm.variant ?? "info";
      confirmBox.hidden = false;
      answer?.(false);
      return new Promise<{ confirmed: boolean }>((resolve) => {
        answer = (confirmed) => resolve({ confirmed });
      });
    },
  };

  host.ctx = {
    dom: {
      addStyle(css: string) {
        const style = document.createElement("style");
        style.dataset.lah = "styles";
        style.textContent = css;
        document.head.appendChild(style);
        return () => style.remove();
      },
    },
    ui,
    events: {
      on(event: string, handler: Listener<unknown>) {
        const set = eventListeners.get(event) ?? new Set<Listener<unknown>>();
        eventListeners.set(event, set);
        set.add(handler);
        return () => set.delete(handler);
      },
      emit,
    },
    host: { descriptorVersion: 1, lumiverseVersion: "preview", capabilities: {}, extensionInstallationId: "preview" },
    getActiveChat: () => ({ chatId, characterId: null }),
    // The profile active in the host: the made-up Deepseek one, which a chat with no connection of its own generates on.
    connections: { getActive: () => ({ activeProfileId: "conn-deepseek", provider: "deepseek", model: "deepseek-v4-flash" }) },
    sendToBackend: (payload: unknown) => host.onSend(structuredClone(payload)),
    onBackendMessage(handler: Listener<unknown>) {
      backendListeners.add(handler);
      return () => backendListeners.delete(handler);
    },
    // A page may ask the host to grant its extension permissions, which the host confirms with the user first; an older Lumiverse has no such request (`canGrant` false).
    ...(options.canGrant
      ? {
          permissions: {
            getGranted: async () => [],
            async request(permissions: string[], asked?: { reason?: string }) {
              const { confirmed } = await ui.showConfirm({ title: "Allow LumiAH these permissions?", message: `${asked?.reason ?? ""} It asks for: ${permissions.join(", ")}.`.trim(), confirmLabel: "Allow" });
              if (!confirmed) throw new Error("The user declined.");
              host.onGrant(permissions);
              return permissions;
            },
          },
        }
      : {}),
    // The preview gives `setup` only what it reads of the host's context; the rest of that large type isn't made up.
  } as unknown as SpindleFrontendContext;
  return host;
}
