// The per-chat switch (DESIGN §8 Runtime: "which chats LumiAH answers"). LumiAH answers a chat
// exactly when the connection it generates on is a loopback, so switching it on for a chat pins the
// chat to the user's loopback connection (Lumiverse's own per-chat pin, in the chat's metadata), and
// switching it off puts back the pin the chat had. What the chat had is remembered in the user's
// storage, so it outlives a restart.

import type { JsonValue } from "../../core/ports";
import { isRecord } from "../../link/json";
import type { ChatView } from "../../shared/ui";
import type { Chats } from "./chat";
import type { Connections } from "./connections";
import { UserDocs } from "./docs";
import { LinkRefused, UiRefused } from "./errors";
import type { BackendHost, HostChat } from "./spindle";

/** Lumiverse's keys for a chat's own connection and model, in the chat's metadata. */
const PIN = "connection_profile_id";
const PIN_MODEL = "connection_model";

interface Switched {
  since: number;
  /** The connection the chat was pinned to before, and its model override; null: it had none. */
  prior: string | null;
  priorModel: JsonValue | null;
}

interface Stored {
  v: 1;
  on: Record<string, Switched>;
}

function storedOf(raw: unknown): Stored | null {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.on)) return null;
  const on: Record<string, Switched> = {};
  for (const [chatId, s] of Object.entries(raw.on)) {
    if (!isRecord(s) || typeof s.since !== "number") continue;
    on[chatId] = { since: s.since, prior: typeof s.prior === "string" ? s.prior : null, priorModel: s.priorModel === undefined ? null : (s.priorModel as JsonValue) };
  }
  return { v: 1, on };
}

export interface SwitchDeps {
  chats: Chats;
  connections: Connections;
  now(): number;
}

export class ChatSwitch {
  private readonly docs: UserDocs<Stored>;

  constructor(
    private readonly host: Pick<BackendHost, "chats" | "storage" | "log">,
    private readonly deps: SwitchDeps,
  ) {
    this.docs = new UserDocs<Stored>(host, "chats.json", storedOf, () => ({ v: 1, on: {} }));
  }

  private async viewOf(userId: string, chat: HostChat): Promise<ChatView> {
    const connection = await this.deps.connections.ofChat(userId, chat);
    const switched = (await this.docs.get(userId)).on[chat.id];
    // On only while the pin it made still stands: a chat pinned elsewhere since is answered by that connection, whatever was asked here.
    const on = switched !== undefined && connection?.loopback === true && chat.metadata[PIN] === connection.id;
    return { chatId: chat.id, name: chat.name === "" ? null : chat.name, on, since: on ? switched.since : null, connection };
  }

  /** `lah.chat.get`: a chat as the pages show it. */
  async view(userId: string, chatId: string): Promise<ChatView> {
    return this.viewOf(userId, await this.deps.chats.own(userId, chatId));
  }

  /** `lah.chat.set`: on pins the chat to the loopback connection, off puts back the pin it had. */
  async set(userId: string, chatId: string, on: boolean): Promise<ChatView> {
    const { chats, connections } = this.deps;
    const chat = await chats.own(userId, chatId);
    const loops = await connections.loopbacks(userId);
    const pin = typeof chat.metadata[PIN] === "string" ? (chat.metadata[PIN] as string) : null;
    const pinnedLoop = pin !== null && loops.some((c) => c.id === pin);
    if (on) {
      const loop = loops[0];
      if (loop === undefined) throw new UiRefused("unavailable", "There is no loopback connection yet. Mint a loopback key on the Runtime page: your linked runtime makes the connection with it.");
      if (!pinnedLoop) {
        await this.host.chats.patchMetadata(chatId, { [PIN]: loop.id, [PIN_MODEL]: null }, userId);
        await this.docs.change(userId, (doc) => {
          doc.on[chatId] = { since: this.deps.now(), prior: pin, priorModel: chat.metadata[PIN_MODEL] ?? null };
        });
      } else if ((await this.docs.get(userId)).on[chatId] === undefined) {
        // Pinned to the loopback by hand: LumiAH takes it as switched on, with no earlier pin to put back.
        await this.docs.change(userId, (doc) => {
          doc.on[chatId] = { since: this.deps.now(), prior: null, priorModel: null };
        });
      }
    } else {
      const switched = (await this.docs.get(userId)).on[chatId];
      // A pin someone made since, to another connection, is theirs and stays.
      if (pinnedLoop) {
        const prior = switched?.prior ?? null;
        const back = prior !== null && !loops.some((c) => c.id === prior) ? prior : null;
        await this.host.chats.patchMetadata(chatId, { [PIN]: back, [PIN_MODEL]: back !== null ? (switched?.priorModel ?? null) : null }, userId);
      }
      if (switched !== undefined) {
        await this.docs.change(userId, (doc) => {
          delete doc.on[chatId];
        });
      }
    }
    return this.viewOf(userId, await chats.own(userId, chatId));
  }

  /** Whether any chat of the user's is switched on. */
  async any(userId: string): Promise<boolean> {
    return Object.keys((await this.docs.get(userId)).on).length > 0;
  }

  /** The chats LumiAH is switched on for, then the others it has answered (`answered`), each once. A chat that is gone is forgotten. */
  async list(userId: string, answered: readonly string[]): Promise<ChatView[]> {
    const switched = Object.keys((await this.docs.get(userId)).on);
    const out: ChatView[] = [];
    const gone: string[] = [];
    for (const chatId of new Set([...switched, ...answered])) {
      try {
        out.push(await this.view(userId, chatId));
      } catch (error) {
        if (!(error instanceof LinkRefused && error.code === "not_found")) throw error;
        if (switched.includes(chatId)) gone.push(chatId);
      }
    }
    if (gone.length > 0) {
      await this.docs.change(userId, (doc) => {
        for (const chatId of gone) delete doc.on[chatId];
      });
    }
    return out;
  }

  /** Resolves once every write is done (tests). */
  settle(): Promise<void> {
    return this.docs.settle();
  }
}
