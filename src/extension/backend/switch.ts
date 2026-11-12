// The per-chat switch (DESIGN §8 "which chats LumiAH answers", §25): whether LumiAH is on for a
// chat. Switched on, the chat is pinned to the user's loopback connection (Lumiverse's own per-chat
// pin, in the chat's metadata), since the runtime answers exactly the replies that reach it there.
// Switched off, the chat gets back the pin it had. What the chat had is remembered in the user's
// storage, so it outlives a restart.
//
// A user may have LumiAH and an extension that has LumiAH built in installed together (§21). Each
// sees every reply's prompt, so each must know a chat is the other's. Lumiverse keeps one
// extension's storage from another, and the chat's metadata is what both can read: a chat that is
// switched on bears its backend's mark there, under that backend's own key. A chat that bears
// another's mark, or generates on another's loopback connection, is none of this one's: it isn't
// worked on, and it can't be switched on here until it is switched off there, or the user takes
// it over here (the page asks them first): the other's mark is then removed, whether or not that
// extension is still installed, and the chat gets back the connection it had before that
// extension pinned it, which a mark says for this reason.
//
// The runtime has no stand-in (§25): a chat whose runtime isn't linked fails its replies until the
// runtime is back. The chat's view says so (`away`). A chat is pinned whenever a loopback connection
// is there to pin it to, linked or not; only with no loopback connection at all is switching it on
// refused, in words that say how to set one up. A chat switched on by a build that could run it
// inside Lumiverse (LumiAH's `main` branch) isn't pinned, so it reads as off until it is switched on
// again.
//
// The chat's own choice of what counts as its story (§24.4) is kept beside its other choices, while
// the chat is off too. The core reads it with the chat (`info`), and the pages see it with what
// stands over it and under it (`story`).

import type { ChatClaim, ClaimAsk } from "../../core/extension";
import type { ChatInfo, JsonValue } from "../../core/ports";
import { settingTitle } from "../../core/settings";
import { type StorySetting, storyHolds, storyWordOf } from "../../core/story";
import { type Limit, limitOf, timerMs } from "../../core/util";
import { isRecord } from "../../link/json";
import { spanWords } from "../../link/waits";
import { timeoutPlace } from "../../shared/timeouts";
import type { ChatLeadView, ChatStoryView, ChatView } from "../../shared/ui";
import type { Chats } from "./chat";
import type { ChatConnection, Connections } from "./connections";
import { UserDocs } from "./docs";
import { LinkRefused, UiRefused } from "./errors";
import type { BackendIdentity } from "./identity";
import type { BackendHost, HostChat } from "./spindle";

/** Lumiverse's keys for a chat's own connection and model, in the chat's metadata. */
const PIN = "connection_profile_id";
const PIN_MODEL = "connection_model";

/**
 * Where a backend's mark sits in a chat's metadata: this, then the backend's identifier. Every
 * backend made of LumiAH's code writes its own and reads the others' by the same start, which is
 * why it is fixed.
 */
const MARK = "lumiah_chat_";

interface Switched {
  since: number;
  /** The connection the chat was pinned to before the loopback, and its model override; null: it had none. */
  prior: string | null;
  priorModel: JsonValue | null;
}

interface Stored {
  v: 1;
  on: Record<string, Switched>;
  /** Each chat's own choice of what counts as its story, by the chat's id; a chat that isn't here follows Settings. Absent from what an earlier build stored. */
  story: Record<string, Partial<StorySetting>>;
}

function storedOf(raw: unknown): Stored | null {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.on)) return null;
  const on: Record<string, Switched> = {};
  for (const [chatId, s] of Object.entries(raw.on)) {
    if (!isRecord(s) || typeof s.since !== "number") continue;
    on[chatId] = { since: s.since, prior: typeof s.prior === "string" ? s.prior : null, priorModel: s.priorModel === undefined ? null : (s.priorModel as JsonValue) };
  }
  const story: Record<string, Partial<StorySetting>> = {};
  if (isRecord(raw.story)) {
    for (const [chatId, chosen] of Object.entries(raw.story)) {
      const word = storyWordOf(chosen);
      if (Object.keys(word).length > 0) story[chatId] = word;
    }
  }
  return { v: 1, on, story };
}

export interface SwitchDeps {
  chats: Chats;
  connections: Connections;
  /** The runtime a chat's replies reach (the one behind the loopback connection the chat generates on), by its relay id and name; null while it isn't linked. */
  runtimeOf(userId: string, chatId: string): Promise<{ id: string; name: string } | null>;
  /** Why LumiAH can answer no chat now, in words that say what to do (a permission it needs is missing); null when it can. */
  blocked(): string | null;
  /** Who this backend is: its identifier keys its mark on a chat, its name is what another backend's pages call it, and where its Settings are shown is where a wait's words send the user. */
  identity: Pick<BackendIdentity, "identifier" | "name" | "settingsAt">;
  now(): number;
  /** Runs `fn` once after `ms`; what it returns cancels that. */
  later(ms: number, fn: () => void): () => void;
  /** The user's own setting of what counts as the story (Settings), which a chat's choice stands over. */
  storySetting(userId: string): Promise<StorySetting>;
  /** The user's Wait for the extension: how long a run waits for the extension's claim on a chat. */
  extensionWait(userId: string): Promise<Limit>;
  /** The extension that answers this backend's chats, by its name, and what it says of a chat: its claim; null where it claims nothing; `failed`, with why, where it gave no answer. Absent where it supplies no claims. */
  claimer?: { name: string; claim(ask: ClaimAsk, userId: string): Promise<{ claim: ChatClaim } | { failed: string } | null> };
}

export class ChatSwitch {
  private readonly docs: UserDocs<Stored>;
  private readonly markKey: string;

  constructor(
    private readonly host: Pick<BackendHost, "chats" | "storage" | "log">,
    private readonly deps: SwitchDeps,
  ) {
    this.docs = new UserDocs<Stored>(host, "chats.json", storedOf, () => ({ v: 1, on: {}, story: {} }));
    this.markKey = `${MARK}${deps.identity.identifier}`;
  }

  /** The marks other backends left on a chat: each one's key in the chat's metadata, whose it is, and the connection the chat had before that backend pinned it to its own loopback, where its mark says. */
  private marks(chat: HostChat): { key: string; identifier: string; name: string; prior: string | null; priorModel: JsonValue | null }[] {
    const out: { key: string; identifier: string; name: string; prior: string | null; priorModel: JsonValue | null }[] = [];
    for (const [key, mark] of Object.entries(chat.metadata)) {
      if (!key.startsWith(MARK) || key === this.markKey) continue;
      // A mark names the chat it was made on. One that came along with a copy of the chat (a branch) names another chat, and marks nothing here.
      if (!isRecord(mark) || mark.chat !== chat.id) continue;
      const identifier = key.slice(MARK.length);
      out.push({ key, identifier, name: typeof mark.name === "string" && mark.name !== "" ? mark.name : identifier, prior: typeof mark.prior === "string" && mark.prior !== "" ? mark.prior : null, priorModel: mark.priorModel === undefined ? null : (mark.priorModel as JsonValue) });
    }
    return out;
  }

  /**
   * The other backend that answers a chat: one whose mark the chat bears, or whose loopback
   * connection the chat generates on. Null when the chat is nobody else's.
   */
  private other(chat: HostChat, connection: ChatConnection | null): { identifier: string; name: string } | null {
    const [marked] = this.marks(chat);
    if (marked !== undefined) return { identifier: marked.identifier, name: marked.name };
    return connection !== null && connection.foreign !== null ? { identifier: connection.foreign, name: connection.name } : null;
  }

  /**
   * What takes a chat from the backend that answered it: every other backend's mark goes, and a
   * pin to that backend's loopback connection gives way to the connection the chat had before,
   * where a mark says which and that connection is still there (else to none: the chat generates
   * on the connection selected in Lumiverse). Nothing here asks the other backend: it may be gone.
   */
  private async takeFrom(userId: string, chat: HostChat, connection: ChatConnection | null, loops: readonly string[]): Promise<Record<string, JsonValue>> {
    const marks = this.marks(chat);
    const patch: Record<string, JsonValue> = {};
    for (const mark of marks) patch[mark.key] = null;
    if (connection === null || connection.foreign === null) return patch;
    // The chat generates on the other's loopback. Where that is the connection selected in Lumiverse and no pin of the chat's, it is the user's to select another: nothing on the chat would change it.
    if (chat.metadata[PIN] !== connection.id) throw new UiRefused("unavailable", `This chat generates on "${connection.name}" because that is the connection selected in Lumiverse, and its replies go to that connection's own runtime. Select another connection in Lumiverse, then take the chat over.`);
    const said = marks.find((mark) => mark.prior !== null);
    const prior = said?.prior ?? null;
    const back = prior !== null && prior !== connection.id && !loops.includes(prior) && (await this.deps.connections.one(userId, prior)) !== null ? prior : null;
    patch[PIN] = back;
    patch[PIN_MODEL] = back !== null ? (said?.priorModel ?? null) : null;
    return patch;
  }

  private async viewOf(userId: string, chat: HostChat): Promise<ChatView> {
    const connection = await this.deps.connections.ofChat(userId, chat);
    const switched = (await this.docs.get(userId)).on[chat.id];
    const other = this.other(chat, connection);
    // On only while the pin it made still stands: a chat pinned elsewhere since is answered by that connection, whatever was asked here. And never while the chat is another backend's.
    const pinned = connection?.loopback === true && chat.metadata[PIN] === connection.id;
    const on = other === null && switched !== undefined && pinned;
    // The runtime that plays it, while it is linked; one that isn't: nothing answers its replies there, and nothing here does in its place.
    const runtime = on ? await this.deps.runtimeOf(userId, chat.id) : null;
    const away = on && runtime === null;
    return { chatId: chat.id, name: chat.name === "" ? null : chat.name, on, since: on ? switched.since : null, connection: connection === null ? null : { id: connection.id, name: connection.name, loopback: connection.loopback }, ...(other !== null ? { other } : {}), ...(runtime !== null ? { runtime } : {}), ...(away ? { away: true as const } : {}) };
  }

  /** `lah.chat.get`: a chat as the pages show it. */
  async view(userId: string, chatId: string): Promise<ChatView> {
    return this.viewOf(userId, await this.deps.chats.own(userId, chatId));
  }

  /** The user's own choice of what counts as a chat's story; empty where they made none. */
  async storyChoice(userId: string, chatId: string): Promise<Partial<StorySetting>> {
    const chosen = (await this.docs.get(userId)).story[chatId];
    return chosen === undefined ? {} : { ...chosen };
  }

  /** `chat.info` as the core reads it (§24.4): the chat itself, with the user's own choice of what counts as its story and whether Lumiverse's Sovereign Hand is on for it; null when the user has no such chat. */
  async info(userId: string, chatId: string): Promise<ChatInfo | null> {
    const info = await this.deps.chats.info(userId, chatId);
    if (info === null) return null;
    const [chosen, sovereignHand] = await Promise.all([this.storyChoice(userId, chatId), this.host.chats.sovereignHand(chatId, userId)]);
    return { ...info, ...(Object.keys(chosen).length > 0 ? { story: chosen } : {}), sovereignHand };
  }

  /** What a claim on a chat is asked with, read here (never as a runtime described it): the chat, and what counts as its story without the extension's word; null when the user has no such chat. */
  async claimAsk(userId: string, chatId: string, setting?: StorySetting): Promise<ClaimAsk | null> {
    const chat = await this.info(userId, chatId);
    if (chat === null) return null;
    const sovereignHand = chat.sovereignHand ?? null;
    const below = storyHolds({ chat: chat.story ?? null, user: setting ?? (await this.deps.storySetting(userId)), sovereignHand });
    return { userId, chatId: chat.id, chat, story: below.source, sovereignHand };
  }

  /** `lah.chat.story.get`: what counts as a chat's story, as the pages show it. */
  async story(userId: string, chatId: string): Promise<ChatStoryView> {
    await this.deps.chats.own(userId, chatId);
    const setting = await this.deps.storySetting(userId);
    const ask = await this.claimAsk(userId, chatId, setting);
    if (ask === null) throw new LinkRefused("not_found", "There is no such chat in this account.");
    const chosen = ask.chat.story ?? {};
    const { claimer } = this.deps;
    const answered = claimer === undefined ? null : await claimer.claim(ask, userId);
    // A claim that gave no answer says nothing of the story here: the log says so, and the chat's and the user's words stand.
    const said = claimer !== undefined && answered !== null && "claim" in answered ? { by: claimer.name, claim: answered.claim } : null;
    // What the page shows as the extension's word is what its claim says of the story: a claim that says nothing of it leaves the chat's and the user's to stand.
    const word = storyWordOf(said?.claim.story);
    const claimed = said !== null && Object.keys(word).length > 0 ? { by: said.by, story: word } : null;
    return { chatId, chosen, setting, claimed, sovereignHand: ask.sovereignHand, holds: storyHolds({ claim: claimed?.story ?? null, chat: chosen, user: setting, sovereignHand: ask.sovereignHand }) };
  }

  /**
   * `lah.chat.lead.get`: who leads a chat's replies, as the extension that answers this backend's
   * chats claims it: the agent its claim names (null: none, so LumiAH's main agent leads), and
   * whether the reply is only what the agents release; or that it gave no answer, with why. Null
   * where it doesn't claim the chat, or supplies no claims.
   */
  async lead(userId: string, chatId: string): Promise<ChatLeadView | null> {
    await this.deps.chats.own(userId, chatId);
    const { claimer } = this.deps;
    if (claimer === undefined) return null;
    const ask = await this.claimAsk(userId, chatId);
    if (ask === null) throw new LinkRefused("not_found", "There is no such chat in this account.");
    // A reply in this chat waits for the claim no longer than Wait for the extension, and doesn't start without it: a claim that comes later is no answer here either, so the page never shows a lead every reply would be refused under.
    const ms = timerMs(limitOf(await this.deps.extensionWait(userId)));
    const late = Promise.withResolvers<{ late: string }>();
    const place = timeoutPlace(["core", "extension", "waitMs"], settingTitle(["extension", "waitMs"]), this.deps.identity);
    const cancel = ms === null ? (): void => undefined : this.deps.later(ms, () => late.resolve({ late: `nothing within ${spanWords(ms)}; ${place} says how long a reply waits for it` }));
    const said = await Promise.race([claimer.claim(ask, userId), late.promise]).finally(cancel);
    if (said === null) return null;
    if ("late" in said) return { by: claimer.name, unanswered: said.late };
    if ("failed" in said) return { by: claimer.name, unanswered: said.failed };
    // The claim is the extension's answer: only a name it gives is an agent's.
    const { mainAgent, reply } = said.claim as { mainAgent?: unknown; reply?: unknown };
    return { by: claimer.name, lead: typeof mainAgent === "string" && mainAgent !== "" ? mainAgent : null, released: reply === "released" };
  }

  /** `lah.chat.story.set`: the chat's own choice, whole (each member left out follows Settings), kept while the chat is off too. */
  async setStory(userId: string, chatId: string, story: Partial<StorySetting>): Promise<ChatStoryView> {
    await this.deps.chats.own(userId, chatId);
    const chosen = storyWordOf(story);
    await this.docs.change(userId, (doc) => {
      if (Object.keys(chosen).length === 0) delete doc.story[chatId];
      else doc.story[chatId] = chosen;
    });
    return this.story(userId, chatId);
  }

  /** What puts back the pin a chat had before LumiAH pinned it to a loopback: none when it had none, or the one it had is a loopback itself. A pin someone made since, to another connection, is theirs and stays: nothing is changed then. */
  private unpin(chat: HostChat, switched: Switched | undefined, loops: readonly string[]): Record<string, JsonValue> {
    const pin = typeof chat.metadata[PIN] === "string" ? chat.metadata[PIN] : null;
    if (pin === null || !loops.includes(pin)) return {};
    const prior = switched?.prior ?? null;
    const back = prior !== null && !loops.includes(prior) ? prior : null;
    return { [PIN]: back, [PIN_MODEL]: back !== null ? (switched?.priorModel ?? null) : null };
  }

  /**
   * `lah.chat.set`: switches LumiAH on for a chat or off. On, the chat is pinned to the loopback
   * connection and bears this backend's mark; off, it gets back the pin it had and the mark is
   * taken away. A chat is pinned whenever a loopback connection is there to pin it to, linked or
   * not (its view says `away` until a runtime links); with no loopback connection at all it is
   * refused, in words that say how to set one up. `takeover` (`lah.chat.takeover`): a chat another
   * backend answers is taken from it first.
   */
  async set(userId: string, chatId: string, on: boolean, takeover = false): Promise<ChatView> {
    const { chats, connections, identity } = this.deps;
    const chat = await chats.own(userId, chatId);
    const doc = await this.docs.get(userId);
    const switched = doc.on[chatId];
    const loops = (await connections.loopbacks(userId)).map((c) => c.id);
    const pin = typeof chat.metadata[PIN] === "string" ? chat.metadata[PIN] : null;
    const pinnedLoop = pin !== null && loops.includes(pin);
    if (!on) {
      const patch = { ...this.unpin(chat, switched, loops), ...(chat.metadata[this.markKey] !== undefined ? { [this.markKey]: null } : {}) };
      if (Object.keys(patch).length > 0) await this.host.chats.patchMetadata(chatId, patch, userId);
      if (switched !== undefined) {
        await this.docs.change(userId, (d) => {
          delete d.on[chatId];
        });
      }
      return this.viewOf(userId, await chats.own(userId, chatId));
    }
    const blocked = this.deps.blocked();
    if (blocked !== null) throw new UiRefused("unavailable", blocked);
    const connection = await connections.ofChat(userId, chat);
    const other = this.other(chat, connection);
    if (other !== null && !takeover) throw new UiRefused("unavailable", `${other.name} answers this chat. Switch it off there first: two harnesses would both work on each of its replies. Or take the chat over here, which takes it from ${other.name}.`);
    const loop = loops[0];
    if (loop === undefined) throw new UiRefused("unavailable", `There is no runtime to answer this chat yet. Start one with its line on ${identity.name}'s Runtime page and mint its key there, then switch the chat on.`);
    const taken = other !== null ? await this.takeFrom(userId, chat, connection, loops) : {};
    // The pin the chat had before this backend's own: what a takeover put back, else what the chat bears.
    const pinBefore = PIN in taken ? (typeof taken[PIN] === "string" ? taken[PIN] : null) : pin;
    const modelBefore: JsonValue | null = PIN in taken ? (taken[PIN_MODEL] ?? null) : (chat.metadata[PIN_MODEL] ?? null);
    const prior = pinnedLoop ? (switched?.prior ?? null) : pinBefore;
    const priorModel = pinnedLoop ? (switched?.priorModel ?? null) : modelBefore;
    const since = switched?.since ?? this.deps.now();
    // The mark says which connection the chat had before the pin: whoever takes the chat over can't read this backend's storage, and puts that connection back from here.
    const mark: JsonValue = { v: 1, chat: chatId, name: identity.name, since, ...(prior !== null ? { prior, priorModel } : {}) };
    // Pinned to the loopback already (by hand, or by an earlier switch): the pin stands, with no earlier pin to put back that isn't already remembered.
    await this.host.chats.patchMetadata(chatId, { ...taken, ...(pinnedLoop ? {} : { [PIN]: loop, [PIN_MODEL]: null }), [this.markKey]: mark }, userId);
    if (switched === undefined || !pinnedLoop) {
      await this.docs.change(userId, (d) => {
        d.on[chatId] = { since, prior, priorModel };
      });
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
        for (const chatId of gone) {
          delete doc.on[chatId];
          delete doc.story[chatId];
        }
      });
    }
    return out;
  }

  /** Resolves once every write is done (tests). */
  settle(): Promise<void> {
    return this.docs.settle();
  }
}
