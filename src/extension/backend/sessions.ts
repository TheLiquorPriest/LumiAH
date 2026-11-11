// The Sessions page's reads (DESIGN §5, §8 Sessions): a chat's turns from the records on its
// replies, each turn's stored transcript and each call's exact prompt, the session as it stands at
// the end of the chat's active path with what the next turn will do about a summary, and the
// rollback of a compaction. And what the first screen says of a chat's latest turn (§8 Home), which
// is read from the same records. Everything here is read with the core's own functions, so the page
// shows what the main agent would resume from, worked out the same way.

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
import { UiRefused } from "./errors";
import type { Storage } from "./reads";
import type { SettingsStore } from "./settings";
import { lastOfLive, lastOfRecord, type Ran, ranOf } from "./views";

export interface SessionsDeps {
  chats: Chats;
  storage: Storage;
  settings: SettingsStore;
  now(): number;
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
   * The session as the main agent would resume it for a reply after every message of the path: read
   * with the core's own resume and measured as it measures what it carries. Whether the user's ask
   * for a summary still stands, and whether a rollback holds the notes, are the core's own verdict
   * (`compactionDue`) on what the chat's next turn would read.
   */
  private async session(userId: string, chatId: string, path: PathMessage[]): Promise<SessionView> {
    const { storage, settings } = this.deps;
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
    };
  }

  /** A chat's session as it stands now. */
  async view(userId: string, chatId: string): Promise<SessionView> {
    return this.session(userId, chatId, await this.deps.chats.path(userId, chatId));
  }

  /** A turn as the page lists it: the core's record, and where the turn ran (`ran`), which the extension wrote beside it. */
  private row(turn: PathTurn, turns: readonly PathTurn[], standing: string | null, preview: string, ran: Ran): TurnRow {
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
      ...(ran.place !== undefined ? { place: ran.place } : {}),
      ...(ran.noPart !== undefined ? { noPart: ran.noPart } : {}),
      // The core's own word that the record was written after the fact (the extension restarted between the turn's halves, or the reply came after the wait for it).
      ...(record.recovered !== undefined ? { recovered: record.recovered } : {}),
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
      turns: page.map((t) => this.row(t, turns, standing, previews.get(t.index) ?? "", ranOf(path[t.at]?.anchor))),
      next: from + page.length < turns.length ? String(from + page.length) : null,
      total: turns.length,
      session: await this.session(userId, chatId, path),
    };
  }

  /** A stored transcript whole, by its hash; null when it is no longer stored, or the blob isn't one. Blobs are kept per user, so one read by its hash is always the reader's own. */
  async stored(userId: string, hash: string): Promise<TurnTranscript | null> {
    const text = await this.deps.storage.blob(userId, hashOf(hash, "A transcript"));
    return text === null ? null : transcriptOf(text);
  }

  /** `lah.transcript.get`: a stored transcript as a live view, its events from `from` on, a page of them. */
  async transcript(userId: string, hash: string, from: number): Promise<{ view: LiveView; next: number | null }> {
    const stored = await this.stored(userId, hash);
    if (stored === null) throw new UiRefused("not_found", "That turn's transcript is no longer stored.");
    const size = (await this.deps.settings.transport(userId)).live.page;
    const events = stored.events.slice(from - 1, from - 1 + size);
    const read = from - 1 + events.length;
    const { ended } = stored;
    // Only a built-in reply's turn has a time before its reply ends (§25), and its first event says when: a transcript that says so is one. Any other names no place: the record on the reply says where its turn ran (`TurnRow.place`).
    const first = stored.events[0]?.event;
    const replyBy = first?.kind === "turn_started" && typeof first.replyBy === "number" ? first.replyBy : null;
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
        ...(replyBy !== null ? { place: "builtin" as const, replyBy } : {}),
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
    const stored = kept.record.transcript === undefined ? null : await this.stored(userId, kept.record.transcript);
    return lastOfRecord({ messageId: kept.message.id, record: kept.record, ran: ranOf(kept.message.anchor) }, stored);
  }

  /** `lah.prompt.get`: the exact request of a model call. */
  async prompt(userId: string, hash: string): Promise<ModelRequest> {
    const prompt = await readCallPrompt({ get: (h) => this.deps.storage.blob(userId, h) }, hashOf(hash, "A call's prompt"));
    if (prompt === null) throw new UiRefused("not_found", "That call's prompt is no longer stored.");
    return prompt;
  }

  /** `lah.blob.get`: a stored text by its hash. */
  async blob(userId: string, hash: string): Promise<string> {
    const text = await this.deps.storage.blob(userId, hashOf(hash, "A stored text"));
    if (text === null) throw new UiRefused("not_found", "That text is no longer stored.");
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
    return { turn: this.row(turn, turns, sessionAt(turns).summary, previews.get(turn.index) ?? "", ranOf(path[turn.at]?.anchor)), session: await this.session(userId, chatId, path) };
  }
}
