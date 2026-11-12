// Upkeep (DESIGN §20): what the core has stored, how big it is, and the sweep that removes the blobs
// nothing refers to and what Settings no longer keep.
//
// A blob doesn't say what it is, or whether anything still wants it: both are read from what refers
// to it. So a sweep first walks everything that names a blob (every record on every swipe of every
// chat, then the store's documents that name blobs: the area heads, each job, each side session) to
// the set of blobs that are live, each under the kind it is kept as. Then it lists every blob stored
// and removes those that are neither live nor younger than the grace time: a run under way has
// stored blobs that nothing names yet.
//
// Three kinds are kept for a time Settings hold. A transcript and the prompts it names are counted
// from when their turn, job or side turn ended. The segments a compaction replaced are counted from
// when its summary was made: while they are kept, the summary can still be rolled back. Everything
// else is kept as long as something refers to it.
//
// Nothing read is trusted to be what it should be: a record, a document or a blob that doesn't read
// as one refers to nothing, and the sweep goes on. A read that fails is another matter. Every read
// comes before the first removal, so a sweep that couldn't read something ends having removed
// nothing: what it couldn't read may name blobs that are still wanted.

import type { Blobs } from "./blobs";
import { isHash } from "./hash";
import { DOC } from "./paths";
import type { BlobInfo, HarnessHost, JsonValue, TurnRecord } from "./ports";
import { isRecord } from "./ports";
import { HarnessRefusal } from "./refusal";
import { pathTurns, recordOf } from "./sessions";
import type { Settings } from "./settings";
import { transcriptOf } from "./transcript";
import { errorText, type Limit } from "./util";

// ---------------------------------------------------------------- what is reported

/**
 * One kind of blob the core stores: how many are stored, how big they are together, when the oldest
 * was first stored (null: there is none), and the setting that says how long the kind is kept, by
 * its path (null: as long as something refers to it).
 * - `segment`: a turn's notes;
 * - `summary`: a compaction's summary;
 * - `transcript`: a run's transcript;
 * - `prompt`: a model call's exact request, which a transcript's entries name;
 * - `index`: a workspace area's index;
 * - `file`: a workspace file's body, the version its index holds or one it held before;
 * - `report`: a job's report;
 * - `session`: a job's conversation as it stood when the job was paused or stopped, which a run that
 *   carries it on takes up;
 * - `side`: what a side session's turn said and answered, and a side session's summary.
 */
export interface StoredKind {
  kind: "segment" | "summary" | "transcript" | "prompt" | "index" | "file" | "report" | "session" | "side";
  count: number;
  bytes: number;
  oldestAt: number | null;
  keep: string[] | null;
}

/**
 * What is stored, as the last sweep or count found it: each kind of blob something refers to; every
 * blob together; the blobs nothing refers to (`loose`: those a sweep would remove, and those within
 * the grace time, which it leaves; `at`: when they were counted); what the last sweep removed and
 * how long it took (null: there was none yet); and whether a sweep is under way now.
 */
export interface UpkeepSummary {
  kinds: StoredKind[];
  total: { count: number; bytes: number };
  loose: { count: number; bytes: number; at: number } | null;
  lastSweep: { at: number; removed: number; bytes: number; ms: number } | null;
  sweeping: boolean;
}

/** What the last sweep or count found, as stored (`DOC.upkeep`). */
interface UpkeepDoc extends Omit<UpkeepSummary, "sweeping"> {
  v: 1;
  kind: "upkeep";
}

/** The stored findings, read; null when the document isn't one. Past its envelope it is taken as the core wrote it. */
function docOf(raw: unknown): UpkeepDoc | null {
  if (!isRecord(raw) || raw.v !== 1 || raw.kind !== "upkeep" || !Array.isArray(raw.kinds) || !isRecord(raw.total)) return null;
  return raw as unknown as UpkeepDoc;
}

type Kind = StoredKind["kind"];

/** The kinds, in the order they are reported. A text kept under two of them (a file whose text is also a summary's) is counted once, under the one that comes first here. */
const KINDS: readonly Kind[] = ["segment", "summary", "transcript", "prompt", "index", "file", "report", "session", "side"];

/**
 * The setting that says how long each kind is kept, by its path; null for a kind kept as long as
 * something refers to it. A segment is kept as long as its turn's record is: Summarized turns kept
 * for bounds only the segments a compaction replaced, and is the one setting that removes any.
 */
const KEPT: Readonly<Record<Kind, readonly string[] | null>> = {
  segment: ["keep", "spanDays"],
  summary: null,
  transcript: ["keep", "transcriptDays"],
  prompt: ["keep", "promptDays"],
  index: null,
  file: null,
  report: null,
  session: null,
  side: null,
};

// ---------------------------------------------------------------- what refers to what

/** The keep times are settings in days, and the grace time one in hours. */
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The store's documents that name blobs, by their paths as `DOC` writes them: where an area's index
 * stands (the user's area, a chat's `learned/`, the chat's own area for one turn), a job's own
 * document, a side session's own, and a turn that waits for its reply where the host writes it
 * (§25). The lists kept beside the jobs' documents match a job's path too; each document's own
 * `kind` says what it is.
 */
const AREA_DOC = /^(?:workspace\/user|chats\/[^/]+\/learned|chats\/[^/]+\/area\/[^/]+)\.json$/;
const JOB_DOC = /^jobs\/[^/]+\.json$/;
const SIDE_DOC = /^sides\/[^/]+\.json$/;
/**
 * What built-in mode left in the store, which LumiAH's `main` branch still has: its turns that waited
 * for their replies, and its own list of the jobs it ran. Nothing reads them here, and they name
 * nothing a sweep keeps: a sweep removes them.
 */
const LEFTOVER_DOC = /^(?:pending\/[^/]+|jobs\/running\.builtin)\.json$/;

/** A record, and the swipe that holds it. */
interface Held {
  chatId: string;
  messageId: string;
  swipeId: number;
  record: TurnRecord;
}

/** A swipe of a message, as a key within its chat. */
function swipeKey(messageId: string, swipeId: number): string {
  return `${swipeId} ${messageId}`;
}

/**
 * One walk's findings: every blob something still refers to, under the kind it is kept as. What a
 * record or a document names directly is marked; an index is followed to its files, and a transcript
 * to its prompts, each read once however many records name it.
 */
class Walk {
  readonly live = new Map<string, Kind>();
  /** The indexes followed to their files, and the transcripts followed to their prompts. Apart, so a blob named as both is followed as both. */
  private readonly indexes = new Set<string>();
  private readonly transcripts = new Set<string>();

  constructor(
    private readonly blobs: Blobs,
    private readonly now: number,
    private readonly keep: Settings["keep"],
  ) {}

  /** Whether what was made at `at` is still within a keep time of `days` (null: it is kept for good). */
  within(at: number, days: Limit): boolean {
    return days === null || this.now - at < days * DAY_MS;
  }

  /** `hash` is kept, as a blob of `kind`; anything that isn't a hash names no blob. */
  mark(hash: unknown, kind: Kind): void {
    if (!isHash(hash)) return;
    const had = this.live.get(hash);
    if (had === undefined || KINDS.indexOf(kind) < KINDS.indexOf(had)) this.live.set(hash, kind);
  }

  /** An area's index, and through it every file's body: the version it holds, and each one before it that its history keeps. */
  async index(hash: unknown): Promise<void> {
    if (!isHash(hash) || this.indexes.has(hash)) return;
    this.indexes.add(hash);
    this.mark(hash, "index");
    const index = await this.blobs.getJson(hash);
    if (!isRecord(index) || index.v !== 1 || index.kind !== "index" || !isRecord(index.files)) return;
    for (const file of Object.values(index.files)) {
      if (!isRecord(file)) continue;
      this.mark(file.hash, "file");
      for (const was of Array.isArray(file.was) ? file.was : []) if (isRecord(was)) this.mark(was.hash, "file");
    }
  }

  /**
   * The transcript of a run that ended at `at`, while Settings keep transcripts that old, and through
   * it each call's prompt, while they keep prompts that old. A prompt names the one it builds on,
   * which needs no following: that one is another entry's prompt of the same transcript.
   */
  async transcript(hash: unknown, at: number): Promise<void> {
    if (!isHash(hash) || !this.within(at, this.keep.transcriptDays)) return;
    this.mark(hash, "transcript");
    if (!this.within(at, this.keep.promptDays) || this.transcripts.has(hash)) return;
    this.transcripts.add(hash);
    const text = await this.blobs.get(hash);
    const events: readonly unknown[] = (text === null ? null : transcriptOf(text))?.events ?? [];
    for (const traced of events) {
      const event = isRecord(traced) ? traced.event : null;
      if (isRecord(event) && event.kind === "agent_entry" && isRecord(event.entry)) this.mark(event.entry.prompt, "prompt");
    }
  }

  /** A job's document: its report and the session it would be carried on from, each kept as long as the document is, and its transcript by the keep times, counted from when the job ended. */
  async job(doc: unknown): Promise<void> {
    if (!isRecord(doc) || doc.v !== 1 || doc.kind !== "job") return;
    this.mark(doc.session, "session");
    if (!isRecord(doc.job)) return;
    const { report, transcript, endedAt, startedAt, createdAt } = doc.job;
    this.mark(report, "report");
    const at = [endedAt, startedAt, createdAt].find((time): time is number => typeof time === "number");
    if (at !== undefined) await this.transcript(transcript, at);
  }

  /** A side session's document: its summary, and each turn's words, answer, notes and transcript, the last by the keep times, counted from when the turn ended. */
  async side(doc: unknown): Promise<void> {
    if (!isRecord(doc) || doc.v !== 1 || doc.kind !== "side") return;
    if (isRecord(doc.summary)) this.mark(doc.summary.text, "side");
    for (const turn of Array.isArray(doc.turns) ? doc.turns : []) {
      if (!isRecord(turn)) continue;
      this.mark(turn.asked, "side");
      this.mark(turn.answered, "side");
      this.mark(turn.segment, "segment");
      if (typeof turn.at === "number") await this.transcript(turn.transcript, turn.at);
    }
  }
}

// ---------------------------------------------------------------- upkeep

type Host = Pick<HarnessHost, "blobs" | "store" | "chat" | "clock" | "log">;

/**
 * Why a host can't be swept (or counted, when nothing is to be removed): what it lacks, as the
 * refusal the page shows. Its words are fixed: they go to the user as the request's error, never to
 * a model, and upkeep is given no texts.
 */
function unable(host: Host, removing: boolean): HarnessRefusal {
  const lacks = [
    ...(host.blobs.list ? [] : ["list the texts it has stored"]),
    ...(removing && !host.blobs.remove ? ["remove a stored text"] : []),
    ...(host.store.list ? [] : ["list its documents"]),
    ...(host.chat.anchors ? [] : ["list the records kept on your chats' messages"]),
  ];
  const what = lacks.length > 1 ? `${lacks.slice(0, -1).join(", ")} or ${lacks.at(-1)}` : lacks[0];
  return new HarnessRefusal("unavailable", `What LumiAH has stored can't be ${removing ? "swept" : "counted"} here: the runtime and the extension it is linked to have no way to ${what}. Update both to the same build, then try again.`);
}

/** How big some blobs are together, as stored. */
function bytesOf(blobs: readonly BlobInfo[]): number {
  let bytes = 0;
  for (const blob of blobs) bytes += blob.bytes;
  return bytes;
}

export class Upkeep {
  /** The sweep under way, which whoever asks for one meanwhile is given. */
  private sweeping: Promise<UpkeepSummary> | null = null;
  /** The count under way, likewise. */
  private counting: Promise<UpkeepSummary> | null = null;
  /** The walk under way, a sweep's or a count's: the next starts once it has ended, however it ended, so two never store their findings over each other. */
  private busy: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: {
      host: Host;
      /** The core's blobs: what the walk reads is checked against its hash as everything else read is. */
      blobs: Blobs;
      /** The keep times and the grace time as Settings hold them, read at the start of each sweep. */
      keep(): Settings["keep"];
    },
  ) {}

  /**
   * Removes the blobs that nothing refers to and those Settings no longer keep, but for the ones
   * within the grace time; stores what it found and did, and gives it. One sweep at a time: asked
   * again while one runs, it gives that sweep's promise. Refused as `unavailable` on a host that
   * can't list or remove what is stored. The signal ends it between two steps, with the signal's
   * reason: a blob is removed whole, so whatever it had removed by then was rightly removed, and is
   * on record as what the sweep did.
   */
  sweep(signal: AbortSignal): Promise<UpkeepSummary> {
    if (this.sweeping) return this.sweeping;
    const run = this.after(() => this.pass(signal, true)).finally(() => {
      this.sweeping = null;
    });
    this.sweeping = run;
    return run;
  }

  /**
   * What the last sweep or count found, with whether a sweep is under way now. Where nothing was
   * found yet, it counts (the same walk and listing as a sweep's, removing nothing) and stores that.
   */
  async get(): Promise<UpkeepSummary> {
    const found = await this.found();
    if (found) return found;
    // Counted once whatever is under way has ended, unless that was a sweep, whose findings are the count.
    this.counting ??= this.after(async () => (await this.found()) ?? (await this.pass(null, false))).finally(() => {
      this.counting = null;
    });
    return this.counting;
  }

  // ---------------------------------------------------------------- inside

  /** Runs `walk` once the one under way has ended. */
  private after<T>(walk: () => Promise<T>): Promise<T> {
    const run = this.busy.then(walk);
    this.busy = run.catch(() => undefined);
    return run;
  }

  /** What the last sweep or count found, as stored; null when there is none yet. */
  private async found(): Promise<UpkeepSummary | null> {
    const doc = docOf(await this.deps.host.store.read(DOC.upkeep));
    return doc && { kinds: doc.kinds, total: doc.total, loose: doc.loose, lastSweep: doc.lastSweep, sweeping: this.sweeping !== null };
  }

  /** One walk and one listing: a sweep's (`removing`), or a count's. */
  private async pass(signal: AbortSignal | null, removing: boolean): Promise<UpkeepSummary> {
    const { host } = this.deps;
    const { blobs, store, chat } = host;
    if (!blobs.list || !store.list || !chat.anchors || (removing && !blobs.remove)) throw unable(host, removing);
    const ended = (): void => {
      if (signal?.aborted) throw signal.reason;
    };
    const startedAt = host.clock.now();
    const keep = this.deps.keep();
    const walk = new Walk(this.deps.blobs, startedAt, keep);
    const graceFrom = startedAt - keep.graceHours * HOUR_MS;
    /** What built-in mode left in the store (`LEFTOVER_DOC`): a sweep removes it. */
    const leftovers: string[] = [];

    // Every record on every swipe, listed before anything a record names is read: the listing is over quickly, and holds still while it lasts.
    const held: Held[] = [];
    for (let cursor: string | undefined; ; ) {
      ended();
      const page = await chat.anchors(cursor);
      for (const stored of page.anchors) {
        const record = recordOf(stored.anchor);
        if (record) held.push({ chatId: stored.chatId, messageId: stored.messageId, swipeId: stored.swipeId, record });
      }
      if (page.next === null) break;
      cursor = page.next;
    }
    const spent = await this.spent(held, walk, keep.spanDays, ended);
    for (const { chatId, messageId, swipeId, record } of held) {
      ended();
      if (!spent.get(chatId)?.has(swipeKey(messageId, swipeId))) walk.mark(record.segment, "segment");
      walk.mark(record.summary, "summary");
      for (const segment of record.kept ?? []) walk.mark(segment, "segment");
      for (const job of record.jobs ?? []) walk.mark(job.report, "report");
      await walk.index(record.workspace);
      await walk.transcript(record.transcript, record.at);
    }
    for (const path of await store.list("")) {
      ended();
      if (LEFTOVER_DOC.test(path)) leftovers.push(path);
      else if (AREA_DOC.test(path)) {
        const doc = await store.read(path);
        if (isRecord(doc) && doc.v === 1 && doc.kind === "area") await walk.index(doc.head);
      } else if (SIDE_DOC.test(path)) await walk.side(await store.read(path));
      else if (JOB_DOC.test(path)) await walk.job(await store.read(path));
    }

    // Every blob stored, each under its kind, or loose. Nothing is removed while the listing is read: it has to hold still.
    const kinds = KINDS.map((kind): StoredKind => ({ kind, count: 0, bytes: 0, oldestAt: null, keep: KEPT[kind]?.slice() ?? null }));
    const byKind = new Map(kinds.map((row): [Kind, StoredKind] => [row.kind, row]));
    const loose = { count: 0, bytes: 0 };
    const doomed: BlobInfo[] = [];
    let pageSize = 0;
    for (let cursor: string | undefined; ; ) {
      ended();
      const page = await blobs.list(cursor);
      pageSize = Math.max(pageSize, page.blobs.length);
      for (const blob of page.blobs) {
        // Only what is stored under a hash is a blob: anything else a host lists beside them is none of upkeep's.
        if (!isHash(blob.hash)) continue;
        const kind = walk.live.get(blob.hash);
        const row = kind === undefined ? undefined : byKind.get(kind);
        if (row) {
          row.count += 1;
          row.bytes += blob.bytes;
          row.oldestAt = Math.min(row.oldestAt ?? blob.at, blob.at);
        } else if (removing && blob.at <= graceFrom) doomed.push(blob);
        else {
          loose.count += 1;
          loose.bytes += blob.bytes;
        }
      }
      if (page.next === null) break;
      cursor = page.next;
    }

    // Removed as many at a time as the host listed at a time: one request never names more blobs than one of the host's own answers did.
    let gone = 0;
    let cut: { why: unknown } | null = null;
    try {
      // What built-in mode left goes first, each document whole; what it named is among the blobs that follow.
      for (const path of removing ? leftovers : []) {
        ended();
        await store.remove(path);
      }
      while (blobs.remove && gone < doomed.length) {
        ended();
        const batch = doomed.slice(gone, gone + pageSize);
        await blobs.remove(batch.map((blob) => blob.hash));
        gone += batch.length;
      }
    } catch (why) {
      cut = { why };
    }

    // What a sweep that was cut short didn't get to is still stored, and nothing refers to it.
    const left = doomed.slice(gone);
    const at = host.clock.now();
    const stays = { count: loose.count + left.length, bytes: loose.bytes + bytesOf(left) };
    const total = { count: stays.count + kinds.reduce((n, row) => n + row.count, 0), bytes: stays.bytes + kinds.reduce((n, row) => n + row.bytes, 0) };
    const lastSweep = removing ? { at, removed: gone, bytes: bytesOf(doomed.slice(0, gone)), ms: at - startedAt } : null;
    const findings: UpkeepDoc = { v: 1, kind: "upkeep", kinds, total, loose: { ...stays, at }, lastSweep };
    if (cut) {
      // It ends as it was ended. What it had removed by then is gone all the same, so that much is put on record where it can be; having removed nothing, it leaves the record as it was.
      if (gone > 0) await store.write(DOC.upkeep, findings as unknown as JsonValue).catch(() => undefined);
      host.log("warn", `the sweep ended early (${errorText(cut.why)}), having removed ${gone} of the ${doomed.length} stored texts it was to remove`);
      throw cut.why;
    }
    await store.write(DOC.upkeep, findings as unknown as JsonValue);
    if (removing) host.log("info", `the sweep removed ${gone} stored texts (${lastSweep?.bytes ?? 0} bytes) in ${at - startedAt} ms; ${total.count} are stored now (${total.bytes} bytes), ${stays.count} of them nothing refers to yet`);
    return { kinds, total, loose: findings.loose, lastSweep, sweeping: false };
  }

  /**
   * The records whose own segment nothing reads any more, by chat, each as its swipe's key. On a
   * chat's active path, the latest summary that stands replaced the segments of the records before
   * it, but for those it keeps whole; they are kept so that it can be rolled back, for as long as
   * Summarized turns kept for says, counted from when the summary was made. A record off the path, or
   * on a swipe the chat doesn't show, is no part of this: its segment stays. So does a segment that
   * any other record still holds, in this chat or in another (a branch made before the summary reads
   * the same segments): a blob is live when anything keeps it.
   */
  private async spent(held: readonly Held[], walk: Walk, spanDays: Limit, ended: () => void): Promise<Map<string, Set<string>>> {
    const spent = new Map<string, Set<string>>();
    // Only a chat that holds a standing summary older than the keep time can have such records: no other chat's path is read.
    const chats = new Set(held.filter(({ record }) => record.summary !== undefined && record.rolledBack === undefined && !walk.within(record.at, spanDays)).map(({ chatId }) => chatId));
    for (const chatId of chats) {
      ended();
      const turns = (await pathTurns(await this.deps.host.chat.path(chatId))).filter((turn) => turn.onPath);
      const last = turns.findLastIndex((turn) => turn.record.summary !== undefined && turn.record.rolledBack === undefined);
      const summary = turns[last]?.record;
      if (!summary || walk.within(summary.at, spanDays)) continue;
      const kept = new Set(summary.kept ?? []);
      spent.set(chatId, new Set(turns.slice(0, last).flatMap((turn) => (kept.has(turn.record.segment) ? [] : [swipeKey(turn.messageId, turn.swipeId)]))));
    }
    return spent;
  }
}
