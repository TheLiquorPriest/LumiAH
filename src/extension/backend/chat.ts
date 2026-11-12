// A chat as the core's port reads and writes it (DESIGN §4.2 `chat`, §5). The reads (the path, a
// range of messages, the chat itself, the records) are shared with the runtime, which runs them over
// its copy of the chat (host/chat.ts); what is here writes: LumiAH's record on a message, the move of
// the records when a swipe is deleted, and a reply's empty message taken away. Only the extension
// may write its own entry on a message (Spindle's `ownMetadata`), so these never run anywhere else.

import type { JsonObject, JsonValue } from "../../core/ports";
import { type AnchorCodec, ChatReader, OWN_ANCHORS, type PathKeeping } from "../../host/chat";
import { isRecord } from "../../link/json";
import { KeyedQueue } from "./docs";
import type { BackendHost } from "./spindle";

export { type AnchorCodec, anchorsUnder, OWN_ANCHORS, type PathKeeping } from "../../host/chat";

export class Chats extends ChatReader {
  /** One read-modify-write of a message's records at a time. */
  private readonly writes = new KeyedQueue();

  /**
   * @param kept What a user's settings keep of chats' paths: how many chats, and how long each.
   * @param now The clock a kept path's age is read by.
   */
  constructor(
    private readonly host: Pick<BackendHost, "chats" | "granted">,
    kept: (userId: string) => Promise<PathKeeping>,
    now: () => number,
    codec: AnchorCodec = OWN_ANCHORS,
  ) {
    super(host, kept, now, codec);
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
