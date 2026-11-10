// Sessions and anchors (DESIGN §5). The session is the main agent's working memory across turns: each
// turn's segment of it (what it was told, what it called, what came back, what it concluded) and the
// summaries compaction makes, every one a blob. The chat's own messages are never copied into it:
// Lumiverse sends those with every request.
//
// Each turn leaves a record on its reply's message (`TurnRecord`), one per swipe, which carries only
// hashes and the path hash chained over the messages before the reply. The session at a turn is read
// by walking the chat's active path back from the reply to the latest record with a summary, then
// taking the segments after it. So a swipe, a regenerate, an edit and a branch need no bookkeeping:
// whatever path is active is the one that is read.
//
// - A record whose path hash no longer matches the messages before it (an earlier message was edited
//   or deleted) is off the path: it is not used, and the turn says which replies' notes were dropped.
// - A summary is the base the session reads from in place of everything before its record: the text
//   that stands for what came before, then the segments it kept whole (`TurnRecord.kept`), then that
//   record's own segment and those after it. It lands with the record of the turn that makes it, so
//   no earlier record changes, and the turns it replaced stay on their own records.
// - A rollback marks a summary's record (`rolledBack`): the walk then reads past it, back to the
//   summary before it or to the start, which is exactly the span it replaced.

import type { Blobs } from "./blobs";
import { isHash, nextPath, ROOT_PATH } from "./hash";
import type { AgentUsage, HarnessHost, JsonObject, PathMessage, TurnKind, TurnRecord, TurnRequest } from "./ports";
import { isRecord } from "./ports";
import type { PastTurn } from "./tools";
import { emptyUsage } from "./usage";

// ---------------------------------------------------------------- a turn's segment

/**
 * One thing the main agent did in a turn: something it wrote beside its tool calls, a tool call with
 * what came back (as the model read it), the reply when it wrote that itself (its length only: the
 * reply is in the chat), or its stop short of a conclusion.
 */
export type SegmentStep = { kind: "said"; text: string } | { kind: "call"; name: string; args: JsonObject; result: string; error?: true } | { kind: "reply"; chars: number } | { kind: "stop"; reason: string };

/**
 * What a turn added to the session: the reply it was for (its place in the chat), the generation,
 * what the request was (how many messages, and the last chat message it held: the messages
 * themselves aren't kept), and each step of the main agent's work, in order. A turn that continues a
 * reply holds the steps of the turn it continues before its own, so the record of a swipe names all
 * the work done for it.
 */
export interface SessionSegment {
  v: 1;
  kind: "segment";
  reply: number;
  generationId: string;
  turn: TurnKind;
  at: number;
  request: { messages: number; last: number | null };
  steps: SegmentStep[];
}

const TURN_KINDS: readonly TurnKind[] = ["new", "regenerate", "swipe", "continue"];

function isTurnKind(v: unknown): v is TurnKind {
  return typeof v === "string" && (TURN_KINDS as readonly string[]).includes(v);
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function stepOf(raw: unknown): SegmentStep | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "said" && typeof raw.text === "string") return { kind: "said", text: raw.text };
  if (raw.kind === "call" && typeof raw.name === "string" && isRecord(raw.args) && typeof raw.result === "string") return { kind: "call", name: raw.name, args: raw.args as JsonObject, result: raw.result, ...(raw.error === true ? { error: true as const } : {}) };
  if (raw.kind === "reply" && isCount(raw.chars)) return { kind: "reply", chars: raw.chars };
  if (raw.kind === "stop" && typeof raw.reason === "string") return { kind: "stop", reason: raw.reason };
  return null;
}

/** A stored segment, read; null when the blob isn't one. A step that doesn't read as one is left out. */
export function segmentOf(raw: unknown): SessionSegment | null {
  if (!isRecord(raw) || raw.v !== 1 || raw.kind !== "segment" || !isCount(raw.reply) || typeof raw.generationId !== "string" || !isTurnKind(raw.turn) || typeof raw.at !== "number" || !isRecord(raw.request) || !Array.isArray(raw.steps)) return null;
  const { messages, last } = raw.request;
  return { v: 1, kind: "segment", reply: raw.reply, generationId: raw.generationId, turn: raw.turn, at: raw.at, request: { messages: isCount(messages) ? messages : 0, last: isCount(last) ? last : null }, steps: raw.steps.flatMap((s) => stepOf(s) ?? []) };
}

// ---------------------------------------------------------------- a turn's record

function usageOf(raw: unknown): AgentUsage {
  const out = emptyUsage();
  if (!isRecord(raw)) return out;
  const n = (key: string): number => {
    const v = raw[key];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  };
  Object.assign(out, { calls: n("calls"), toolTurns: n("toolTurns"), in: n("in"), cachedIn: n("cachedIn"), out: n("out"), reasoningOut: n("reasoningOut"), estimated: raw.estimated === true, ms: n("ms") });
  if (typeof raw.cacheWrite === "number") out.cacheWrite = n("cacheWrite");
  if (typeof raw.cost === "number") out.cost = n("cost");
  else delete out.cost;
  return out;
}

/**
 * A message's anchor as a record; null when it isn't one. Records come from a message's metadata,
 * which anything may have written, so every hash is checked to be one (it can then name only a blob)
 * and anything else is left out.
 */
export function recordOf(anchor: unknown): TurnRecord | null {
  if (!isRecord(anchor) || anchor.v !== 1 || typeof anchor.generationId !== "string" || !isTurnKind(anchor.kind) || typeof anchor.at !== "number" || typeof anchor.path !== "string" || !isHash(anchor.segment)) return null;
  const summary = isHash(anchor.summary) ? anchor.summary : undefined;
  return {
    v: 1,
    generationId: anchor.generationId,
    kind: anchor.kind,
    at: anchor.at,
    path: anchor.path,
    segment: anchor.segment,
    ...(isHash(anchor.transcript) ? { transcript: anchor.transcript } : {}),
    ...(summary !== undefined ? { summary, kept: Array.isArray(anchor.kept) ? anchor.kept.filter(isHash) : [], folded: isCount(anchor.folded) ? anchor.folded : 0 } : {}),
    ...(summary !== undefined && typeof anchor.rolledBack === "number" ? { rolledBack: anchor.rolledBack } : {}),
    usage: usageOf(anchor.usage),
  };
}

// ---------------------------------------------------------------- the path

/**
 * The path hash before each message of a path, and after the last: `[i]` is chained over the messages
 * before the `i`th (their roles and their texts' fingerprints), so it is what a record on that
 * message carries while none of them has changed.
 */
export async function pathHashes(path: readonly PathMessage[]): Promise<string[]> {
  const out: string[] = [ROOT_PATH];
  let hash = ROOT_PATH;
  for (const m of path) {
    hash = await nextPath(hash, m.role, m.hash);
    out.push(hash);
  }
  return out;
}

/** A turn's record as it stands on a path: where its reply is, and whether the messages before it are still the ones it was made on. */
export interface PathTurn {
  /** The reply's place in the path given, from 0. */
  at: number;
  /** The reply's place in the chat (`index_in_chat`). */
  index: number;
  messageId: string;
  swipeId: number;
  record: TurnRecord;
  onPath: boolean;
}

/** Every message of `path` that holds a record for the swipe it shows, oldest first. `hashes`: the path's hashes, where the caller has them already (`pathHashes`). */
export async function pathTurns(path: readonly PathMessage[], hashes?: readonly string[]): Promise<PathTurn[]> {
  const before = hashes ?? (await pathHashes(path));
  return path.flatMap((m, at): PathTurn[] => {
    const record = recordOf(m.anchor);
    return record ? [{ at, index: m.index, messageId: m.id, swipeId: m.swipeId, record, onPath: record.path === before[at] }] : [];
  });
}

/** Where the session stands at a point of a path, by hash. */
export interface SessionRefs {
  /** The summary it reads from, by its text's hash; null when none stands. */
  summary: string | null;
  /** The segments read whole after it, oldest first: those the summary kept, then each turn's since. */
  segments: string[];
  /** The replies whose records are off the path, by their place in the chat, oldest first. */
  dropped: number[];
  /** The latest summary a rollback undid that the walk read past; null when it passed none. */
  rolledBack: string | null;
}

/**
 * Where the session stands after `turns` (the records before a reply, oldest first): walked back
 * from the newest to the latest record on the path with a summary that stands. Pure: no blob is read.
 */
export function sessionAt(turns: readonly PathTurn[]): SessionRefs {
  const segments: string[] = [];
  const dropped: number[] = [];
  let rolledBack: string | null = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i] as PathTurn;
    if (!turn.onPath) {
      dropped.unshift(turn.index);
      continue;
    }
    const { record } = turn;
    segments.unshift(record.segment);
    if (record.summary === undefined) continue;
    if (record.rolledBack !== undefined) {
      rolledBack ??= record.summary;
      continue;
    }
    return { summary: record.summary, segments: [...(record.kept ?? []), ...segments], dropped, rolledBack };
  }
  return { summary: null, segments, dropped, rolledBack };
}

// ---------------------------------------------------------------- reading a session

/** The session a turn reads, and where its own record goes. */
export interface ResumedSession {
  refs: SessionRefs;
  /** The summary standing for what came before `turns`; null when nothing was summarized. */
  summary: string | null;
  /** The turns read whole, oldest first. */
  turns: PastTurn[];
  /** Blobs the records name that the store couldn't give, or that don't read as what they should be: what they held is missing. */
  missing: number;
  /** The path's messages before the reply, oldest first. */
  before: PathMessage[];
  /** The reply's place in the chat. */
  reply: number;
  /** The path hash this turn's record carries: chained over the messages before the reply. */
  path: string;
  /** For a continue: the turn the continued swipe's own record holds, whose steps this turn's segment keeps before its own. */
  continued: PastTurn | null;
}

/** What a compaction lands on the record of the turn that makes it. */
export interface Compaction {
  summary: string;
  kept: string[];
  folded: number;
}

export class Sessions {
  constructor(
    private readonly host: Pick<HarnessHost, "chat">,
    private readonly blobs: Blobs,
  ) {}

  /**
   * The session a turn reads: the chat's active path walked back from the turn's reply (the message
   * it targets, or after every message when Lumiverse makes the reply's message only as it saves it),
   * and each blob the walk names read.
   */
  async resume(turn: Pick<TurnRequest, "chatId" | "target" | "kind">): Promise<ResumedSession> {
    const path = await this.host.chat.path(turn.chatId);
    const found = turn.target.messageId === null ? -1 : path.findIndex((m) => m.id === turn.target.messageId);
    const at = found < 0 ? path.length : found;
    const hashes = await pathHashes(path);
    const refs = sessionAt((await pathTurns(path, hashes)).filter((t) => t.at < at));
    let missing = 0;
    const summary = refs.summary === null ? null : await this.blobs.get(refs.summary);
    if (refs.summary !== null && summary === null) missing++;
    const read = await Promise.all(refs.segments.map(async (hash) => ({ hash, segment: segmentOf(await this.blobs.getJson(hash)) })));
    const turns: PastTurn[] = [];
    for (const { hash, segment } of read) {
      if (segment) turns.push({ reply: segment.reply, hash, segment });
      else missing++;
    }
    const target = path[at];
    const own = turn.kind === "continue" && target ? recordOf(target.anchor) : null;
    const before = own && own.path === hashes[at] ? segmentOf(await this.blobs.getJson(own.segment)) : null;
    const continued = own && before ? { reply: before.reply, hash: own.segment, segment: before } : null;
    return { refs, summary, turns, missing, before: path.slice(0, at), reply: target ? target.index : (path.at(-1)?.index ?? -1) + 1, path: hashes[at] ?? ROOT_PATH, continued };
  }

  /** Stores what a turn added to the session, and gives its hash. */
  segment(segment: SessionSegment): Promise<string> {
    return this.blobs.putJson(segment as unknown as JsonObject);
  }

  /**
   * Lands a summary: its text stored, to stand for every turn of `session` but the latest `kept`,
   * which stay whole after it. What it gives goes on the record of the turn that made it.
   */
  async compact(summary: string, kept: readonly PastTurn[], folded: number): Promise<Compaction> {
    return { summary: await this.blobs.put(summary), kept: kept.map((t) => t.hash), folded };
  }
}

// ---------------------------------------------------------------- rollback

/**
 * Rolls back the compaction made at a turn: its record, on the swipe the chat shows, is written back
 * marked, so the session reads the turns its summary replaced again from the next turn on. Refused,
 * with why in plain words, when there is nothing there to roll back.
 */
export async function rollback(host: Pick<HarnessHost, "chat" | "clock">, chatId: string, messageId: string, swipeId: number): Promise<{ record: TurnRecord } | { refused: string }> {
  const message = (await host.chat.path(chatId)).find((m) => m.id === messageId);
  if (!message) return { refused: "That reply is no longer on the chat's active path." };
  if (message.swipeId !== swipeId) return { refused: "The chat shows another swipe of that reply now. Switch to the swipe whose summary you want to roll back, then try again." };
  const record = recordOf(message.anchor);
  if (!record) return { refused: "That reply has no record of LumiAH's." };
  if (record.summary === undefined) return { refused: "No summary was made at that turn, so there is nothing to roll back." };
  if (record.rolledBack !== undefined) return { refused: "That summary was already rolled back." };
  const marked: TurnRecord = { ...record, rolledBack: host.clock.now() };
  if (!(await host.chat.anchor(chatId, messageId, swipeId, marked as unknown as JsonObject))) return { refused: "That reply is gone, so its record couldn't be written." };
  return { record: marked };
}
