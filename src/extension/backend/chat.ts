// A chat as the core's port reads it (DESIGN §4.2 `chat`, §5): its active path with each message's
// fingerprint and LumiAH's record for the swipe it shows, a range of its messages with their text, and
// the records themselves, which live under LumiAH's key in each reply's extension metadata, one per
// swipe. Lumiverse reads a chat's messages by the chat's id alone, so every read here first checks
// that the chat is the asking user's.
//
// Lumiverse has no read of a chat's messages without their text, so a path costs every message's
// text once. It is kept (without the texts) until Lumiverse says the chat changed, so the several
// path reads of one turn cost one; and when it is read again, a message whose text didn't change
// keeps its fingerprint instead of being hashed again.

import type { ChatMessage, JsonObject, JsonValue, PathMessage } from "../../core/ports";
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

/** LumiAH's record for the swipe a message shows, as stored; null when it has none. */
export function shownAnchor(message: Pick<HostMessage, "own" | "swipeId">): JsonValue | null {
  return anchorsOf(message.own).swipes[String(message.swipeId)] ?? null;
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
}

export class Chats {
  /** One read-modify-write of a message's records at a time. */
  private readonly writes = new KeyedQueue();
  private readonly paths = new Map<string, KeptPath>();

  /**
   * @param kept How many chats' paths a user's settings keep in memory between reads; 0 keeps none.
   */
  constructor(
    private readonly host: Pick<BackendHost, "chats">,
    private readonly kept: (userId: string) => Promise<number>,
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
   * of the chat since it was read and its last message is still the one kept (one small read, so a
   * change Lumiverse told nobody of at the chat's end, where nearly all of them are, is still seen).
   */
  async path(userId: string, chatId: string): Promise<PathMessage[]> {
    await this.own(userId, chatId);
    const held = this.paths.get(chatId);
    if (held?.fresh === true) {
      const last = await this.last(chatId);
      const keptLast = held.rows.at(-1);
      const same = last === null ? keptLast === undefined : keptLast !== undefined && keptLast.id === last.id && keptLast.index === last.index && keptLast.swipeId === last.swipeId && keptLast.mark === contentMark(last.role, last.content);
      if (same) return held.rows.map(({ mark: _mark, ...row }) => row);
    }
    // Its place is held while it is read, so a change Lumiverse tells of meanwhile is counted.
    const mine: KeptPath = held ?? { rows: [], fresh: false, changes: 0 };
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
        return { id: m.id, index: m.index, role: m.role, name: m.name, swipeId: m.swipeId, chars: m.content.length, hash, anchor: shownAnchor(m), mark };
      }),
    );
    const most = await this.kept(userId);
    // Fresh only when nothing was said of the chat while it was read.
    const unchanged = this.paths.get(chatId) === mine && mine.changes === changes;
    this.paths.delete(chatId);
    if (most > 0) {
      this.paths.set(chatId, { rows: read, fresh: unchanged, changes: mine.changes });
      for (const oldest of this.paths.keys()) {
        if (this.paths.size <= most) break;
        this.paths.delete(oldest);
      }
    }
    return read.map(({ mark: _mark, ...row }) => row);
  }

  /** `chat.messages`: the path's messages whose index is `from` or more and less than `to`, with their text. */
  async messages(userId: string, chatId: string, from: number, to: number): Promise<ChatMessage[]> {
    await this.own(userId, chatId);
    if (to <= from) return [];
    let rows = await this.host.chats.messages(chatId, { from, count: to - from });
    // A message's index is its place in the chat; where a chat's indexes have a hole, the range read by place isn't the range asked for, and the whole chat is read instead.
    if (rows.some((m, i) => m.index !== from + i)) rows = await this.host.chats.messages(chatId);
    return rows.filter((m) => m.index >= from && m.index < to).map((m) => ({ id: m.id, index: m.index, role: m.role, name: m.name, swipeId: m.swipeId, content: m.content }));
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
   * message or the swipe is gone. `swipe` null: the swipe the message shows.
   */
  async anchor(userId: string, chatId: string, messageId: string, swipe: number | null, record: JsonValue): Promise<boolean> {
    await this.own(userId, chatId);
    return this.writes.run(`${chatId}\u0000${messageId}`, async () => {
      const message = await this.find(chatId, messageId);
      if (message === null) return false;
      const at = swipe ?? message.swipeId;
      if (!Number.isSafeInteger(at) || at < 0 || at >= message.swipes) return false;
      const anchors = anchorsOf(message.own);
      anchors.swipes[String(at)] = record;
      await this.host.chats.setOwn(chatId, messageId, anchors as unknown as JsonObject);
      this.touched(chatId);
      return true;
    });
  }

  /** A swipe of a message was deleted: the records of the later swipes move down with them, and the deleted one's is gone. */
  async swipeDeleted(chatId: string, messageId: string, deleted: number): Promise<void> {
    await this.writes.run(`${chatId}\u0000${messageId}`, async () => {
      const message = await this.find(chatId, messageId);
      if (message === null) return;
      const anchors = anchorsOf(message.own);
      const held = Object.keys(anchors.swipes).map(Number);
      if (!held.some((swipe) => swipe >= deleted)) return;
      const moved: Anchors = { v: 1, swipes: {} };
      for (const swipe of held) {
        if (swipe === deleted) continue;
        const record = anchors.swipes[String(swipe)];
        if (record !== undefined) moved.swipes[String(swipe > deleted ? swipe - 1 : swipe)] = record;
      }
      await this.host.chats.setOwn(chatId, messageId, moved as unknown as JsonObject);
      this.touched(chatId);
    });
  }
}
