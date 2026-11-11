// The per-chat switch (DESIGN §8 "which chats LumiAH answers", §25): whether LumiAH is on for a
// chat, and where the chat's turns run.
//
// - Built in (the default): the chat keeps its own connection, and the prompt interceptor works on
//   its replies because the switch says so.
// - In a runtime: the chat is pinned to the user's loopback connection (Lumiverse's own per-chat
//   pin, in the chat's metadata), since the runtime answers exactly the replies that reach it there.
//   Switched off, or set to run built in, the chat gets back the pin it had.
//
// What the chat had, and where a chat that is off ran last, are remembered in the user's storage,
// so both outlive a restart.
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
// The runtime way has no fallback (§25): a chat set to run in a runtime that isn't linked fails
// its replies until the runtime is back or the user sets the chat to run built in. The chat's view
// says so (`away`), so a page can offer that one tap.
//
// A chat the extension that answers it plays only in a runtime (its claim's `place`, §21) has no
// built-in way at all: its view says so (`needsRuntime`), so the pages offer no built-in choice;
// switching it on pins it to the loopback connection whether or not a runtime is linked just then;
// it is never worked on built in, though it was switched on built in before the extension said so
// (it then reads as off, until it is switched on again); and its words never offer built in.
//
// The chat's own choice of what counts as its story (§24.4) is kept beside its other choices, while
// the chat is off too. The core reads it with the chat (`info`), and the pages see it with what
// stands over it and under it (`story`).

import type { ChatClaim, ClaimAsk } from "../../core/extension";
import type { ChatInfo, JsonValue } from "../../core/ports";
import { type StorySetting, storyHolds, storyWordOf } from "../../core/story";
import { isRecord } from "../../link/json";
import type { ChatStoryView, ChatView, RunPlace } from "../../shared/ui";
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
  /** Where its turns run. A chat switched on before there were two places has none stored: it was pinned to the loopback, so it runs in the runtime. */
  place: RunPlace;
  /** In a runtime: the connection the chat was pinned to before, and its model override; null: it had none. */
  prior: string | null;
  priorModel: JsonValue | null;
}

interface Stored {
  v: 1;
  on: Record<string, Switched>;
  /** The chats that ran in a runtime when they were last switched off: switched on again with no place named, each runs there again. A chat that isn't here runs built in. */
  ran: Record<string, true>;
  /** Each chat's own choice of what counts as its story, by the chat's id; a chat that isn't here follows Settings. Absent from what an earlier build stored. */
  story: Record<string, Partial<StorySetting>>;
}

function storedOf(raw: unknown): Stored | null {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.on)) return null;
  const on: Record<string, Switched> = {};
  for (const [chatId, s] of Object.entries(raw.on)) {
    if (!isRecord(s) || typeof s.since !== "number") continue;
    on[chatId] = { since: s.since, place: s.place === "builtin" ? "builtin" : "runtime", prior: typeof s.prior === "string" ? s.prior : null, priorModel: s.priorModel === undefined ? null : (s.priorModel as JsonValue) };
  }
  const ran: Record<string, true> = {};
  if (isRecord(raw.ran)) for (const chatId of Object.keys(raw.ran)) ran[chatId] = true;
  const story: Record<string, Partial<StorySetting>> = {};
  if (isRecord(raw.story)) {
    for (const [chatId, chosen] of Object.entries(raw.story)) {
      const word = storyWordOf(chosen);
      if (Object.keys(word).length > 0) story[chatId] = word;
    }
  }
  return { v: 1, on, ran, story };
}

export interface SwitchDeps {
  chats: Chats;
  connections: Connections;
  /** Whether a runtime is there to choose: one is linked, the loopback key is minted and the loopback connection is made (`RuntimeView.ready`). */
  runtimeReady(userId: string): Promise<boolean>;
  /** Whether the runtime a chat's replies reach (the one behind the loopback connection the chat generates on) is linked now. */
  runtimeLinked(userId: string, chatId: string): Promise<boolean>;
  /** Why LumiAH can answer no chat in that place now, in words that say what to do (a permission it needs there is missing); null when it can. */
  blocked(place: RunPlace): string | null;
  /** Who this backend is: its identifier keys its mark on a chat, and its name is what another backend's pages call it. */
  identity: Pick<BackendIdentity, "identifier" | "name">;
  now(): number;
  /** The user's own setting of what counts as the story (Settings), which a chat's choice stands over. */
  storySetting(userId: string): Promise<StorySetting>;
  /** What the extension that answers this backend's chats says of a chat: its claim, with its name. Null where it claims nothing or gave no answer. Absent where it supplies no claims. */
  claim?(ask: ClaimAsk, userId: string): Promise<{ by: string; claim: ChatClaim } | null>;
  /** Every chat of this backend plays only in a runtime (`BackendOptions.place`), whatever a claim says. */
  only?: true;
}

export class ChatSwitch {
  private readonly docs: UserDocs<Stored>;
  private readonly markKey: string;

  constructor(
    private readonly host: Pick<BackendHost, "chats" | "storage" | "log">,
    private readonly deps: SwitchDeps,
  ) {
    this.docs = new UserDocs<Stored>(host, "chats.json", storedOf, () => ({ v: 1, on: {}, ran: {}, story: {} }));
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
    const doc = await this.docs.get(userId);
    const switched = doc.on[chat.id];
    const needs = await this.needsRuntime(userId, chat.id);
    // A chat its extension plays only in a runtime runs nowhere else, whatever was kept for it before the extension said so.
    const place: RunPlace = needs !== null ? "runtime" : (switched?.place ?? (doc.ran[chat.id] ? "runtime" : "builtin"));
    const other = this.other(chat, connection);
    // In a runtime, on only while the pin it made still stands: a chat pinned elsewhere since is answered by that connection, whatever was asked here. And never while the chat is another backend's. A chat switched on built in before its extension asked for the runtime is off until it is switched on again, which pins it.
    const pinned = connection?.loopback === true && chat.metadata[PIN] === connection.id;
    const on = other === null && switched !== undefined && ((switched.place === "builtin" && needs === null) || pinned);
    // Set to run in a runtime that isn't linked now: nothing answers its replies there, and nothing here does in its place.
    const away = on && place === "runtime" && !(await this.deps.runtimeLinked(userId, chat.id));
    return { chatId: chat.id, name: chat.name === "" ? null : chat.name, on, since: on ? switched.since : null, place, connection: connection === null ? null : { id: connection.id, name: connection.name, loopback: connection.loopback }, ...(other !== null ? { other } : {}), ...(away ? { away: true as const } : {}), ...(needs !== null ? { needsRuntime: needs } : {}) };
  }

  /**
   * Whether a chat plays only in a runtime, and the name of the extension that says so: every chat
   * of a backend that plays its chats only there, else a chat whose claim's `place` says so. Null
   * where neither does, the extension supplies no claims or gave no answer, or the user has no such
   * chat.
   */
  async needsRuntime(userId: string, chatId: string): Promise<{ by: string } | null> {
    if (this.deps.only === true) return { by: this.deps.identity.name };
    const claimed = await this.claimed(userId, chatId);
    return claimed?.claim.place === "runtime" ? { by: claimed.by } : null;
  }

  /**
   * The connection an agent with none of its own runs on in a run of this chat, which plays in a
   * runtime (§25): the one the chat was on before it was pinned to the loopback (`chat`), while it
   * is there and is no loopback; else Lumiverse's default connection (`default`), unless that is a
   * loopback. Null: neither, and the agent can't run.
   */
  async agentConnection(userId: string, chatId: string): Promise<{ id: string; from: "chat" | "default" } | null> {
    const prior = (await this.docs.get(userId)).on[chatId]?.prior ?? null;
    const tries: [string | null, "chat" | "default"][] = prior !== null ? [[prior, "chat"], [null, "default"]] : [[null, "default"]];
    for (const [id, from] of tries) {
      const found = await this.deps.connections.resolve(userId, id);
      if (found !== null && !found.loopback) return { id: found.connection.id, from };
    }
    return null;
  }

  /** The extension's claim on a chat, asked with what a claim is asked with (read here); null without one. */
  private async claimed(userId: string, chatId: string, setting?: StorySetting): Promise<{ by: string; claim: ChatClaim } | null> {
    if (this.deps.claim === undefined) return null;
    const ask = await this.claimAsk(userId, chatId, setting);
    return ask === null ? null : this.deps.claim(ask, userId);
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
    const said = this.deps.claim === undefined ? null : await this.deps.claim(ask, userId);
    // What the page shows as the extension's word is what its claim says of the story: a claim that says nothing of it leaves the chat's and the user's to stand.
    const word = storyWordOf(said?.claim.story);
    const claimed = said !== null && Object.keys(word).length > 0 ? { by: said.by, story: word } : null;
    return { chatId, chosen, setting, claimed, sovereignHand: ask.sovereignHand, holds: storyHolds({ claim: claimed?.story ?? null, chat: chosen, user: setting, sovereignHand: ask.sovereignHand }) };
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

  /**
   * Whether a chat is switched on to run built in, and still this backend's. What is remembered
   * says no for every chat that isn't switched on here without asking Lumiverse anything, so the
   * prompt interceptor can ask this of every reply of every chat; only a chat that is switched on
   * is looked at, for another backend's mark or loopback.
   */
  async builtin(userId: string, chatId: string): Promise<boolean> {
    if ((await this.docs.get(userId)).on[chatId]?.place !== "builtin") return false;
    const chat = await this.deps.chats.own(userId, chatId);
    // Never a chat its extension plays only in a runtime, though it was switched on built in before the extension said so.
    return this.other(chat, await this.deps.connections.ofChat(userId, chat)) === null && (await this.needsRuntime(userId, chatId)) === null;
  }

  /**
   * Where what is asked about a chat is done (§25): in a runtime while the chat generates on a
   * loopback connection (its replies reach the runtime there, however it came to be on one), else
   * built in. A chat's jobs and side sessions run where its turns run.
   */
  async placeOf(userId: string, chatId: string): Promise<RunPlace> {
    const chat = await this.deps.chats.own(userId, chatId);
    return (await this.deps.connections.ofChat(userId, chat))?.loopback === true ? "runtime" : "builtin";
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
   * `lah.chat.set`: switches LumiAH on for a chat or off, and says where its turns run. `place`
   * left out: where it ran before, built in for a chat never set. Built in pins nothing; a runtime
   * pins the chat to the loopback connection; off, and a change from the runtime to built in, puts
   * back the pin the chat had. On, the chat bears this backend's mark; off, the mark is taken away.
   * `takeover` (`lah.chat.takeover`): a chat another backend answers is taken from it first.
   *
   * A chat its extension plays only in a runtime (`needsRuntime`) goes to the runtime whatever is
   * asked: built in is refused, except by a takeover, which takes it to the runtime. It is pinned
   * whenever a loopback connection is there to pin it to, linked or not (its view says `away` until
   * a runtime links); only with no loopback connection at all is it refused, in words that say how
   * to set one up.
   */
  async set(userId: string, chatId: string, on: boolean, place?: RunPlace, takeover = false): Promise<ChatView> {
    const { chats, connections, identity } = this.deps;
    const chat = await chats.own(userId, chatId);
    const doc = await this.docs.get(userId);
    const switched = doc.on[chatId];
    const loops = (await connections.loopbacks(userId)).map((c) => c.id);
    const pin = typeof chat.metadata[PIN] === "string" ? chat.metadata[PIN] : null;
    const pinnedLoop = pin !== null && loops.includes(pin);
    const needs = await this.needsRuntime(userId, chatId);
    if (needs !== null && on && place === "builtin" && !takeover) throw new UiRefused("unavailable", `${needs.by} plays this chat only in your runtime, so it can't run built in.`);
    const where: RunPlace = needs !== null ? "runtime" : (place ?? switched?.place ?? (doc.ran[chatId] ? "runtime" : "builtin"));
    if (!on) {
      const patch = { ...this.unpin(chat, switched, loops), ...(chat.metadata[this.markKey] !== undefined ? { [this.markKey]: null } : {}) };
      if (Object.keys(patch).length > 0) await this.host.chats.patchMetadata(chatId, patch, userId);
      if (switched !== undefined || (where === "runtime") !== (doc.ran[chatId] === true)) {
        await this.docs.change(userId, (d) => {
          delete d.on[chatId];
          // Where it ran is kept while it is off, so switching it on again runs it there.
          if (where === "runtime") d.ran[chatId] = true;
          else delete d.ran[chatId];
        });
      }
      return this.viewOf(userId, await chats.own(userId, chatId));
    }
    const blocked = this.deps.blocked(where);
    if (blocked !== null) throw new UiRefused("unavailable", blocked);
    const connection = await connections.ofChat(userId, chat);
    const other = this.other(chat, connection);
    if (other !== null && !takeover) throw new UiRefused("unavailable", `${other.name} answers this chat. Switch it off there first: two harnesses would both work on each of its replies. Or take the chat over here, which takes it from ${other.name}.`);
    const taken = other !== null ? await this.takeFrom(userId, chat, connection, loops) : {};
    // The pin the chat had before this backend's own: what a takeover put back, else what the chat bears.
    const pinBefore = PIN in taken ? (typeof taken[PIN] === "string" ? taken[PIN] : null) : pin;
    const modelBefore: JsonValue | null = PIN in taken ? (taken[PIN_MODEL] ?? null) : (chat.metadata[PIN_MODEL] ?? null);
    const prior = pinnedLoop ? (switched?.prior ?? null) : pinBefore;
    const priorModel = pinnedLoop ? (switched?.priorModel ?? null) : modelBefore;
    const since = switched?.since ?? this.deps.now();
    // In a runtime the mark says which connection the chat had before the pin: whoever takes the chat over can't read this backend's storage, and puts that connection back from here.
    const mark: JsonValue = { v: 1, chat: chatId, name: identity.name, place: where, since, ...(where === "runtime" && prior !== null ? { prior, priorModel } : {}) };
    if (where === "runtime") {
      const loop = loops[0];
      // Any other chat waits for a runtime that is there to choose, since built in serves it meanwhile.
      if (loop === undefined || (needs === null && !(await this.deps.runtimeReady(userId)))) {
        throw new UiRefused("unavailable", needs !== null ? `${needs.by} plays this chat only in your runtime, and none is set up yet. Start one with its line on ${identity.name}'s Runtime page and mint its key there, then switch the chat on.` : `There is no runtime to run this chat in yet. Start one and mint its key on ${identity.name}'s Runtime page, or let the chat run built in, which needs neither.`);
      }
      // Pinned to the loopback already (by hand, or by an earlier switch): the pin stands, with no earlier pin to put back that isn't already remembered.
      await this.host.chats.patchMetadata(chatId, { ...taken, ...(pinnedLoop ? {} : { [PIN]: loop, [PIN_MODEL]: null }), [this.markKey]: mark }, userId);
      if (switched?.place !== "runtime" || !pinnedLoop) {
        await this.docs.change(userId, (d) => {
          d.on[chatId] = { since, place: "runtime", prior, priorModel };
          delete d.ran[chatId];
        });
      }
    } else {
      // Built in, the chat generates on its own connection: a pin to the loopback would send its replies to the runtime instead.
      await this.host.chats.patchMetadata(chatId, { ...this.unpin(chat, switched, loops), ...taken, [this.markKey]: mark }, userId);
      if (switched?.place !== "builtin") {
        await this.docs.change(userId, (d) => {
          d.on[chatId] = { since, place: "builtin", prior: null, priorModel: null };
          delete d.ran[chatId];
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
        for (const chatId of gone) {
          delete doc.on[chatId];
          delete doc.ran[chatId];
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
