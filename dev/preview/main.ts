// The preview's boot: a mock host and a mock backend, then the real frontend `setup`.
// http://127.0.0.1:7895/?page=<a page's id: home (default), live, sessions, jobs, talk, lore, chronicle, workspace, guidance, agents, skills, tools, settings, spend, upkeep, runtime>
//   &scenario=ready|fresh|trouble   set up, with one chat built in and one in a linked runtime (default); a new install with nothing
//        granted or switched on; a permission missing, a runtime gone quiet and one refused
//   &grant=none   this Lumiverse has no way for a page to ask for permissions: Home says where to grant them by hand
//   &turn=done|failed|long|worked|running|working|nopart|urgent|none   the open chat's live turn (default done): `worked` has sub-agents,
//        workspace writes, an approval and a job in it; `running` starts one as the page opens; `working` starts one that holds a tool call
//        for your word; `nopart` is a reply LumiAH had no part in (its time ran out); `urgent` starts one with forty seconds before the reply
//   &chat=chat-mara|chat-brann|chat-okoro|chat-ilse|chat-joss|none   the chat open in the host (chat-ilse: one LumiAH doesn't answer; chat-joss: one another extension answers)
//   &settings=real|sample   LumiAH's own settings and texts (default), or a small made-up section using every kind of control
//   &drawer=wide|default|<px>   the drawer's width on a desktop: as wide as the host lets it go (default), the host's 420 px, or a width
//   &theme=dark|light   &pointer=coarse|fine   &delay=<ms an answer takes, default 120>   &fail=<request types that fail, comma-separated>
//   &open=<a turn's index>   Sessions opens that turn   &section=<a settings path or a nav key>   Settings opens that section
// `window.__lah` holds the backend, the host and the app's teardown, to drive from the console.

import { groupOf, PAGES } from "../../src/extension/frontend/app";
import { setup } from "../../src/extension/frontend/setup";
import { CHATS, OTHER_CHAT, THEIR_CHAT, workingTurn } from "./fixtures";
import { MockBackend, type Scenario } from "./mock-backend";
import { createMockHost } from "./mock-host";
import { realSettings, sampleSettings } from "./sections";
import { DARK_THEME, LIGHT_THEME } from "./themes";

const params = new URLSearchParams(location.search);
const pick = <T extends string>(name: string, among: readonly T[], otherwise: T): T => {
  const value = params.get(name);
  return among.includes(value as T) ? (value as T) : otherwise;
};

const light = params.get("theme") === "light";
const root = document.documentElement;
for (const [name, value] of Object.entries(light ? LIGHT_THEME : DARK_THEME)) root.style.setProperty(name, value);
root.style.colorScheme = light ? "light" : "dark";

// The pointer the pages take the device to have: a headless browser has a fine one, and a touch screen is asked for by name.
const pointer = params.get("pointer");
if (pointer === "coarse" || pointer === "fine") {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (query: string): MediaQueryList => (query === "(pointer: coarse)" ? ({ matches: pointer === "coarse", media: query, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList) : real(query));
}

// The drawer's width, as the host sets it: its default, the widest it allows (80% of the viewport, 64 px always left), or the width asked for within those.
const drawer = document.getElementById("drawer") as HTMLElement;
const widest = "min(80vw, calc(100vw - 64px))";
const asked = params.get("drawer") ?? "wide";
const width = asked === "default" ? "min(420px, calc(100vw - 64px))" : asked === "wide" ? widest : `clamp(min(280px, calc(100vw - 64px)), ${Number(asked) || 420}px, ${widest})`;
drawer.style.setProperty("--drawer-panel-w", width);
const handle = document.getElementById("drawer-resize") as HTMLElement;
handle.addEventListener("pointerdown", (down) => {
  handle.setPointerCapture(down.pointerId);
  const move = (event: PointerEvent): void => drawer.style.setProperty("--drawer-panel-w", `clamp(min(280px, calc(100vw - 64px)), ${window.innerWidth - event.clientX}px, ${widest})`);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", () => handle.removeEventListener("pointermove", move), { once: true });
});

const scenario = pick<Scenario>("scenario", ["ready", "fresh", "trouble"], "ready");
const chatParam = params.get("chat");
const chatId = chatParam === "none" ? null : (chatParam ?? "chat-mara");
const settled = params.get("settings") === "sample" ? sampleSettings() : realSettings();
const delay = Number(params.get("delay") ?? "120");
const host = createMockHost({ drawerOpen: params.get("drawerOpen") !== "false", chatId, canGrant: params.get("grant") !== "none" });
const backend = new MockBackend((payload) => host.deliver(payload), {
  scenario,
  turn: pick("turn", ["done", "failed", "long", "worked", "running", "working", "nopart", "urgent", "none"] as const, "done"),
  showcase: params.get("showcase") === "1",
  sections: settled.sections,
  texts: settled.texts,
  delay: Number.isFinite(delay) && delay >= 0 ? delay : 120,
  page: 60,
  fail: new Set((params.get("fail") ?? "").split(",").filter((t) => t !== "")),
  now: () => Date.now(),
  later: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  closeDrawer: () => host.setDrawer(false),
});
host.onSend = (payload) => backend.receive(payload);
host.onGrant = (permissions) => backend.grant(permissions);
const teardown = setup(host.ctx);

// ---------------------------------------------------------------- the host page's own parts

const chats = [...CHATS, OTHER_CHAT, THEIR_CHAT];
const names = new Map(chats.map((c) => [c.chatId, c.name ?? c.chatId]));
const messages = document.getElementById("messages") as HTMLElement;
const say = (who: string, text: string, user = false): void => {
  const bubble = document.createElement("div");
  bubble.className = user ? "msg user" : "msg";
  const name = document.createElement("div");
  name.className = "who";
  name.textContent = who;
  bubble.append(name, text);
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
};
say("Joss", 'Joss wiped the counter down and nodded at the door. "Harbourmaster\'s office shuts at six. If the ledger is anywhere, it is there."');
say("Mara", 'I pull my coat on. "Then we go now. Who keeps the key, Ilse or Brann?"', true);

const picker = document.getElementById("pick-chat") as HTMLSelectElement;
for (const c of chats) picker.append(new Option(c.name ?? c.chatId, c.chatId));
picker.append(new Option("(no chat open)", "none"));
picker.value = chatId ?? "none";
let open = chatId;
picker.addEventListener("change", () => {
  open = picker.value === "none" ? null : picker.value;
  (document.getElementById("chat-name") as HTMLElement).textContent = open === null ? "No chat" : (names.get(open) ?? open);
  host.openChat(open);
});
(document.getElementById("chat-name") as HTMLElement).textContent = chatId === null ? "No chat" : (names.get(chatId) ?? chatId);

// Send: a reply is asked for in the open chat, and its turn plays in Live. The second button's turn has a sub-agent whose workspace write is held for the user's word.
const sendTurn = (said: string, held: boolean): void => {
  if (open === null) return;
  say("Mara", said, true);
  if (!(held ? backend.startTurn(open, workingTurn(backend.placeOf(open))) : backend.startTurn(open))) say("Host", "LumiAH doesn't answer this chat, or a reply of it is being written already.");
};
(document.getElementById("send") as HTMLElement).addEventListener("click", () => sendTurn("I knock at Ilse's door.", false));
(document.getElementById("send-held") as HTMLElement).addEventListener("click", () => sendTurn("I tell Ilse what Joss said.", true));

const reload = (change: (next: URLSearchParams) => void): void => {
  const next = new URLSearchParams(location.search);
  change(next);
  location.search = next.toString();
};
const scenarioPicker = document.getElementById("pick-scenario") as HTMLSelectElement;
scenarioPicker.value = scenario;
scenarioPicker.addEventListener("change", () => reload((next) => next.set("scenario", scenarioPicker.value)));
(document.getElementById("link-runtime") as HTMLElement).addEventListener("click", () => backend.linkRuntime());
(document.getElementById("drop-push") as HTMLElement).addEventListener("click", () => {
  backend.dropNextLive = true;
});
(document.getElementById("toggle-theme") as HTMLElement).addEventListener("click", () => reload((next) => next.set("theme", light ? "dark" : "light")));
(document.getElementById("toggle-pointer") as HTMLElement).addEventListener("click", () => reload((next) => next.set("pointer", pointer === "coarse" ? "fine" : "coarse")));

// Where the pages open: the page bar's tab, a turn of Sessions, a section of Settings.
const press = (selector: string): boolean => {
  const el = document.querySelector<HTMLElement>(selector);
  el?.click();
  return el !== null;
};
/** Presses what `selector` finds once the page has drawn it; gives up after three seconds, when it never will. */
const pressWhenThere = (selector: string, tries = 60): void => {
  if (!press(selector) && tries > 0) setTimeout(() => pressWhenThere(selector, tries - 1), 50);
};
const page = pick(
  "page",
  PAGES.map((p) => p.id),
  "home",
);
if (page !== "home") {
  // The page bar shows the pages of one group at a time: the group first, then the page.
  pressWhenThere(`[data-lah-group="${groupOf(page)}"]`);
  pressWhenThere(`[data-lah-tab="${page}"]`);
}
const turnToOpen = params.get("open");
if (page === "sessions" && turnToOpen) pressWhenThere(`[data-lah-turnrow$="${turnToOpen}"] > .lah-navrow`);
const section = params.get("section");
if (page === "settings" && section) {
  // The full list is folded under its headings until asked for: they open first, so the section's row is there to press.
  const openThenPress = (tries = 60): void => {
    if (document.querySelector("details.lah-navfold") === null) {
      if (tries > 0) setTimeout(() => openThenPress(tries - 1), 50);
      return;
    }
    for (const fold of document.querySelectorAll<HTMLElement>("details.lah-navfold:not([open]) > summary")) fold.click();
    pressWhenThere(`[data-lah-nav="${section}"]`);
  };
  openThenPress();
}

declare global {
  interface Window {
    __lah: { backend: MockBackend; host: typeof host; teardown: () => void };
  }
}
window.__lah = { backend, host, teardown };
