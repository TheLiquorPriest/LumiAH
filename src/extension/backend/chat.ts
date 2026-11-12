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

import type { ChatInfo, ChatMessage, JsonObject, JsonValue, PathMessage, StoredAnchor } from "../../core/ports";
import { textHash } from "../../core/hash";
import { contentMark } from "../../link/contract";
import { isRecord } from "../../link/json";
import { KeyedQueue } from "./docs";
import { LinkRefused } from "./errors";
import type { BackendHost, HostChat, HostMessage } from "./spindle";

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
}

/** LumiAH's own: the entry is nothing but the records, `{ v: 1, swipes: { "<swipe>": record } }`. */
export const OWN_ANCHORS: AnchorCodec = {
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

export class Chats {
  /** One read-modify-write of a message's records at a time. */
  private readonly writes = new KeyedQueue();
  private readonly paths = new Map<string, KeptPath>();

  /**
   * @param kept What a user's settings keep of chats' paths: how many chats, and how long each.
   * @param now The clock a kept path's age is read by.
   */
  constructor(
    private readonly host: Pick<BackendHost, "chats" | "granted">,
    private readonly kept: (userId: string) => Promise<PathKeeping>,
    private readonly now: () => number,
    private readonly codec: AnchorCodec = OWN_ANCHORS,
  ) {}

  /** The chat, when it is the user's; refused (`not_found`) otherwise, in the same words whether it is another user's or no chat at all. A read that fails is the host's failure and stays one. */
  async own(userId: string, chatId: string): Promise<HostChat> {
    const chat = await this.host.chats.get(chatId, userId);
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
    const rows = await this.host.chats.messages(chatId);
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
    const rows = count > 0 ? await this.host.chats.messages(chatId, { from: start, count }) : [];
    const placed = rows.every((m, i) => {
      const held = kept[start + i];
      if (kept.length === 0) return m.index === from + i;
      return held !== undefined ? held.id === m.id : m.index > last;
    });
    if (placed) return rows.filter((m) => m.index >= from && m.index < to);
    return (await this.host.chats.messages(chatId)).filter((m) => m.index >= from && m.index < to);
  }

  /** One message of a chat by its id; null when it isn't there. */
  async find(chatId: string, messageId: string): Promise<HostMessage | null> {
    const tail = await this.host.chats.messages(chatId, { tail: TAIL_FIRST });
    const near = tail.find((m) => m.id === messageId);
    if (near !== undefined) return near;
    if (tail.length < TAIL_FIRST) return null;
    return (await this.host.chats.messages(chatId)).find((m) => m.id === messageId) ?? null;
  }

  /** The chat's last message; null for an empty chat. */
  async last(chatId: string): Promise<HostMessage | null> {
    return (await this.host.chats.messages(chatId, { tail: 1 })).at(-1) ?? null;
  }

  /**
   * Writes LumiAH's record for one swipe of a message, in place of the one it holds; false when the
   * message or the swipe is gone. `swipe` null: the swipe the message shows. A function is asked as
   * the write takes its place among the message's writes: the answer then counts every swipe
   * deletion heard so far, whose move of the stored records runs before this write, and none heard
   * later, whose move runs after it and carries this record along. Without the permission to change
   * a chat's messages nothing is written and nothing fails: false, as for a message that is gone.
   */
  async anchor(userId: string, chatId: string, messageId: string, swipe: number | null | (() => number), record: JsonValue): Promise<boolean> {
    await this.own(userId, chatId);
    if (!this.host.granted("chat_mutation")) return false;
    const aimed = typeof swipe === "function" ? swipe() : swipe;
    return this.writes.run(`${chatId}\u0000${messageId}`, async () => {
      const message = await this.find(chatId, messageId);
      if (message === null) return false;
      const at = aimed ?? message.swipeId;
      if (!Number.isSafeInteger(at) || at < 0 || at >= message.swipes) return false;
      // What this backend keeps on a record beside the core's own fields (`ran`: where its turn ran) stays when the core rewrites the record of the same turn, as a rollback or a job's end does: the core hands back only the fields it reads.
      const held = this.codec.read(message.own, at);
      const kept: JsonValue = isRecord(record) && record.ran === undefined && isRecord(held) && held.ran !== undefined && held.generationId === record.generationId ? { ...(record as JsonObject), ran: held.ran as JsonValue } : record;
      await this.host.chats.setOwn(chatId, messageId, this.codec.write(message.own, at, kept));
      this.touched(chatId);
      return true;
    });
  }

  /** Whether a swipe of a message bears the record of a generation already. */
  async recorded(chatId: string, messageId: string, swipe: number, generationId: string): Promise<boolean> {
    const message = await this.find(chatId, messageId);
    const held = message === null ? null : this.codec.read(message.own, swipe);
    return isRecord(held) && held.generationId === generationId;
  }

  /** A swipe of a message was deleted: the records of the later swipes move down with them, and the deleted one's is gone. Without the permission to change a chat's messages there is nothing to move, and nothing is tried. */
  async swipeDeleted(chatId: string, messageId: string, deleted: number): Promise<void> {
    if (!this.host.granted("chat_mutation")) return;
    await this.writes.run(`${chatId}\u0000${messageId}`, async () => {
      const message = await this.find(chatId, messageId);
      if (message === null) return;
      const moved = this.codec.swipeDeleted(message.own, deleted);
      if (moved === null) return;
      await this.host.chats.setOwn(chatId, messageId, moved);
      this.touched(chatId);
    });
  }

  /** `chat.info`: the chat itself (its name, the character it is with, the chat it was branched from); null when the user has no such chat. */
  async info(userId: string, chatId: string): Promise<ChatInfo | null> {
    const chat = await this.host.chats.get(chatId, userId);
    if (chat === null) return null;
    const from = chat.metadata.branched_from;
    return {
      id: chat.id,
      name: chat.name,
      characterId: chat.characterId,
      characterName: chat.characterId === null ? null : await this.host.chats.characterName(chat.characterId, userId),
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
    const { chats, total } = await this.host.chats.list(userId, at, 1);
    const chat = chats[0];
    const anchors: StoredAnchor[] = [];
    if (chat !== undefined) {
      for (const message of await this.host.chats.messages(chat.id)) {
        if (message.own === null) continue;
        for (let swipe = 0; swipe < message.swipes; swipe++) {
          const anchor = this.codec.read(message.own, swipe);
          if (anchor !== null) anchors.push({ chatId: chat.id, messageId: message.id, swipeId: swipe, anchor });
        }
      }
    }
    return { anchors, next: chat !== undefined && at + 1 < total ? String(at + 1) : null };
  }

  /**
   * Deletes a reply's message that holds nothing: an assistant's, with one swipe and no text. True
   * when it was deleted; a message with text, or one the user swiped, is never touched, and nothing
   * is without the permission to change a chat's messages.
   */
  async deleteEmpty(userId: string, chatId: string, messageId: string): Promise<boolean> {
    await this.own(userId, chatId);
    if (!this.host.granted("chat_mutation")) return false;
    return this.writes.run(`${chatId}\u0000${messageId}`, async () => {
      const message = await this.find(chatId, messageId);
      if (message === null || message.role !== "assistant" || message.swipes !== 1 || message.content !== "") return false;
      await this.host.chats.deleteMessage(chatId, messageId);
      this.touched(chatId);
      return true;
    });
  }
}
