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
//   summary before it or to the start, which is exactly the span it replaced. A regenerate, a swipe
//   or a continue of that reply carries the marked summary on its own record, so the rollback holds
//   whichever swipe the chat shows afterwards.

import type { Blobs } from "./blobs";
import { isHash, nextPath, ROOT_PATH } from "./hash";
import { DOC } from "./paths";
import type { AgentUsage, HarnessHost, JobState, JsonObject, PathMessage, RecordJob, TurnKind, TurnRecord, TurnRequest } from "./ports";
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

const JOB_STATES: readonly JobState[] = ["queued", "running", "done", "failed", "cancelled", "interrupted", "off_path", "spent", "paused"];

/** A job as a record lists it; null for what isn't one. */
function recordJobOf(raw: unknown): RecordJob | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.agent !== "string" || typeof raw.state !== "string" || !(JOB_STATES as readonly string[]).includes(raw.state)) return null;
  return { id: raw.id, agent: raw.agent, state: raw.state as JobState, ...(isHash(raw.report) ? { report: raw.report } : {}) };
}

/**
 * A message's anchor as a record; null when it isn't one. Records come from a message's metadata,
 * which anything may have written, so every hash is checked to be one (it can then name only a blob)
 * and anything else is left out.
 */
export function recordOf(anchor: unknown): TurnRecord | null {
  if (!isRecord(anchor) || anchor.v !== 1 || typeof anchor.generationId !== "string" || !isTurnKind(anchor.kind) || typeof anchor.at !== "number" || typeof anchor.path !== "string" || !isHash(anchor.segment)) return null;
  const summary = isHash(anchor.summary) ? anchor.summary : undefined;
  const jobs = Array.isArray(anchor.jobs) ? anchor.jobs.flatMap((job) => recordJobOf(job) ?? []) : [];
  return {
    v: 1,
    generationId: anchor.generationId,
    kind: anchor.kind,
    ...(typeof anchor.began === "number" ? { began: anchor.began } : {}),
    ...(typeof anchor.heard === "number" ? { heard: anchor.heard } : {}),
    at: anchor.at,
    path: anchor.path,
    segment: anchor.segment,
    ...(isHash(anchor.transcript) ? { transcript: anchor.transcript } : {}),
    ...(summary !== undefined ? { summary, kept: Array.isArray(anchor.kept) ? anchor.kept.filter(isHash) : [], folded: isCount(anchor.folded) ? anchor.folded : 0 } : {}),
    ...(summary !== undefined && typeof anchor.rolledBack === "number" ? { rolledBack: anchor.rolledBack } : {}),
    ...(isHash(anchor.workspace) ? { workspace: anchor.workspace } : {}),
    ...(isCount(anchor.changed) && anchor.changed > 0 ? { changed: anchor.changed } : {}),
    ...(jobs.length > 0 ? { jobs } : {}),
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
  /**
   * Those of them no turn has been told of yet: the ones after the latest record that stands on the
   * path. A turn that left a record was told of every one before it, so each is said once.
   */
  fresh: number[];
  /** The latest summary a rollback undid that the walk read past; null when it passed none. */
  rolledBack: string | null;
  /** When that rollback was made. */
  rolledBackAt: number | null;
}

/**
 * Where the session stands after `turns` (the records before a reply, oldest first): walked back
 * from the newest to the latest record on the path with a summary that stands. Pure: no blob is read.
 */
export function sessionAt(turns: readonly PathTurn[]): SessionRefs {
  const segments: string[] = [];
  const dropped: number[] = [];
  let fresh: number[] | null = null;
  let rolledBack: string | null = null;
  let rolledBackAt: number | null = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i] as PathTurn;
    if (!turn.onPath) {
      dropped.unshift(turn.index);
      continue;
    }
    fresh ??= [...dropped];
    const { record } = turn;
    segments.unshift(record.segment);
    if (record.summary === undefined) continue;
    if (record.rolledBack !== undefined) {
      if (rolledBack === null) {
        rolledBack = record.summary;
        rolledBackAt = record.rolledBack;
      }
      continue;
    }
    return { summary: record.summary, segments: [...(record.kept ?? []), ...segments], dropped, fresh, rolledBack, rolledBackAt };
  }
  return { summary: null, segments, dropped, fresh: fresh ?? [...dropped], rolledBack, rolledBackAt };
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
  /**
   * The records on the path before the reply that still stand on it, oldest first: the turns this
   * one follows. What the chat's area and the chat's jobs are read from (§11, §15).
   */
  records: TurnRecord[];
  /** For a continue: the continued swipe's own record, where it still stands on the path. */
  own: TurnRecord | null;
  /**
   * The summary made on this very reply that the user rolled back, where the turn answers that
   * reply again (a regenerate, a swipe or a continue of it). The walk never passes it, since it
   * reads only the records before the reply, so `refs` names it from here; and this turn's record
   * carries it on, marked as it was, so the rollback holds for the turns after whichever swipe the
   * chat then shows. Null when the reply holds none.
   */
  held: (Compaction & { rolledBack: number }) | null;
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
    const earlier = (await pathTurns(path, hashes)).filter((t) => t.at < at);
    const walked = sessionAt(earlier);
    const target = path[at];
    // The record on the reply itself, for the swipe the chat shows, while the messages before it are still the ones it was made on: what a regenerate, a swipe or a continue answers again.
    const shown = target ? recordOf(target.anchor) : null;
    const again = shown && shown.path === hashes[at] ? shown : null;
    const held = again && again.summary !== undefined && again.rolledBack !== undefined ? { summary: again.summary, kept: again.kept ?? [], folded: again.folded ?? 0, rolledBack: again.rolledBack } : null;
    // It is later than any the walk passed, so it is the one the session says it read past.
    const refs: SessionRefs = held ? { ...walked, rolledBack: held.summary, rolledBackAt: held.rolledBack } : walked;
    let missing = 0;
    const summary = refs.summary === null ? null : await this.blobs.get(refs.summary);
    if (refs.summary !== null && summary === null) missing++;
    const read = await Promise.all(refs.segments.map(async (hash) => ({ hash, segment: segmentOf(await this.blobs.getJson(hash)) })));
    const turns: PastTurn[] = [];
    for (const { hash, segment } of read) {
      if (segment) turns.push({ reply: segment.reply, hash, segment });
      else missing++;
    }
    const own = turn.kind === "continue" ? again : null;
    const before = own ? segmentOf(await this.blobs.getJson(own.segment)) : null;
    const continued = own && before ? { reply: before.reply, hash: own.segment, segment: before } : null;
    return { refs, summary, turns, missing, before: path.slice(0, at), reply: target ? target.index : (path.at(-1)?.index ?? -1) + 1, path: hashes[at] ?? ROOT_PATH, continued, records: earlier.filter((t) => t.onPath).map((t) => t.record), own, held };
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
 * marked, so the session reads the turns its summary replaced again from the next turn on, and the
 * notes aren't summarized again until they have grown by Settings' margin or the user asks for it
 * (`askCompaction`). Refused, with why in plain words, when rolling it back would change nothing.
 */
export async function rollback(host: Pick<HarnessHost, "chat" | "clock">, chatId: string, messageId: string, swipeId: number): Promise<{ record: TurnRecord } | { refused: string }> {
  const path = await host.chat.path(chatId);
  const message = path.find((m) => m.id === messageId);
  if (!message) return { refused: "That reply is no longer on the chat's active path." };
  if (message.swipeId !== swipeId) return { refused: "The chat shows another swipe of that reply now. Switch to the swipe whose summary you want to roll back, then try again." };
  const turns = await pathTurns(path);
  const turn = turns.find((t) => t.messageId === messageId);
  if (!turn) return { refused: "That reply has no record of LumiAH's." };
  const { record } = turn;
  if (record.summary === undefined) return { refused: "No summary was made at that turn, so there is nothing to roll back." };
  if (record.rolledBack !== undefined) return { refused: "That summary was already rolled back." };
  // The session reads from the latest summary that stands and never looks beneath it: rolling back one that isn't read would change nothing.
  if (!turn.onPath) return { refused: "An earlier message of the chat changed since that turn, so its notes and its summary are no longer read: there is nothing to roll back." };
  const later = turns.find((t) => t.at > turn.at && t.onPath && t.record.summary !== undefined && t.record.rolledBack === undefined);
  if (later) return { refused: `A later summary, made at reply #${later.index}, stands over this one: the notes are read from that one on. Roll that one back first.` };
  const marked: TurnRecord = { ...record, rolledBack: host.clock.now() };
  if (!(await host.chat.anchor(chatId, messageId, swipeId, marked as unknown as JsonObject))) return { refused: "That reply is gone, so its record couldn't be written." };
  return { record: marked };
}

// ---------------------------------------------------------------- summarizing on request

/** What the user asked of a chat's session, as stored (`DOC.session`): when they last asked for its notes to be summarized. */
interface SessionDoc {
  v: 1;
  kind: "session";
  compactAsked: number;
}

/** The user asks for the chat's notes to be summarized: the next turn does it, whatever their length and whatever a rollback holds. */
export async function askCompaction(host: Pick<HarnessHost, "store" | "clock">, chatId: string): Promise<{ asked: number }> {
  const doc: SessionDoc = { v: 1, kind: "session", compactAsked: host.clock.now() };
  await host.store.write(DOC.session(chatId), doc as unknown as JsonObject);
  return { asked: doc.compactAsked };
}

/** When the user last asked for the chat's notes to be summarized; null when they never did. */
export async function compactionAsked(host: Pick<HarnessHost, "store">, chatId: string): Promise<number | null> {
  const doc = await host.store.read(DOC.session(chatId));
  return isRecord(doc) && doc.v === 1 && doc.kind === "session" && typeof doc.compactAsked === "number" ? doc.compactAsked : null;
}

/**
 * Whether a turn summarizes the main agent's notes (DESIGN §5), and why not where a rollback holds
 * it back.
 *
 * - The user asked for it since the last summary was made or rolled back: it does.
 * - The session read past a summary the user rolled back: it doesn't, until the notes have grown by
 *   Settings' margin over what they were at the rollback. Summarizing at once would undo what the
 *   user just did.
 * - Else it does once the notes pass Summarize past.
 */
export function compactionDue(input: { tokens: number; limit: number; asked: number | null; records: readonly TurnRecord[]; rolledBackAt: number | null; tokensAtRollback: number; margin: number }): "due" | "held" | "no" {
  // The latest moment a summary was made or rolled back on this path, the reply's own rolled-back one with them: an ask older than it was answered already. A rolled-back summary counts from its rollback alone: a record that only carries one on is later than that, and made nothing.
  let last = input.rolledBackAt ?? 0;
  for (const record of input.records) if (record.summary !== undefined) last = Math.max(last, record.rolledBack ?? record.at);
  if (input.asked !== null && input.asked > last) return "due";
  if (input.tokens <= input.limit) return "no";
  if (input.rolledBackAt !== null && input.tokens <= input.tokensAtRollback + input.margin) return "held";
  return "due";
}
