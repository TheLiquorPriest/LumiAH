// The Sessions page's reads (DESIGN §5, §8 Sessions): a chat's turns from the records on its
// replies, each turn's stored transcript and each call's exact prompt, the session as it stands at
// the end of the chat's active path with what the next turn will do about a summary, and the
// rollback of a compaction. And what the first screen says of a chat's latest turn (§8 Home), which
// is read from the same records. Everything here is read with the core's own functions, so the page
// shows what the main agent would resume from, worked out the same way.
//
// The core's documents and blobs are written by the user's runtime, on its own disk first, and reach
// this extension's storage behind (the runtime's working store). So before a read the runtime is
// asked to finish sending what it saved (`store.settle`), for a short while (Settings → Transport →
// Pages): a session, whose documents change, is read once it has; a stored text, named by its hash
// and so the same wherever it is found, is asked about only when the storage doesn't have it. With
// no runtime linked the storage is read as it is; with one that doesn't say in time, the page is
// told it sees the storage's last state.

import { Blobs } from "../../core/blobs";
import type { ChatPort, ModelRequest, PathMessage, TurnRecord } from "../../core/ports";
import { readCallPrompt } from "../../core/prompts";
import { carriedOf } from "../../core/receipts";
import { compactionAsked, compactionDue, type PathTurn, pathTurns, recordOf, rollback, sessionAt, Sessions } from "../../core/sessions";
import { settingsOf } from "../../core/settings";
import { textsOf } from "../../core/texts";
import { type TurnTranscript, transcriptOf } from "../../core/transcript";
import { limitOf } from "../../core/util";
import { BLOB_HASH } from "../../link/contract";
import type { LastTurn, LiveView, RollbackState, SessionView, TurnRow, TurnsPage } from "../../shared/ui";
import { isReply } from "../../shared/ui";
import type { Chats } from "./chat";
import { UiRefused, wordsOf } from "./errors";
import type { Storage } from "./reads";
import type { SettingsStore } from "./settings";
import { lastOfLive, lastOfRecord } from "./views";

export interface SessionsDeps {
  chats: Chats;
  storage: Storage;
  settings: SettingsStore;
  now(): number;
  /** The extension as its pages name it. */
  name: string;
  /**
   * Asks the user's runtime to finish sending what it saved to this extension's storage
   * (`store.settle`), for a read about `chatId` (null: about none): true once it has; false when no
   * runtime of the user's is linked, so the storage is all there is. Rejects in the runtime's or the
   * link's words.
   */
  settle(userId: string, chatId: string | null): Promise<boolean>;
  /** Runs `fn` once after `ms`; what it returns cancels that. */
  later(ms: number, fn: () => void): () => void;
}

function hashOf(raw: string, what: string): string {
  if (!BLOB_HASH.test(raw)) throw new UiRefused("bad_request", `${what} is named by its hash.`);
  return raw;
}

/** Whether the compaction a turn made can be rolled back, as the page says it (`RollbackState`). */
function rollbackState(turn: PathTurn, turns: readonly PathTurn[], standing: string | null): RollbackState {
  const { record } = turn;
  if (record.summary === undefined) return "none";
  // Asked for, and no turn has ended since to read past it: the chat's next turn does.
  if (record.rolledBack !== undefined) return turns.some((t) => t.onPath && t.record.at > (record.rolledBack ?? 0)) ? "done" : "pending";
  return turn.onPath && record.summary === standing ? "available" : "none";
}

/**
 * The latest record on a path, or the latest of one turn (`turn`: its generation's id): the message
 * that holds it, and the record as the core reads it. Null when the path holds none. No path hash
 * is worked out for it: whether the record still stands on the path is not what is asked.
 */
function latestRecord(path: readonly PathMessage[], turn: string | null): { message: PathMessage; record: TurnRecord } | null {
  for (let at = path.length - 1; at >= 0; at--) {
    const message = path[at];
    const record = message === undefined ? null : recordOf(message.anchor);
    if (message !== undefined && record !== null && (turn === null || record.generationId === turn)) return { message, record };
  }
  return null;
}

export class SessionsPage {
  constructor(private readonly deps: SessionsDeps) {}

  private chatPort(userId: string): ChatPort {
    const { chats } = this.deps;
    return {
      path: (chatId) => chats.path(userId, chatId),
      messages: (chatId, from, to) => chats.messages(userId, chatId, from, to),
      anchor: (chatId, messageId, swipeId, record) => chats.anchor(userId, chatId, messageId, swipeId, record),
    };
  }

  /**
   * Asks the user's runtime to finish sending what it saved to the storage, and waits for its answer
   * as long as Settings say (`pages.settleMs`). Null when the storage is as current as it can be
   * made (the runtime said so, or none is linked to ask); else why it may not be, in a sentence.
   */
  private async caughtUp(userId: string, chatId: string | null): Promise<string | null> {
    const waitMs = (await this.deps.settings.transport(userId)).pages.settleMs;
    const { promise, resolve } = Promise.withResolvers<string | null>();
    const cancel = this.deps.later(waitMs, () => resolve(`Your runtime didn't say within ${Math.round(waitMs / 100) / 10} s that it had sent ${this.deps.name} everything it saved.`));
    this.deps
      .settle(userId, chatId)
      .then(
        () => resolve(null),
        (error: unknown) => resolve(wordsOf(error)),
      )
      .finally(cancel);
    return promise;
  }

  /** A stored text by its hash: from the storage, and asked about again once the runtime has sent what it saved when the storage didn't have it. Null when it still doesn't, with why the storage may be behind. */
  private async text(userId: string, hash: string): Promise<{ text: string | null; behind: string | null }> {
    const text = await this.deps.storage.blob(userId, hash);
    if (text !== null) return { text, behind: null };
    const behind = await this.caughtUp(userId, null);
    return { text: await this.deps.storage.blob(userId, hash), behind };
  }

  /**
   * The session as the main agent would resume it for a reply after every message of the path: read
   * with the core's own resume and measured as it measures what it carries, once the runtime has
   * sent what it saved. Whether the user's ask for a summary still stands, and whether a rollback
   * holds the notes, are the core's own verdict (`compactionDue`) on what the chat's next turn would
   * read.
   */
  private async session(userId: string, chatId: string, path: PathMessage[]): Promise<SessionView> {
    const { storage, settings } = this.deps;
    const why = await this.caughtUp(userId, chatId);
    const behind = why === null ? null : `${why} This shows what ${this.deps.name}'s storage holds, which may lack the newest. Look again in a moment.`;
    const snapshot = await settings.snapshot(userId);
    const core = settingsOf(snapshot.values.core);
    // A store for this one read: nothing is kept in memory past it, and nothing is written.
    const blobs = new Blobs({ blobs: { get: (hash) => storage.blob(userId, hash), put: async () => undefined }, log: () => undefined }, () => 0);
    const resumed = await new Sessions({ chat: { ...this.chatPort(userId), path: async () => path } }, blobs).resume({ chatId: "", target: { messageId: null, swipeId: 0 }, kind: "new" });
    const sizes = { receiptChars: core.session.receiptChars, receiptArgChars: core.session.receiptArgChars, charsPerToken: core.loop.charsPerToken, texts: textsOf(snapshot.texts) };
    const { tokens } = carriedOf({ summary: resumed.summary, turns: resumed.turns }, sizes);
    const { rolledBackAt } = resumed.refs;
    // When the user asked is in a document the core keeps (its runtime writes it): read here, never written.
    const asked = await compactionAsked({ store: { read: (doc) => storage.doc(userId, doc), write: async () => undefined, remove: async () => undefined } }, chatId);
    const standing = {
      asked,
      records: resumed.records,
      rolledBackAt,
      // What the notes came to when the summary was rolled back: the turns there were then, as the core's turn counts them.
      tokensAtRollback: rolledBackAt === null ? 0 : carriedOf({ summary: resumed.summary, turns: resumed.turns.filter((t) => t.segment.at <= rolledBackAt) }, sizes).tokens,
      margin: core.session.rollbackMarginTokens,
    };
    return {
      turns: resumed.turns.length,
      tokens,
      summary: resumed.summary !== null,
      dropped: resumed.refs.dropped.length,
      missing: resumed.missing,
      // An ask stands until a summary is made or rolled back after it. Notes of no length are summarized for nothing but an ask that stands.
      asked: compactionDue({ ...standing, tokens: 0, limit: 0 }) === "due" ? asked : null,
      held: compactionDue({ ...standing, tokens, limit: limitOf(core.session.summarizeAtTokens) }) === "held",
      ...(behind !== null ? { behind } : {}),
    };
  }

  /** A chat's session as it stands now. */
  async view(userId: string, chatId: string): Promise<SessionView> {
    return this.session(userId, chatId, await this.deps.chats.path(userId, chatId));
  }

  /** A turn as the page lists it, from the core's record. */
  private row(turn: PathTurn, turns: readonly PathTurn[], standing: string | null, preview: string): TurnRow {
    const { record } = turn;
    return {
      turn: record.generationId,
      messageId: turn.messageId,
      index: turn.index,
      swipe: turn.swipeId,
      at: record.at,
      kind: record.kind,
      onPath: turn.onPath,
      preview,
      transcript: record.transcript ?? null,
      compaction: record.summary !== undefined ? { summary: record.summary, replaced: record.folded ?? 0, rollback: rollbackState(turn, turns, standing) } : null,
      usage: record.usage,
      // The record says how many files its turn's change set names, where the core counted them; the set itself is read on request (`lah.ws.changes`).
      changes: record.changed ?? 0,
    };
  }

  /** The opening of each reply among `turns`, by the reply's place in the chat: read as one range of the chat's messages, so only the texts of the page's replies are read. */
  private async previews(userId: string, chatId: string, turns: readonly PathTurn[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const chars = (await this.deps.settings.transport(userId)).sessions.previewChars;
    if (turns.length === 0 || chars === 0) return out;
    const indexes = turns.map((t) => t.index);
    const wanted = new Set(indexes);
    for (const m of await this.deps.chats.messages(userId, chatId, Math.min(...indexes), Math.max(...indexes) + 1)) {
      if (!wanted.has(m.index)) continue;
      const text = m.content.replace(/\s+/g, " ").trim();
      out.set(m.index, text.length > chars ? `${text.slice(0, chars).trimEnd()}…` : text);
    }
    return out;
  }

  /** `lah.turns.list`: a chat's turns, newest first, a page of them from `cursor`, with its session as it stands. */
  async list(userId: string, chatId: string, cursor: string | null, limit: number): Promise<TurnsPage> {
    const path = await this.deps.chats.path(userId, chatId);
    const turns = await pathTurns(path);
    const from = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(from) || from < 0) throw new UiRefused("bad_request", "That page of the chat's turns isn't one LumiAH gave.");
    const size = Math.min(limit, (await this.deps.settings.transport(userId)).sessions.page);
    const page = [...turns].reverse().slice(from, from + size);
    const previews = await this.previews(userId, chatId, page);
    const standing = sessionAt(turns).summary;
    return {
      turns: page.map((t) => this.row(t, turns, standing, previews.get(t.index) ?? "")),
      next: from + page.length < turns.length ? String(from + page.length) : null,
      total: turns.length,
      session: await this.session(userId, chatId, path),
    };
  }

  /** A stored transcript whole, by its hash; null when it is no longer stored, or the blob isn't one, with why the storage may be behind where it is. Blobs are kept per user, so one read by its hash is always the reader's own. */
  private async stored(userId: string, hash: string): Promise<{ transcript: TurnTranscript | null; behind: string | null }> {
    const { text, behind } = await this.text(userId, hashOf(hash, "A transcript"));
    return { transcript: text === null ? null : transcriptOf(text), behind };
  }

  /** A text the storage doesn't have: gone, or (`behind`) not there yet. */
  private missing(what: string, behind: string | null): UiRefused {
    return new UiRefused("not_found", behind === null ? `${what} is no longer stored.` : `${what} isn't in ${this.deps.name}'s storage yet. ${behind} Look again in a moment.`);
  }

  /** `lah.transcript.get`: a stored transcript as a live view, its events from `from` on, a page of them. */
  async transcript(userId: string, hash: string, from: number): Promise<{ view: LiveView; next: number | null }> {
    const { transcript: stored, behind } = await this.stored(userId, hash);
    if (stored === null) throw this.missing("That turn's transcript", behind);
    const size = (await this.deps.settings.transport(userId)).live.page;
    const events = stored.events.slice(from - 1, from - 1 + size);
    const read = from - 1 + events.length;
    const { ended } = stored;
    return {
      // A stored turn is over: no call of it is in flight.
      view: {
        stream: stored.chatId,
        chatId: stored.chatId === "" ? null : stored.chatId,
        turn: stored.turn,
        kind: stored.generation,
        messageId: stored.messageId,
        startedAt: stored.startedAt,
        ended: { state: ended.status, at: ended.at, ...(ended.reason !== undefined ? { reason: ended.reason } : {}) },
        events,
        partials: [],
      },
      next: stored.events.length > read ? read + 1 : null,
    };
  }

  /**
   * `lah.home.get`: a chat's latest turn. From its run in the live buffer while the buffer holds
   * one (`live`: the chat's latest run there, whole), with the reply and the transcript its record
   * names once it has left one; else from the latest record on the chat's path and the transcript
   * that record names. Null: LumiAH has worked on no reply in the chat.
   */
  async last(userId: string, chatId: string, live: LiveView | null): Promise<LastTurn | null> {
    if (live !== null && isReply(live.kind)) {
      // A turn under way has left no record yet, so the chat isn't read for one.
      const kept = live.ended === null ? null : latestRecord(await this.deps.chats.path(userId, chatId), live.turn);
      return lastOfLive(live, live.kind, kept === null ? null : { messageId: kept.message.id, transcript: kept.record.transcript ?? null });
    }
    const kept = latestRecord(await this.deps.chats.path(userId, chatId), null);
    if (kept === null) return null;
    const stored = kept.record.transcript === undefined ? null : (await this.stored(userId, kept.record.transcript)).transcript;
    return lastOfRecord({ messageId: kept.message.id, record: kept.record }, stored);
  }

  /** `lah.prompt.get`: the exact request of a model call. */
  async prompt(userId: string, hash: string): Promise<ModelRequest> {
    let behind: string | null = null;
    const get = async (h: string): Promise<string | null> => {
      const read = await this.text(userId, h);
      behind ??= read.behind;
      return read.text;
    };
    const prompt = await readCallPrompt({ get }, hashOf(hash, "A call's prompt"));
    if (prompt === null) throw this.missing("That call's prompt", behind);
    return prompt;
  }

  /** `lah.blob.get`: a stored text by its hash. */
  async blob(userId: string, hash: string): Promise<string> {
    const { text, behind } = await this.text(userId, hashOf(hash, "A stored text"));
    if (text === null) throw this.missing("That text", behind);
    return text;
  }

  /** `lah.session.rollback`: marks a turn's compaction as rolled back, so the chat's next turn reads the turns it replaced again. */
  async rollback(userId: string, chatId: string, messageId: string, swipe: number): Promise<{ turn: TurnRow; session: SessionView }> {
    const { now } = this.deps;
    const done = await rollback({ chat: this.chatPort(userId), clock: { now, sleep: async () => undefined } }, chatId, messageId, swipe);
    if ("refused" in done) throw new UiRefused("unavailable", done.refused);
    const path = await this.deps.chats.path(userId, chatId);
    const turns = await pathTurns(path);
    const turn = turns.find((t) => t.messageId === messageId && t.swipeId === swipe);
    if (turn === undefined) throw new UiRefused("not_found", "That reply is no longer on the chat's active path.");
    const previews = await this.previews(userId, chatId, [turn]);
    return { turn: this.row(turn, turns, sessionAt(turns).summary, previews.get(turn.index) ?? ""), session: await this.session(userId, chatId, path) };
  }
}
