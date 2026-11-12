// A chat as the core's port reads it (DESIGN §4.2 `chat`, §5): its active path with each message's
// fingerprint and LumiAH's record for the swipe it shows, a range of its messages with their text, and
// the records themselves, which live under LumiAH's key in each reply's extension metadata, one per
// swipe. Lumiverse reads a chat's messages by the chat's id alone, so every read here first checks
// that the chat is the asking user's.
//
// Lumiverse has no read of a chat's messages without their text, so a path costs every message's
// text once. It is kept (without the texts) until Lumiverse says the chat changed, or for as long as
// the user's settings keep one at most, so the several path reads of one turn cost one; and when it
// is read again, a message whose text didn't change keeps its fingerprint instead of being hashed
// again. Lumiverse never gives a deleted message's number to another, so a chat's numbers have gaps,
// while it reads a chat by place: a range of numbers is found by the path kept.
//
// This is the read half, which the extension's backend runs over Spindle and the runtime over its copy
// of the chat (PI-BUILD-PLAN §4.5); the backend's `Chats` adds the writes (extension/backend/chat.ts).

import type { ChatInfo, ChatMessage, JsonObject, JsonValue, PathMessage, StoredAnchor } from "../core/ports";
import { textHash } from "../core/hash";
import { contentMark } from "../link/contract";
import { isRecord } from "../link/json";
import { LinkRefused } from "./refused";
import type { ChatReads, HostChat, HostMessage } from "./rows";

/** What LumiAH keeps on a message: its record for each swipe that has one, by the swipe's index. */
interface Anchors {
  v: 1;
  swipes: Record<string, JsonValue>;
}

/** A message's own metadata as its records; none for anything else (a message LumiAH never wrote on, or another build's shape). */
function anchorsOf(own: JsonValue | null): Anchors {
  const out: Anchors = { v: 1, swipes: {} };
  if (!isRecord(own) || own.v !== 1 || !isRecord(own.swipes)) return out;
  for (const [swipe, record] of Object.entries(own.swipes)) if (/^(0|[1-9][0-9]*)$/.test(swipe) && record !== undefined && record !== null) out.swipes[swipe] = record as JsonValue;
  return out;
}

/**
 * Where a turn's record sits in what the extension keeps on a message: its own entry in the
 * message's extension metadata. An extension that builds LumiAH into itself and keeps a record of
 * its own per message supplies this (DESIGN §5, §21), so a message holds one record and not two:
 * it says where in its own entry LumiAH's record for a swipe is read and written.
 */
export interface AnchorCodec {
  /** The record for a swipe; null when the entry holds none. */
  read(own: JsonValue | null, swipe: number): JsonValue | null;
  /** The entry with the record for a swipe put in, everything else of it kept. */
  write(own: JsonValue | null, swipe: number, record: JsonValue): JsonValue;
  /** The entry once a swipe is deleted: the later swipes' records moved down by one, the deleted one's gone. Null: the entry stays as it is. */
  swipeDeleted(own: JsonValue | null, swipe: number): JsonValue | null;
  /**
   * Where `read` finds a swipe's record when it is one of LumiAH's own forms, so the runtime's copy of
   * a chat reads records the same way: the entry itself (`under` null), or the entry's member `under`.
   * Absent: a form of the extension's own, which only its backend can read, so the runtime reads a
   * chat's path over the link.
   */
  readonly reads?: { under: string | null };
}

/** LumiAH's own: the entry is nothing but the records, `{ v: 1, swipes: { "<swipe>": record } }`. */
export const OWN_ANCHORS: AnchorCodec = {
  reads: { under: null },
  read: (own, swipe) => anchorsOf(own).swipes[String(swipe)] ?? null,
  write(own, swipe, record) {
    const anchors = anchorsOf(own);
    anchors.swipes[String(swipe)] = record;
    return anchors as unknown as JsonObject;
  },
  swipeDeleted(own, deleted) {
    const anchors = anchorsOf(own);
    const held = Object.keys(anchors.swipes).map(Number);
    if (!held.some((swipe) => swipe >= deleted)) return null;
    const moved: Anchors = { v: 1, swipes: {} };
    for (const swipe of held) {
      if (swipe === deleted) continue;
      const record = anchors.swipes[String(swipe)];
      if (record !== undefined) moved.swipes[String(swipe > deleted ? swipe - 1 : swipe)] = record;
    }
    return moved as unknown as JsonObject;
  },
};

/**
 * The records under `key` of an entry that is otherwise the extension's own to use:
 * `{ …, [key]: { v: 1, swipes } }`, everything else of the entry kept as it is. For an extension
 * that builds LumiAH into itself, keeps something of its own on a message, and supplies no codec
 * (`BackendIdentity.anchorKey`).
 */
export function anchorsUnder(key: string): AnchorCodec {
  const records = (own: JsonValue | null): JsonValue | null => (isRecord(own) ? ((own[key] as JsonValue | undefined) ?? null) : null);
  const entry = (own: JsonValue | null, held: JsonValue): JsonValue => ({ ...(isRecord(own) ? (own as JsonObject) : {}), [key]: held });
  return {
    reads: { under: key },
    read: (own, swipe) => OWN_ANCHORS.read(records(own), swipe),
    write: (own, swipe, record) => entry(own, OWN_ANCHORS.write(records(own), swipe, record)),
    swipeDeleted(own, deleted) {
      const moved = OWN_ANCHORS.swipeDeleted(records(own), deleted);
      return moved === null ? null : entry(own, moved);
    },
  };
}

/**
 * How many of a chat's latest messages are read first when one message is looked for by its id. The
 * reply a record is written on is almost always the chat's last message; a miss reads the whole chat,
 * so this number changes how fast a message is found and never whether, which is why it is no setting.
 */
const TAIL_FIRST = 4;

/** A path message as kept: with a cheap mark of its text (`contentMark`), which says whether the text changed without hashing it again. */
interface Kept extends PathMessage {
  mark: string;
}

interface KeptPath {
  rows: Kept[];
  /** False once Lumiverse said the chat changed: the rows only spare the unchanged messages their hashing. */
  fresh: boolean;
  /** Counts the changes Lumiverse told of, so a read under way when one came isn't kept as fresh. */
  changes: number;
  /** When the read it was made from began. */
  at: number;
}

/** What a user's settings keep of the chats' paths: of how many chats at most (0 keeps none), and for how long at most, in ms (0 answers no read from what is kept). */
export interface PathKeeping {
  chats: number;
  ms: number;
}

/** The place in `rows` (sorted by number) of the first whose number is `index` or more; their count where none is. */
function placeOf(rows: readonly PathMessage[], index: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((rows[mid] as PathMessage).index < index) low = mid + 1;
    else high = mid;
  }
  return low;
}

export class ChatReader {
  private readonly paths = new Map<string, KeptPath>();

  /**
   * @param kept What a user's settings keep of chats' paths: how many chats, and how long each.
   * @param now The clock a kept path's age is read by.
   */
  constructor(
    private readonly reads: { chats: ChatReads },
    private readonly kept: (userId: string) => Promise<PathKeeping>,
    private readonly now: () => number,
    protected readonly codec: AnchorCodec = OWN_ANCHORS,
  ) {}

  /** The chat, when it is the user's; refused (`not_found`) otherwise, in the same words whether it is another user's or no chat at all. A read that fails is the host's failure and stays one. */
  async own(userId: string, chatId: string): Promise<HostChat> {
    const chat = await this.reads.chats.get(chatId, userId);
    if (chat === null) throw new LinkRefused("not_found", "There is no such chat in this account.");
    return chat;
  }

  /** Lumiverse said a chat's messages changed: its kept path is read again before it is next used. */
  touched(chatId: string): void {
    const held = this.paths.get(chatId);
    if (held === undefined) return;
    held.fresh = false;
    held.changes++;
  }

  /** Something may have changed in any chat with nobody told (the runtime's link to the extension went down, or a word of Lumiverse's was lost on the way): every kept path is read again before it is next used. */
  touchedAll(): void {
    for (const chatId of this.paths.keys()) this.touched(chatId);
  }

  /** A chat is gone. */
  dropped(chatId: string): void {
    this.paths.delete(chatId);
  }

  /**
   * `chat.path`: the chat's active path, oldest first. From memory while Lumiverse has said nothing
   * of the chat since it was read, it was read no longer ago than the user's settings keep one, and
   * its last message is still the one kept (one small read, so a change Lumiverse told nobody of at
   * the chat's end, where nearly all of them are, is still seen).
   */
  async path(userId: string, chatId: string): Promise<PathMessage[]> {
    await this.own(userId, chatId);
    const keeping = await this.kept(userId);
    const held = this.paths.get(chatId);
    if (held?.fresh === true && this.now() - held.at < keeping.ms) {
      const last = await this.last(chatId);
      const keptLast = held.rows.at(-1);
      const same = last === null ? keptLast === undefined : keptLast !== undefined && keptLast.id === last.id && keptLast.index === last.index && keptLast.swipeId === last.swipeId && keptLast.mark === contentMark(last.role, last.content);
      if (same) return held.rows.map(({ mark: _mark, ...row }) => row);
    }
    // Its place is held while it is read, so a change Lumiverse tells of meanwhile is counted.
    const at = this.now();
    const mine: KeptPath = held ?? { rows: [], fresh: false, changes: 0, at };
    if (held === undefined) this.paths.set(chatId, mine);
    const changes = mine.changes;
    const rows = await this.reads.chats.messages(chatId);
    const before = new Map(mine.rows.map((row) => [row.id, row]));
    const read = await Promise.all(
      rows.map(async (m): Promise<Kept> => {
        const mark = contentMark(m.role, m.content);
        const old = before.get(m.id);
        // The mark is a 32-bit hash with the text's length: a text that changed and kept both would keep its old fingerprint, which no session's safety hangs on.
        const hash = old !== undefined && old.swipeId === m.swipeId && old.mark === mark ? old.hash : await textHash(m.content);
        return { id: m.id, index: m.index, role: m.role, name: m.name, swipeId: m.swipeId, chars: m.content.length, hash, anchor: this.codec.read(m.own, m.swipeId), mark };
      }),
    );
    // Fresh only when nothing was said of the chat while it was read, and the user keeps a list for some time. Kept for no time, it still says where each number stands for the reads of the chat's text that follow, which check it message by message.
    const unchanged = this.paths.get(chatId) === mine && mine.changes === changes;
    this.paths.delete(chatId);
    if (keeping.chats > 0) {
      this.paths.set(chatId, { rows: read, fresh: unchanged && keeping.ms > 0, changes: mine.changes, at });
      for (const oldest of this.paths.keys()) {
        if (this.paths.size <= keeping.chats) break;
        this.paths.delete(oldest);
      }
    }
    return read.map(({ mark: _mark, ...row }) => row);
  }

  /** `chat.messages`: the path's messages whose index is `from` or more and less than `to`, with their text. */
  async messages(userId: string, chatId: string, from: number, to: number): Promise<ChatMessage[]> {
    await this.own(userId, chatId);
    return (await this.range(chatId, from, to)).map((m) => ({ id: m.id, index: m.index, role: m.role, name: m.name, swipeId: m.swipeId, content: m.content }));
  }

  /**
   * The chat's messages whose number is `from` or more and less than `to`, as Lumiverse gives them
   * now. Lumiverse reads by place, and the path kept says where those numbers stand: its messages of
   * the range, and past its end as many places as numbers were asked for, where messages added since
   * stand. That one read is the range while each message read is where the path puts it; without a
   * path kept, while the chat is numbered by place. Otherwise the chat changed since, or has gaps no
   * path kept tells of, and the whole chat is read once.
   */
  async range(chatId: string, from: number, to: number): Promise<HostMessage[]> {
    if (to <= from) return [];
    const kept = this.paths.get(chatId)?.rows ?? [];
    const last = kept.at(-1)?.index ?? -1;
    const start = kept.length > 0 ? placeOf(kept, from) : from;
    const count = kept.length > 0 && last >= to ? placeOf(kept, to) - start : to - from;
    const rows = count > 0 ? await this.reads.chats.messages(chatId, { from: start, count }) : [];
    const placed = rows.every((m, i) => {
      const held = kept[start + i];
      if (kept.length === 0) return m.index === from + i;
      return held !== undefined ? held.id === m.id : m.index > last;
    });
    if (placed) return rows.filter((m) => m.index >= from && m.index < to);
    return (await this.reads.chats.messages(chatId)).filter((m) => m.index >= from && m.index < to);
  }

  /** One message of a chat by its id; null when it isn't there. */
  async find(chatId: string, messageId: string): Promise<HostMessage | null> {
    const tail = await this.reads.chats.messages(chatId, { tail: TAIL_FIRST });
    const near = tail.find((m) => m.id === messageId);
    if (near !== undefined) return near;
    if (tail.length < TAIL_FIRST) return null;
    return (await this.reads.chats.messages(chatId)).find((m) => m.id === messageId) ?? null;
  }

  /** The chat's last message; null for an empty chat. */
  async last(chatId: string): Promise<HostMessage | null> {
    return (await this.reads.chats.messages(chatId, { tail: 1 })).at(-1) ?? null;
  }

  /** `chat.info`: the chat itself (its name, the character it is with, the chat it was branched from); null when the user has no such chat. */
  async info(userId: string, chatId: string): Promise<ChatInfo | null> {
    const chat = await this.reads.chats.get(chatId, userId);
    if (chat === null) return null;
    const from = chat.metadata.branched_from;
    return {
      id: chat.id,
      name: chat.name,
      characterId: chat.characterId,
      characterName: chat.characterId === null ? null : await this.reads.chats.characterName(chat.characterId, userId),
      branchedFrom: typeof from === "string" && from !== "" ? from : null,
    };
  }

  /**
   * `chat.anchors`: every record LumiAH holds on a swipe of a message, in every chat of the user's.
   * A page is one chat's records, so no page grows with how many chats there are; `cursor` is the
   * place of the chat among the user's, as the page before named it (null: the first).
   */
  async anchors(userId: string, cursor: string | null): Promise<{ anchors: StoredAnchor[]; next: string | null }> {
    const at = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(at) || at < 0) throw new LinkRefused("bad_request", "That page of the chats' records isn't one LumiAH gave.");
    const { chats, total } = await this.reads.chats.list(userId, at, 1);
    const chat = chats[0];
    const anchors: StoredAnchor[] = [];
    if (chat !== undefined) {
      for (const message of await this.reads.chats.messages(chat.id)) {
        if (message.own === null) continue;
        for (let swipe = 0; swipe < message.swipes; swipe++) {
          const anchor = this.codec.read(message.own, swipe);
          if (anchor !== null) anchors.push({ chatId: chat.id, messageId: message.id, swipeId: swipe, anchor });
        }
      }
    }
    return { anchors, next: chat !== undefined && at + 1 < total ? String(at + 1) : null };
  }
}
