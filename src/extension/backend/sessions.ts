// The Sessions page's reads (DESIGN §5, §8 Sessions): a chat's turns from the records on its
// replies, each turn's stored transcript and each call's exact prompt, the session as it stands at
// the end of the chat's active path, and the rollback of a compaction. Everything here is read with
// the core's own functions, so the page shows what the main agent would resume from, worked out the
// same way.

import { Blobs } from "../../core/blobs";
import type { ChatPort, ModelRequest, PathMessage } from "../../core/ports";
import { readCallPrompt } from "../../core/prompts";
import { carriedOf } from "../../core/receipts";
import { type PathTurn, pathTurns, rollback, sessionAt, Sessions } from "../../core/sessions";
import { settingsOf } from "../../core/settings";
import { textsOf } from "../../core/texts";
import { transcriptOf } from "../../core/transcript";
import { BLOB_HASH } from "../../link/contract";
import type { LiveView, RollbackState, SessionView, TurnRow, TurnsPage } from "../../shared/ui";
import type { Chats } from "./chat";
import { UiRefused } from "./errors";
import type { Storage } from "./reads";
import type { SettingsStore } from "./settings";

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

  /** The session as the main agent would resume it for a reply after every message of the path: read with the core's own resume and measured as it measures what it carries. */
  private async session(userId: string, path: PathMessage[]): Promise<SessionView> {
    const { storage, settings } = this.deps;
    const snapshot = await settings.snapshot(userId);
    const core = settingsOf(snapshot.values.core);
    // A store for this one read: nothing is kept in memory past it, and nothing is written.
    const blobs = new Blobs({ blobs: { get: (hash) => storage.blob(userId, hash), put: async () => undefined }, log: () => undefined }, () => 0);
    const resumed = await new Sessions({ chat: { ...this.chatPort(userId), path: async () => path } }, blobs).resume({ chatId: "", target: { messageId: null, swipeId: 0 }, kind: "new" });
    const carried = carriedOf({ summary: resumed.summary, turns: resumed.turns }, { receiptChars: core.session.receiptChars, charsPerToken: core.loop.charsPerToken, texts: textsOf(snapshot.texts) });
    return { turns: resumed.turns.length, tokens: carried.tokens, summary: resumed.summary !== null, dropped: resumed.refs.dropped.length, missing: resumed.missing };
  }

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
    };
  }

  /** The opening of each reply among `turns`, by the reply's place in the chat: read as one range of the chat's messages, so only the page's replies' texts are fetched. */
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
      session: await this.session(userId, path),
    };
  }

  /** `lah.transcript.get`: a stored transcript as a live view, its events from `from` on, a page of them. */
  async transcript(userId: string, chatId: string, hash: string, from: number): Promise<{ view: LiveView; next: number | null }> {
    await this.deps.chats.own(userId, chatId);
    const text = await this.deps.storage.blob(userId, hashOf(hash, "A transcript"));
    const stored = text === null ? null : transcriptOf(text);
    if (stored === null || stored.chatId !== chatId) throw new UiRefused("not_found", "That turn's transcript is no longer stored.");
    const size = (await this.deps.settings.transport(userId)).live.page;
    const events = stored.events.slice(from - 1, from - 1 + size);
    const read = from - 1 + events.length;
    const { ended } = stored;
    return {
      // A stored turn is over: no call of it is in flight.
      view: { chatId, turn: stored.turn, kind: stored.generation, messageId: stored.messageId, startedAt: stored.startedAt, ended: { state: ended.status, at: ended.at, ...(ended.reason !== undefined ? { reason: ended.reason } : {}) }, events, partials: [] },
      next: stored.events.length > read ? read + 1 : null,
    };
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
    return { turn: this.row(turn, turns, sessionAt(turns).summary, previews.get(turn.index) ?? ""), session: await this.session(userId, path) };
  }
}
