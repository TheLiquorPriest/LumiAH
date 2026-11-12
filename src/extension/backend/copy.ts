// What the extension does for the runtime's copy of chat and lore (PI-BUILD-PLAN §4.5, §4.6). It
// forwards Lumiverse's events about a user's chats and world books to that user's own runtimes and no
// one else's, in the order it heard them, numbered for each runtime with everything else the copy is
// told, so a runtime that finds a number missing reads again what it holds. It tells each runtime on
// hello, and again when it changes, what the copy may read: the permissions the extension's own reads
// rest on, whether the extension LumiAH is built into keeps LumiAH's records elsewhere or gives it no
// lore, and Lumiverse's database file, which only the instance's operator may have read directly and
// only by their own runtimes. And it answers what the copy asks of it: a read of the extension's own
// host where the copy can't vouch for its own, a mounting extension's records, and what only the
// extension heard of a chat's latest generation, with the lists of world books the chat's lore is read
// with, so that none of them crosses on its own.

import type { JsonValue } from "../../core/ports";
import { COPY_EVENTS, COPY_PERMISSIONS, type CopyOffer, LINK, type LinkPush, type LinkRequests, type TurnBooks } from "../../link/contract";
import { isRecord } from "../../link/json";
import type { DatabaseSwitchView } from "../../shared/ui";
import type { Chats } from "./chat";
import { UserDocs } from "./docs";
import { LinkRefused, UiRefused, wordsOf } from "./errors";
import type { RegistryStore } from "./registry";
import type { Relays } from "./relays";
import type { BackendHost } from "./spindle";
import type { Turns } from "./turns";

/**
 * Where an extension that builds LumiAH into itself keeps LumiAH's record of a message when not on the
 * message itself (LumiRPEngine keeps it in its own ledger, and its host's `chats.messages` puts it in
 * as each message's `own`): what the runtime's copy needs to give the same rows as that host.
 */
export interface OwnElsewhere {
  /** A chat's entries as its host puts them in, by message id; a message without one isn't named. */
  read(chatId: string, userId: string): Promise<Record<string, JsonValue>>;
  /** Hears of each chat whose entries changed, and whose chat it is where that is known. */
  onChanged(listener: (chatId: string, userId: string | null) => void): void;
}

/** The operator's switch for the direct database reader, kept in the operator's own storage. */
interface Switch {
  v: 1;
  on: boolean;
}

export interface CopyFeedDeps {
  relays: Pick<Relays, "push">;
  registry: Pick<RegistryStore, "read">;
  chats: Pick<Chats, "own" | "touched">;
  turns: Pick<Turns, "ofChat">;
  /** Set where the extension LumiAH is built into keeps LumiAH's records elsewhere (`BackendOptions.ownElsewhere`). */
  ownElsewhere?: OwnElsewhere;
  /** The extension LumiAH is built into gives it no lore (`BackendOptions.declinesLore`). */
  declinesLore: boolean;
  /** Where LumiAH's record for a swipe is in the extension's entry on a message, where it is one of LumiAH's own forms; null where only this backend reads it. */
  records: { under: string | null } | null;
  /** The extension as its pages name it. */
  name: string;
}

/** What one `host.read` answers: the extension's host's own answer, as it crosses. */
type Read = LinkRequests["host.read"]["result"];

const SEP = "\u0000";
const key = (userId: string, relay: string): string => `${userId}${SEP}${relay}`;

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new LinkRefused("bad_request", `The read names no ${what}: update the runtime and LumiAH to the same build.`);
  return value;
}

function whole(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new LinkRefused("bad_request", `The read's ${what} isn't a whole number: update the runtime and LumiAH to the same build.`);
  return value;
}

/** A range of a chat's messages as the host takes one: all of them (null), `count` from the `from`th, or the last `tail`. */
function rangeOf(value: unknown): { from: number; count: number } | { tail: number } | undefined {
  if (value === null || value === undefined) return undefined;
  if (isRecord(value) && value.tail !== undefined) return { tail: whole(value.tail, "tail") };
  if (isRecord(value)) return { from: whole(value.from, "start"), count: whole(value.count, "count") };
  throw new LinkRefused("bad_request", "The read's range of messages is malformed: update the runtime and LumiAH to the same build.");
}

export class CopyFeed {
  /** How many numbered pushes each runtime has been sent, by user and runtime: every runtime that said hello since the extension started is here. */
  private readonly told = new Map<string, number>();
  /** The database file each runtime was last told of, by user and runtime: one told of a file is asked about again at its pings. */
  private readonly given = new Map<string, string | null>();
  /** Each user's pushes, one after another in the order they were heard. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly switches: UserDocs<Switch>;

  constructor(
    private readonly host: Pick<BackendHost, "events" | "granted" | "onPermission" | "chats" | "lore" | "role" | "database" | "identifier" | "storage" | "log">,
    private readonly deps: CopyFeedDeps,
  ) {
    this.switches = new UserDocs<Switch>(host, "database.json", (raw) => (isRecord(raw) && raw.v === 1 && typeof raw.on === "boolean" ? { v: 1, on: raw.on } : null), () => ({ v: 1, on: false }));
  }

  /** Starts hearing what a runtime's copy is told of. */
  start(): void {
    // Only an event Lumiverse says is a user's goes anywhere, and only to that user's runtimes: one it says is nobody's (it always says) is told to no one.
    this.host.events.onLumiverse(COPY_EVENTS, (name, payload, userId) => {
      if (userId === null) return;
      this.queue(userId, async () => this.toEach(userId, (seq) => ({ link: LINK, type: "event", seq, name, payload: (payload ?? null) as JsonValue, userId })));
    });
    this.host.onPermission((permission) => {
      if (!(COPY_PERMISSIONS as readonly string[]).includes(permission)) return;
      for (const userId of new Set([...this.told.keys()].map((k) => k.slice(0, k.indexOf(SEP))))) this.queue(userId, () => this.retell(userId));
    });
    this.deps.ownElsewhere?.onChanged((chatId, userId) => {
      // The backend's own reader of the chat's message list, which carries those records, reads it again too.
      this.deps.chats.touched(chatId);
      if (userId !== null) {
        this.queue(userId, async () => this.toEach(userId, (seq) => ({ link: LINK, type: "own", seq, chat: chatId })));
        return;
      }
      // Whose chat it is wasn't said: each user with a runtime here is asked, and only the chat's own is told.
      for (const user of new Set([...this.told.keys()].map((k) => k.slice(0, k.indexOf(SEP))))) {
        void this.host.chats
          .get(chatId, user)
          .then((chat) => {
            if (chat !== null) this.queue(user, async () => this.toEach(user, (seq) => ({ link: LINK, type: "own", seq, chat: chatId })));
          })
          .catch((error: unknown) => this.host.log("warn", `[LumiAH] whose chat ${chatId} is couldn't be told, so its runtimes read its records again: ${wordsOf(error)}`));
      }
    });
  }

  /** What a runtime's copy is told on hello: the copy is then read again whole, so the count of what it was sent starts from here. */
  async offer(userId: string, relay: string): Promise<CopyOffer> {
    const k = key(userId, relay);
    const fields = await this.fields(userId);
    this.given.set(k, fields.database);
    if (!this.told.has(k)) this.told.set(k, 0);
    return { ...fields, told: this.told.get(k) ?? 0 };
  }

  /** How many numbered pushes a runtime has been sent: its ping's answer, so a runtime whose last push was lost finds out. */
  toldTo(userId: string, relay: string): number {
    return this.told.get(key(userId, relay)) ?? 0;
  }

  /**
   * A runtime pinged: one that was told of the database file is told again where that no longer
   * holds (the operator switched the reader off from another page, or is the operator no more).
   */
  async pinged(userId: string, relay: string): Promise<void> {
    const k = key(userId, relay);
    if ((this.given.get(k) ?? null) === null) return;
    // Whatever can't be asked now counts as no longer holding: the runtime is told the file is no longer its to read.
    if ((await this.databaseFor(userId).catch(() => null)) === this.given.get(k)) return;
    this.queue(userId, () => this.retell(userId));
  }

  /** `host.read`: one read of the extension's own host for the runtime's own user. A read by a chat's id alone is answered only for a chat of that user's. */
  async read(userId: string, port: unknown, method: unknown, args: unknown): Promise<Read> {
    if (!Array.isArray(args)) throw new LinkRefused("bad_request", "The read's arguments are malformed: update the runtime and LumiAH to the same build.");
    const { chats, lore } = this.host;
    const value = async (): Promise<unknown> => {
      switch (`${String(port)}.${String(method)}`) {
        case "chats.get":
          return chats.get(text(args[0], "chat"), userId);
        case "chats.messages": {
          const chatId = text(args[0], "chat");
          await this.deps.chats.own(userId, chatId);
          return chats.messages(chatId, rangeOf(args[1]));
        }
        case "chats.swipe": {
          const chatId = text(args[0], "chat");
          await this.deps.chats.own(userId, chatId);
          return chats.swipe(chatId, text(args[1], "message"), whole(args[2], "swipe"));
        }
        case "chats.list":
          return chats.list(userId, whole(args[0], "offset"), whole(args[1], "limit"));
        case "chats.characterName":
          return chats.characterName(text(args[0], "character"), userId);
        case "chats.sovereignHand":
          return chats.sovereignHand(text(args[0], "chat"), userId);
        case "lore.book":
          return lore.book(text(args[0], "world book"), userId);
        case "lore.entries":
          return lore.entries(text(args[0], "world book"), userId);
        case "lore.entry":
          return lore.entry(text(args[0], "entry"), userId);
        case "lore.record":
          return lore.record(text(args[0], "world book"), userId);
        case "lore.records":
          return lore.records(text(args[0], "world book"), userId);
        case "lore.global":
          return lore.global(userId);
        case "lore.ofCharacter":
          return lore.ofCharacter(text(args[0], "character"), userId);
        case "lore.ofPersona":
          return lore.ofPersona(args[0] === null ? null : text(args[0], "persona"), userId);
        default:
          throw new LinkRefused("bad_request", `There is no read ${String(port)}.${String(method)} of the extension's host: update the runtime and LumiAH to the same build.`);
      }
    };
    return { value: ((await value()) ?? null) as JsonValue };
  }

  /** `own.read`: the records the extension LumiAH is built into keeps of a chat's messages elsewhere, for a chat of the user's. */
  async own(userId: string, chatId: unknown): Promise<LinkRequests["own.read"]["result"]> {
    const own = this.deps.ownElsewhere;
    if (own === undefined) throw new LinkRefused("bad_request", `${this.deps.name} keeps LumiAH's records on the messages themselves: the runtime reads them there.`);
    const id = text(chatId, "chat");
    await this.deps.chats.own(userId, id);
    return { entries: await own.read(id, userId) };
  }

  /**
   * `turn.lore`: the persona and the activated entries of the chat's latest generation LumiAH heard,
   * as `Lore` reads them, with the lists of world books the chat's lore is read with, each read as
   * `Lore` and `RecallReads` read it (one that fails is none), so that the copy asks none of them
   * apart: every chat's, the active persona's, the generation's persona's, and `character`'s.
   */
  async turnLore(userId: string, chatId: unknown, character: unknown): Promise<LinkRequests["turn.lore"]["result"]> {
    const turn = this.deps.turns.ofChat(userId, text(chatId, "chat"));
    const characterId = character === undefined || character === null ? null : text(character, "character");
    const { lore } = this.host;
    const [global, active, persona, ofCharacter] = await Promise.all([
      lore.global(userId).catch((): string[] => []),
      lore.ofPersona(null, userId).catch(() => null),
      typeof turn?.personaId === "string" ? lore.ofPersona(turn.personaId, userId).catch(() => null) : undefined,
      characterId !== null ? lore.ofCharacter(characterId, userId).catch((): string[] => []) : [],
    ]);
    const books: TurnBooks = { global, active, character: ofCharacter, ...(persona !== undefined ? { persona } : {}) };
    return turn === undefined ? { activated: [], books } : { persona: turn.personaId, activated: turn.activated, books };
  }

  /** The direct reader as the user's Runtime page shows it. */
  async databaseView(userId: string): Promise<DatabaseSwitchView> {
    if (!(await this.operator(userId))) return { operator: false, on: false, path: null };
    return { operator: true, on: (await this.switches.get(userId)).on, path: this.host.database() };
  }

  /** The operator switches the direct reader on or off for their own runtimes; refused to anyone else, whatever the page sent. */
  async setDatabase(userId: string, on: unknown): Promise<DatabaseSwitchView> {
    if (typeof on !== "boolean") throw new UiRefused("bad_request", "Say whether the database reader is to be on (true) or off (false).");
    if (!(await this.operator(userId))) throw new UiRefused("forbidden", "Only this Lumiverse's operator can switch the database reader on or off.");
    if (on && this.host.database() === null) throw new UiRefused("unavailable", `${this.deps.name} can't tell where Lumiverse's database is from where it is installed, so the reader can't be switched on.`);
    await this.switches.change(userId, (doc) => {
      doc.on = on;
    });
    this.queue(userId, () => this.retell(userId));
    return this.databaseView(userId);
  }

  /** Resolves once every push and switch under way is done (tests). */
  async settle(): Promise<void> {
    await Promise.all([...this.queues.values()]);
    await this.switches.settle();
  }

  /** Whether the user is this Lumiverse's operator, asked now; anyone Lumiverse won't say of is taken as no operator. */
  private async operator(userId: string): Promise<boolean> {
    return (await this.host.role(userId).catch(() => "user")) === "operator";
  }

  /** The database file the user's runtimes may read: only the operator's, while their switch is on and the file can be told; null otherwise. Asked at every use. */
  private async databaseFor(userId: string): Promise<string | null> {
    const path = this.host.database();
    if (path === null || !(await this.operator(userId))) return null;
    return (await this.switches.get(userId)).on ? path : null;
  }

  /** What a runtime's copy may read, as it stands now. */
  private async fields(userId: string): Promise<Omit<CopyOffer, "told">> {
    return {
      identifier: this.host.identifier,
      granted: COPY_PERMISSIONS.filter((permission) => this.host.granted(permission)),
      ownElsewhere: this.deps.ownElsewhere !== undefined,
      declinesLore: this.deps.declinesLore,
      records: this.deps.records,
      database: await this.databaseFor(userId).catch(() => null),
    };
  }

  /** Tells each of the user's runtimes what the copy may read now. */
  private async retell(userId: string): Promise<void> {
    const offer = await this.fields(userId);
    for (const k of this.told.keys()) if (k.startsWith(`${userId}${SEP}`)) this.given.set(k, offer.database);
    await this.toEach(userId, (seq) => ({ link: LINK, type: "copy", seq, offer }));
  }

  /** Runs one piece of the user's telling after the ones before it, so each runtime hears them in the order they came. */
  private queue(userId: string, work: () => Promise<void>): void {
    const next = (this.queues.get(userId) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      // What couldn't be sent counts as sent and lost: each runtime of the user's then finds a number missing at its next ping, and reads again what its copy holds.
      for (const k of this.told.keys()) if (k.startsWith(`${userId}${SEP}`)) this.told.set(k, (this.told.get(k) ?? 0) + 1);
      this.host.log("warn", `[LumiAH] the runtime's copy of chat and lore couldn't be told of a change, so it reads again what it holds: ${wordsOf(error)}`);
    });
    this.queues.set(userId, next);
    void next.then(() => {
      if (this.queues.get(userId) === next) this.queues.delete(userId);
    });
  }

  /** Pushes to each of the user's runtimes that has a session now, each numbered after what it was sent before. One without a session hears of it on its hello, when its copy is read again whole. */
  private async toEach(userId: string, make: (seq: number) => LinkPush): Promise<void> {
    const { relays } = await this.deps.registry.read(userId);
    for (const relay of Object.keys(relays)) {
      const k = key(userId, relay);
      const seq = (this.told.get(k) ?? 0) + 1;
      if (this.deps.relays.push(userId, relay, make(seq))) this.told.set(k, seq);
    }
  }
}
