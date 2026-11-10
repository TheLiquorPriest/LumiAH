// The pages' side of the backend (DESIGN §8; the contract is src/shared/ui.ts): every request a page
// sends is answered here with exactly one result or one error, and the state every page holds is
// pushed, part by part, whenever it changes. The state is the user's, the same for each of their
// pages; a page that can't follow the pushes says hello again and gets it whole.

import { LINK } from "../../link/contract";
import type { BackendToFrontend, KeyView, SetupView, UiErrorCode, UiProblem, UiRequest, UiRequestType, UiRequests, UiState, UiStatePart } from "../../shared/ui";
import { UI_VERSION, chatAnswered, uiRequestOf } from "../../shared/ui";
import type { Chats } from "./chat";
import type { Connections } from "./connections";
import { KeyedQueue } from "./docs";
import { LinkRefused, UiRefused, wordsOf } from "./errors";
import type { Keys } from "./keys";
import type { LiveBuffer } from "./live";
import type { RegistryStore } from "./registry";
import type { Relays } from "./relays";
import type { SessionsPage } from "./sessions";
import type { SettingsStore } from "./settings";
import { SettingsRefused } from "./settings";
import type { BackendHost } from "./spindle";
import type { StreamRegistry } from "./streams";
import type { ChatSwitch } from "./switch";

export interface UiDeps {
  relays: Relays;
  registry: RegistryStore;
  settings: SettingsStore;
  streams: StreamRegistry;
  connections: Connections;
  chats: Chats;
  live: LiveBuffer;
  switch: ChatSwitch;
  sessions: SessionsPage;
  keys: Keys;
  /** What keeps LumiAH from answering that no runtime's row says, each in plain words. */
  issues(): string[];
  now(): number;
}

/** A link refusal as a page's error: the codes both contracts share stay; a conflict is something that can't be done now. */
const LINK_CODES: Readonly<Record<string, UiErrorCode>> = { bad_request: "bad_request", forbidden: "forbidden", not_found: "not_found", conflict: "unavailable", unavailable: "unavailable", too_large: "bad_request" };

export class Ui {
  /** The users with a page that said hello, each with the revision of the state their pages hold and the parts that changed since. */
  private readonly users = new Map<string, { rev: number; dirty: Set<UiStatePart> }>();
  /** One thing at a time per user: a hello's answer and the pushes after it leave in the order the state changed. */
  private readonly queue = new KeyedQueue();

  constructor(
    private readonly host: Pick<BackendHost, "frontend" | "connections" | "log">,
    private readonly deps: UiDeps,
  ) {}

  // ---------------------------------------------------------------- the state

  private async key(userId: string): Promise<KeyView> {
    const key = (await this.deps.registry.read(userId)).key;
    return { set: key !== null, print: key?.print ?? null, at: key?.at ?? null };
  }

  private async setup(userId: string): Promise<SetupView> {
    const d = this.deps;
    const registry = await d.registry.read(userId);
    const chats = await d.switch.list(userId, d.live.chatsOf(userId));
    return {
      steps: [
        { id: "runtime", done: (await d.relays.linked(userId)).length > 0 },
        { id: "key", done: registry.key !== null },
        { id: "connection", done: (await d.connections.loopbacks(userId)).length > 0 },
        { id: "chat", done: chats.some((chat) => chat.on || chatAnswered(chat)) },
        { id: "reply", done: registry.replied },
      ],
    };
  }

  private async part<K extends UiStatePart>(userId: string, part: K): Promise<UiState[K]>;
  private async part(userId: string, part: UiStatePart): Promise<UiState[UiStatePart]> {
    const d = this.deps;
    switch (part) {
      case "runtime":
        return d.relays.view(userId, d.issues());
      case "setup":
        return this.setup(userId);
      case "key":
        return this.key(userId);
      case "chats":
        return d.switch.list(userId, d.live.chatsOf(userId));
      case "running":
        return d.live.runningOf(userId);
      case "connections":
        return d.connections.views(userId);
      case "settings":
        return d.settings.view(userId);
      case "texts":
        return d.settings.texts(userId);
    }
  }

  private async state(userId: string, rev: number): Promise<UiState> {
    const [runtime, setup, key, chats, connections, settings, texts] = await Promise.all([this.part(userId, "runtime"), this.part(userId, "setup"), this.part(userId, "key"), this.part(userId, "chats"), this.part(userId, "connections"), this.part(userId, "settings"), this.part(userId, "texts")]);
    return { rev, runtime, setup, key, chats, running: this.deps.live.runningOf(userId), connections, settings, texts };
  }

  /** Parts of a user's state changed: their pages are told, once whatever is being sent to them has gone. */
  touch(userId: string, ...parts: UiStatePart[]): void {
    const user = this.users.get(userId);
    if (user === undefined) return;
    const idle = user.dirty.size === 0;
    for (const part of parts) user.dirty.add(part);
    if (idle && user.dirty.size > 0) void this.queue.run(userId, () => this.flush(userId));
  }

  /** Parts of every user's state changed (a permission was granted or taken away). */
  touchAll(...parts: UiStatePart[]): void {
    for (const userId of this.users.keys()) this.touch(userId, ...parts);
  }

  private async flush(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (user === undefined || user.dirty.size === 0) return;
    const parts = [...user.dirty];
    user.dirty.clear();
    const patch: Partial<Omit<UiState, "rev">> = {};
    for (const part of parts) {
      try {
        Object.assign(patch, { [part]: await this.part(userId, part) });
      } catch (error) {
        this.host.log("warn", `[LumiAH] the pages' ${part} couldn't be read (${wordsOf(error)})`);
      }
    }
    if (Object.keys(patch).length === 0) return;
    user.rev++;
    this.send({ lah: UI_VERSION, type: "lah.state", rev: user.rev, patch }, userId, undefined);
  }

  /** Resolves once every answer and push under way has gone (tests). */
  async settle(): Promise<void> {
    for (const userId of this.users.keys()) await this.queue.run(userId, async () => undefined);
  }

  // ---------------------------------------------------------------- requests

  private send(message: BackendToFrontend, userId: string, session: string | undefined): void {
    this.host.frontend.send(message, userId, session);
  }

  private fail(reqId: string, userId: string, session: string | undefined, code: UiErrorCode, message: string, problems?: UiProblem[]): void {
    this.send({ lah: UI_VERSION, type: "lah.error", reqId, code, message, ...(problems !== undefined ? { problems } : {}) }, userId, session);
  }

  /** One message from a page. True when it was one of the contract's (answered, or refused as malformed). */
  async message(payload: unknown, userId: string, session: string | undefined): Promise<boolean> {
    const read = uiRequestOf(payload);
    if (read === null) return false;
    if ("malformed" in read) {
      if (read.reqId !== null) this.fail(read.reqId, userId, session, "bad_request", read.malformed);
      return true;
    }
    const { request } = read;
    try {
      if (request.type === "lah.hello") {
        // The state is read and answered inside the user's queue, so no push leaves between the two: the page's next push is the revision after the one it was given.
        await this.queue.run(userId, async () => {
          let user = this.users.get(userId);
          if (user === undefined) {
            // A revision no page can hold from before this start, so a page that outlived a restart says hello again rather than apply a push to a state it no longer follows.
            user = { rev: this.deps.now(), dirty: new Set() };
            this.users.set(userId, user);
          }
          const body = await this.state(userId, user.rev);
          this.send({ lah: UI_VERSION, type: "lah.result", reqId: request.reqId, request: "lah.hello", body }, userId, session);
        });
        return true;
      }
      const body = await this.serve(request, userId, session);
      this.send({ lah: UI_VERSION, type: "lah.result", reqId: request.reqId, request: request.type, body } as BackendToFrontend, userId, session);
    } catch (error) {
      if (error instanceof UiRefused) this.fail(request.reqId, userId, session, error.code, error.message, error.problems);
      else if (error instanceof SettingsRefused) this.fail(request.reqId, userId, session, "invalid", error.message, error.problems);
      else if (error instanceof LinkRefused) this.fail(request.reqId, userId, session, LINK_CODES[error.code] ?? "internal", error.message);
      else {
        this.host.log("error", `[LumiAH] ${request.type} failed: ${wordsOf(error)}`);
        this.fail(request.reqId, userId, session, "internal", `LumiAH couldn't do that (${wordsOf(error)}).`);
      }
    }
    return true;
  }

  private async serve(r: Exclude<UiRequest, { type: "lah.hello" }>, userId: string, session: string | undefined): Promise<UiRequests[Exclude<UiRequestType, "lah.hello">]["result"]> {
    const d = this.deps;
    switch (r.type) {
      case "lah.chat.get":
        return { chat: await d.switch.view(userId, r.chatId) };
      case "lah.chat.set": {
        const chat = await d.switch.set(userId, r.chatId, r.on);
        this.touch(userId, "chats", "setup");
        return { chat };
      }
      case "lah.live.open":
        await d.chats.own(userId, r.chatId);
        return d.live.open(userId, r.chatId, session);
      case "lah.live.events": {
        const page = await d.live.events(userId, r.chatId, r.turn, r.from);
        if (page === null) throw new UiRefused("not_found", "That turn is no longer the chat's live one: open the chat's live view again.");
        return page;
      }
      case "lah.live.close":
        d.live.close(userId, r.chatId, session);
        return { closed: true };
      case "lah.turn.stop": {
        const relay = d.live.relayOf(userId, r.chatId, r.turn);
        if (relay === null) return { stopped: false };
        const why = "You stopped the reply from LumiAH's live view.";
        // The runtime is told, and the turn's calls under way are ended here too, so a runtime out of reach doesn't keep a model running.
        const told = d.relays.push(userId, relay, { link: LINK, type: "stop", turn: r.turn, why });
        return { stopped: d.streams.stopTurn(userId, r.turn, why) > 0 || told };
      }
      case "lah.turns.list":
        return d.sessions.list(userId, r.chatId, r.cursor, r.limit);
      case "lah.transcript.get":
        return d.sessions.transcript(userId, r.chatId, r.transcript, r.from);
      case "lah.prompt.get":
        return { prompt: await d.sessions.prompt(userId, r.prompt) };
      case "lah.blob.get":
        return { text: await d.sessions.blob(userId, r.hash) };
      case "lah.session.rollback":
        return d.sessions.rollback(userId, r.chatId, r.messageId, r.swipe);
      case "lah.settings.set":
        return { settings: await d.settings.change(userId, r.set, r.reset) };
      case "lah.models.list": {
        const connection = await d.connections.one(userId, r.connectionId);
        if (connection === null) throw new UiRefused("not_found", r.connectionId === null ? "This account has no default connection." : "There is no such connection.");
        const models = await this.host.connections.models(connection.id, userId);
        if (models === null) throw new UiRefused("unavailable", "This Lumiverse can't list a connection's models: type the model's name.");
        return { models };
      }
      case "lah.text.set":
        return { texts: await d.settings.text(userId, r.id, r.text) };
      case "lah.text.reset":
        return { texts: await d.settings.text(userId, r.id, null) };
      case "lah.key": {
        const out = r.op === "mint" ? await d.keys.mint(userId) : await d.keys.forget(userId);
        this.touch(userId, "key", "setup", "connections", "chats");
        return { ...out, view: await this.key(userId) };
      }
      case "lah.relay": {
        if (r.op === "rotate") await d.relays.rotate(userId, r.relay);
        else {
          await d.relays.forget(userId, r.relay);
          d.streams.forget(userId, r.relay);
        }
        return { runtime: await d.relays.view(userId, d.issues()) };
      }
    }
  }
}
