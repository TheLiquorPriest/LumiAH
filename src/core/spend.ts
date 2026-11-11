// Spend (DESIGN §20): every model call on record with what it spent, and the caps Settings put on a
// day's spend.
//
// A call is counted the moment it is added, in memory, so a cap holds from one call to the next
// within a run. It is written when its run ends (`flush`), to the document of the UTC hour it was
// made in: an hour's document is small, so adding to it is a read and a write of little, and the
// page's view of a day reads 24 of them at most.
//
// The caps count a rolling 24 hours: what was added since the process started and, once the last
// day's documents were read (`ready`), what earlier runs of the process spent. A cap that is reached
// refuses the next call, in words that name its setting.
//
// One process writes these documents (paths.ts), and everything this file does with the store goes
// one piece at a time, so a call is never written twice and never read both from its document and
// from memory. That holds for a write that fails, too: it may have landed all the same, its answer
// lost on the way back, and the next read of its document tells which.

import { DOC } from "./paths";
import type { HarnessHost, JsonValue, RunKind } from "./ports";
import { isRecord } from "./ports";
import { AgentStop } from "./provider";
import { HarnessRefusal } from "./refusal";
import type { Settings } from "./settings";
import { TEXT, type Texts } from "./texts";
import { countedIn } from "./usage";
import { errorText, jsonEqual, type Limit } from "./util";

// ---------------------------------------------------------------- what is stored

/**
 * One model call: when it was made, the run it belongs to (the trace's `turn` id) and what kind of
 * run that is, its chat (`""` for none), the job or the side session where it is one's, the agent
 * definition it ran as (`agent`) and the agent's id in the run, the connection and the model it ran
 * on, its tokens, its cost in US dollars where that is known, and whether any of its counts is an
 * estimate.
 */
export interface SpendRecord {
  at: number;
  run: string;
  kind: RunKind;
  chatId: string;
  job?: string;
  side?: string;
  agent: string;
  agentId: string;
  connection: string;
  model: string;
  in: number;
  cachedIn: number;
  out: number;
  reasoningOut: number;
  cost?: number;
  estimated: boolean;
}

/**
 * One UTC hour's calls as stored (`DOC.spend`), in the order they were made. `Call` is what a call
 * is known to be: a record once it was read (`callOf`), and anything at all before that, which is
 * how a document's calls are carried over when more are added to it.
 */
interface SpendDoc<Call = SpendRecord> {
  v: 1;
  kind: "spend";
  calls: Call[];
}

const RUN_KINDS: readonly RunKind[] = ["new", "regenerate", "swipe", "continue", "job", "side"];

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** A stored hour's calls as its document holds them, each still to be read (`callOf`); none for a document that isn't one. */
function callsOf(doc: unknown): unknown[] {
  return isRecord(doc) && doc.v === 1 && doc.kind === "spend" && Array.isArray(doc.calls) ? doc.calls : [];
}

/**
 * A call as its document holds one, read; null for anything that isn't one. What `add` is given is
 * read the same way, so a call is held in memory exactly as it will be stored.
 */
function callOf(raw: unknown): SpendRecord | null {
  if (!isRecord(raw)) return null;
  const { at, run, kind, chatId, agent, agentId, connection, model, cachedIn, out, reasoningOut } = raw;
  if (typeof at !== "number" || !Number.isFinite(at) || typeof run !== "string" || typeof kind !== "string" || !(RUN_KINDS as readonly string[]).includes(kind) || typeof chatId !== "string") return null;
  if (typeof agent !== "string" || typeof agentId !== "string" || typeof connection !== "string" || typeof model !== "string") return null;
  if (!isCount(raw.in) || !isCount(cachedIn) || !isCount(out) || !isCount(reasoningOut)) return null;
  return {
    at,
    run,
    kind: kind as RunKind,
    chatId,
    ...(typeof raw.job === "string" ? { job: raw.job } : {}),
    ...(typeof raw.side === "string" ? { side: raw.side } : {}),
    agent,
    agentId,
    connection,
    model,
    in: raw.in,
    cachedIn,
    out,
    reasoningOut,
    ...(isCount(raw.cost) ? { cost: raw.cost } : {}),
    estimated: raw.estimated === true,
  };
}

// ---------------------------------------------------------------- hours and days

/** An hour. Not a setting: the documents are one per UTC hour (`DOC.spend`), which is a stored format. */
const HOUR_MS = 3_600_000;

/**
 * The caps' window. Not a setting: the caps are set per day (Tokens per day, Cost per day, Job
 * tokens per day), and a day that rolls with the clock has no time zone and no midnight, so nothing
 * spent is forgotten all at once and no user's day starts at another's.
 */
const DAY_MS = 24 * HOUR_MS;

/**
 * The most days one `get` reads. Not a setting: it bounds what a single request, whoever sends it,
 * can make the core read and build, and a bound that could be set would need a bound of its own.
 * A year, a leap year's day included.
 */
const MOST_DAYS = 366;

/** The start of the UTC hour or day (`unit`) that `at` falls in. */
function startOf(at: number, unit: number): number {
  return Math.floor(at / unit) * unit;
}

/** A time's UTC day, as `2026-05-01`. */
function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Where the calls of the UTC hour starting at `hour` are kept. */
function hourPath(hour: number): string {
  return DOC.spend(dayOf(hour), new Date(hour).toISOString().slice(11, 13));
}

// ---------------------------------------------------------------- what the page reads

/** Spend under one key (a day, a chat, an agent definition, a connection, a model): its calls, their tokens, their cost where it is known, and how many calls' cost isn't (`unpriced`). */
export interface SpendRow {
  key: string;
  calls: number;
  in: number;
  cachedIn: number;
  out: number;
  cost: number;
  unpriced: number;
}

/**
 * A cap: the setting that holds it, by its path; what it counts; its limit (null: none set); what
 * the last 24 hours used of it as the cap counts it (for tokens: a cached re-read at its weight);
 * and whether it is reached, so the next call it bounds is refused. `sent`, for a cap on tokens:
 * the tokens truly sent and written in those 24 hours, every one counted in full.
 */
export interface SpendCap {
  setting: string[];
  unit: "tokens" | "usd";
  limit: number | null;
  used: number;
  sent?: number;
  reached: boolean;
}

/**
 * Spend over the UTC days asked for: each day by its date (oldest first, a day with no call
 * included), the same calls by chat, agent definition, connection and model (each the largest cost
 * first, then the most tokens), their total, and the three caps as they stand now.
 */
export interface SpendSummary {
  days: SpendRow[];
  chats: SpendRow[];
  agents: SpendRow[];
  connections: SpendRow[];
  models: SpendRow[];
  total: SpendRow;
  caps: SpendCap[];
}

const rowOf = (key: string): SpendRow => ({ key, calls: 0, in: 0, cachedIn: 0, out: 0, cost: 0, unpriced: 0 });

/** The row under `key`, made when a first call falls under it. */
function rowIn(rows: Map<string, SpendRow>, key: string): SpendRow {
  let row = rows.get(key);
  if (!row) rows.set(key, (row = rowOf(key)));
  return row;
}

/** The largest cost first, then the most tokens; the key settles the rest, so the order never depends on the order the calls were read in. */
function bySpend(a: SpendRow, b: SpendRow): number {
  return b.cost - a.cost || b.in + b.out - (a.in + a.out) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// ---------------------------------------------------------------- the caps

/** Whether a cap is reached: what was used is at or past a limit that is set. No limit is never reached. */
function reached(limit: Limit, used: number): limit is number {
  return limit !== null && used >= limit;
}

/**
 * An amount in US dollars as a cap's reason writes it: its cents, and up to two digits more where
 * it has them ("5.00", "0.0125"). Not a setting: it is how an amount reads, and one call's cost is
 * often a fraction of a cent.
 */
function dollars(amount: number): string {
  return amount.toFixed(4).replace(/(\.\d\d\d*?)0+$/, "$1");
}

/** What the last 24 hours spent, as the caps count it: every call's tokens sent and written (a prompt token read again from a provider's cache at Settings' weight), every call's known cost, and the tokens of the jobs' calls; and the same tokens counted in full (`sent`, `jobSent`), for the page. */
interface Used {
  tokens: number;
  cost: number;
  jobTokens: number;
  sent: number;
  jobSent: number;
}

// ---------------------------------------------------------------- spend

export class Spend {
  /** The caps' window: the calls of the last 24 hours, those of earlier runs of the process among them once `ready` has read them. */
  private window: SpendRecord[] = [];
  /** The calls added that no flush has written yet, in the order they were made. */
  private pending: SpendRecord[] = [];
  /** The last day's documents were read into the window. */
  private loaded = false;
  /** The calls under way, each with what it holds against the caps until it is on the record (`hold`): its prompt as estimated, that prompt's cost where its model has a price, and whether it is a job's. */
  private readonly held = new Set<{ job: boolean; tokens: number; cost: number }>();
  /**
   * How many calls this process has appended to each hour's document while the last day's documents
   * were still unread, by the hour's start. They are that document's tail, and the window holds them
   * already: when the documents are read, they are left out.
   */
  private readonly own = new Map<number, number>();
  /**
   * For an hour whose write failed: how many calls its document held before, and the calls that
   * write added to it. Whoever reads the document next can tell whether the write landed: it then
   * holds what it held before and, after it, exactly these.
   */
  private readonly unsure = new Map<number, { had: number; calls: SpendRecord[] }>();
  /** The store's work under way: one piece at a time, in the order it was asked. */
  private last: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: Pick<HarnessHost, "store" | "clock" | "log">,
    /** The caps as Settings hold them, read each time so a change takes effect on the next call. */
    private readonly settings: () => Pick<Settings, "spend" | "jobs">,
  ) {}

  /** A call that came back: counted at once (the caps read it from memory), written at the next `flush`. */
  add(record: SpendRecord): void {
    // Kept as its document will hold it, so a call counts the same whether it is read from memory or from the store.
    const call = callOf(record);
    if (!call) {
      this.host.log("warn", `a model call's spend wasn't recorded: what was given isn't a call's record (run ${String(record.run)}, at ${String(record.at)})`);
      return;
    }
    const from = this.host.clock.now() - DAY_MS;
    // Calls are added about in the order they were made: once the oldest held has left the window, it is time to let go of all that have.
    const oldest = this.window[0];
    if (oldest && oldest.at <= from) this.window = this.window.filter((held) => held.at > from);
    this.window.push(call);
    this.pending.push(call);
  }

  /**
   * Writes what was added since the last flush, each call to the document of the hour it was made
   * in, after the calls already there. One flush at a time. Never rejects: calls whose document
   * couldn't be read or written are kept for the next flush, and the log says so.
   */
  flush(): Promise<void> {
    return this.queued(async () => {
      if (this.pending.length === 0) return;
      await this.load();
      // What is added while this flush writes waits for the next one.
      const batch = this.pending;
      this.pending = [];
      const hours = new Map<number, SpendRecord[]>();
      for (const call of batch) {
        const hour = startOf(call.at, HOUR_MS);
        const calls = hours.get(hour);
        if (calls) calls.push(call);
        else hours.set(hour, [call]);
      }
      let unwritten: SpendRecord[] = [];
      for (const [hour, calls] of hours) unwritten = unwritten.concat(await this.append(hour, calls));
      // Back in front of whatever was added meanwhile, so each hour's calls stay in the order they were made.
      if (unwritten.length > 0) this.pending = unwritten.concat(this.pending);
    });
  }

  /**
   * Reads the last 24 hours' documents, once, so the caps count what earlier runs of the process
   * spent; until then `refusal` counts only what was added since the process started. Never rejects:
   * a read that fails is said in the log, and tried again by the next `ready`, `flush` or `get`.
   */
  ready(): Promise<void> {
    return this.loaded ? Promise.resolve() : this.queued(() => this.load());
  }

  /**
   * The cap the next call may not pass, as the stop its agent ends with; null when the call may be
   * made. Over the last 24 hours: every call's tokens sent and written at or past Tokens per day;
   * every call's known cost at or past Cost per day; and, for a job's call, the jobs' calls' tokens
   * at or past Job tokens per day. And a cap not yet reached is asked about the call itself: with
   * its prompt as estimated (`tokens`, and `cost` where its model has a price) and what the calls
   * under way hold (`hold`), it may not pass the cap either, so one large call, or several agents
   * at once, never take a day's spend past it unseen. A prompt token read again from a provider's
   * cache counts at Settings' weight, and the stop says so; a prompt not yet sent counts in full.
   * `texts`: the run's, which write a count with its noun.
   */
  refusal(call: { job: boolean; texts: Texts; tokens?: number; cost?: number }): AgentStop | null {
    const { spend, jobs } = this.settings();
    const used = this.used(this.host.clock.now());
    const { texts } = call;
    const weight = String(spend.cachedWeight);
    const own = { tokens: call.tokens ?? 0, cost: call.cost ?? 0, jobTokens: call.job ? (call.tokens ?? 0) : 0 };
    for (const under of this.held) {
      own.tokens += under.tokens;
      own.cost += under.cost;
      if (under.job) own.jobTokens += under.tokens;
    }
    /** Whether the call, with those under way, would take what was spent past a limit that is set. */
    const passes = (limit: Limit, spent: number, more: number): limit is number => limit !== null && spent + more > limit;
    if (reached(spend.tokensPerDay, used.tokens)) return new AgentStop("spend", { id: TEXT.spend.stopTokens, vars: { tokens: texts.counted(used.tokens, TEXT.word.token), limit: String(spend.tokensPerDay), weight } });
    if (passes(spend.tokensPerDay, used.tokens, own.tokens)) return new AgentStop("spend", { id: TEXT.spend.stopTokensCall, vars: { counted: texts.counted(used.tokens + own.tokens, TEXT.word.token), limit: String(spend.tokensPerDay), weight } });
    if (reached(spend.costPerDay, used.cost)) return new AgentStop("spend", { id: TEXT.spend.stopCost, vars: { cost: dollars(used.cost), limit: dollars(spend.costPerDay) } });
    if (passes(spend.costPerDay, used.cost, own.cost)) return new AgentStop("spend", { id: TEXT.spend.stopCostCall, vars: { cost: dollars(used.cost + own.cost), limit: dollars(spend.costPerDay) } });
    if (call.job && reached(jobs.tokensPerDay, used.jobTokens)) return new AgentStop("spend", { id: TEXT.jobs.stopJobTokens, vars: { tokens: texts.counted(used.jobTokens, TEXT.word.token), limit: String(jobs.tokensPerDay), weight } });
    if (call.job && passes(jobs.tokensPerDay, used.jobTokens, own.jobTokens)) return new AgentStop("spend", { id: TEXT.jobs.stopJobTokensCall, vars: { counted: texts.counted(used.jobTokens + own.jobTokens, TEXT.word.token), limit: String(jobs.tokensPerDay), weight } });
    return null;
  }

  /**
   * A call about to be made holds its estimate against the caps while it is under way: `refusal`
   * counts it for every call asked about meanwhile. Whoever makes the call lets go (the function
   * given) once the call is on the record, answered or not; letting go twice does nothing more.
   */
  hold(call: { job: boolean; tokens: number; cost: number }): () => void {
    const under = { job: call.job, tokens: call.tokens, cost: call.cost };
    this.held.add(under);
    return () => void this.held.delete(under);
  }

  /**
   * The calls of the last `days` UTC days, today among them: what the store holds of them and what
   * no flush has written yet, summed by day, chat, agent definition, connection and model, with the
   * caps as they stand. Refused as a bad request for anything but a whole number of days from 1 to
   * `MOST_DAYS`.
   */
  async get(input: { days: number }): Promise<SpendSummary> {
    // The page's request reaches here as it was sent, so what it holds is read before it is used.
    const days: unknown = isRecord(input) ? input.days : undefined;
    // Its words are fixed: they go to the page as the request's error, never to a model, and `Spend` is given no texts.
    if (typeof days !== "number" || !Number.isSafeInteger(days) || days < 1 || days > MOST_DAYS) throw new HarnessRefusal("bad_request", `Spend is shown for a whole number of days, from 1 to ${MOST_DAYS}. Ask for a number of days in that range.`);
    return this.queued(async () => {
      await this.load();
      const now = this.host.clock.now();
      const today = startOf(now, DAY_MS);
      const from = today - (days - 1) * DAY_MS;
      const byDay = new Map<string, SpendRow>();
      for (let day = from; day <= today; day += DAY_MS) byDay.set(dayOf(day), rowOf(dayOf(day)));
      const total = rowOf("total");
      const chats = new Map<string, SpendRow>();
      const agents = new Map<string, SpendRow>();
      const connections = new Map<string, SpendRow>();
      const models = new Map<string, SpendRow>();
      const count = (call: SpendRecord, day: SpendRow): void => {
        for (const row of [day, total, rowIn(chats, call.chatId), rowIn(agents, call.agent), rowIn(connections, call.connection), rowIn(models, call.model)]) {
          row.calls += 1;
          row.in += call.in;
          row.cachedIn += call.cachedIn;
          row.out += call.out;
          if (call.cost === undefined) row.unpriced += 1;
          else row.cost += call.cost;
        }
      };
      // A stored call is its document's day's, whatever time it holds: the document is the hour it was filed under.
      const written = new Set<SpendRecord>();
      for await (const { hour, calls } of this.stored(from, now)) {
        for (const call of this.landed(hour, calls)) written.add(call);
        const day = byDay.get(dayOf(hour));
        if (!day) continue;
        for (const raw of calls) {
          const call = callOf(raw);
          if (call) count(call, day);
        }
      }
      // What no flush has written yet, but for the calls a document turned out to hold already: those were counted from it.
      for (const call of this.pending) {
        const day = written.has(call) || call.at < from ? undefined : byDay.get(dayOf(call.at));
        if (day) count(call, day);
      }
      const { spend, jobs } = this.settings();
      const used = this.used(now);
      const cap = (setting: string[], unit: SpendCap["unit"], limit: Limit, spent: number, sent?: number): SpendCap => ({ setting, unit, limit, used: spent, ...(sent !== undefined ? { sent } : {}), reached: reached(limit, spent) });
      return {
        days: [...byDay.values()],
        chats: [...chats.values()].sort(bySpend),
        agents: [...agents.values()].sort(bySpend),
        connections: [...connections.values()].sort(bySpend),
        models: [...models.values()].sort(bySpend),
        total,
        caps: [cap(["spend", "tokensPerDay"], "tokens", spend.tokensPerDay, used.tokens, used.sent), cap(["spend", "costPerDay"], "usd", spend.costPerDay, used.cost), cap(["jobs", "tokensPerDay"], "tokens", jobs.tokensPerDay, used.jobTokens, used.jobSent)],
      };
    });
  }

  // ---------------------------------------------------------------- inside

  /** Runs `work` once everything asked of the store before it is done, whether that went well or not. */
  private queued<T>(work: () => Promise<T>): Promise<T> {
    const run = this.last.then(work);
    this.last = run.catch(() => undefined);
    return run;
  }

  /**
   * Adds `calls` to the end of their hour's document: read, added to, written. It gives the calls
   * the document isn't known to hold afterwards, which are kept for the next flush: all of them
   * when the document couldn't be read, and those of a write that failed.
   */
  private async append(hour: number, calls: SpendRecord[]): Promise<SpendRecord[]> {
    // While the last day's documents are unread, what this process puts in a document is counted, so that reading them later leaves it out.
    const mine = (count: number): void => {
      if (!this.loaded) this.own.set(hour, (this.own.get(hour) ?? 0) + count);
    };
    let left = calls;
    try {
      const path = hourPath(hour);
      const held = callsOf(await this.host.store.read(path));
      const landed = new Set(this.landed(hour, held));
      this.unsure.delete(hour);
      mine(landed.size);
      left = calls.filter((call) => !landed.has(call));
      if (left.length === 0) return left;
      this.unsure.set(hour, { had: held.length, calls: left });
      // What the document already holds stays as it is, whether this build can read each of its calls or not.
      const doc: SpendDoc<unknown> = { v: 1, kind: "spend", calls: [...held, ...left] };
      await this.host.store.write(path, doc as unknown as JsonValue);
      this.unsure.delete(hour);
      mine(left.length);
      return [];
    } catch (error) {
      this.host.log("warn", `an hour's spend couldn't be written (${errorText(error)}); its new calls (${left.length}) are kept in memory and written at the next flush`);
      return left;
    }
  }

  /**
   * The calls kept for the next flush that an hour's document, as just read (`held`), turns out to
   * hold already: those of a write that failed and landed all the same.
   */
  private landed(hour: number, held: readonly unknown[]): SpendRecord[] {
    const tried = this.unsure.get(hour);
    return tried && held.length === tried.had + tried.calls.length && jsonEqual(held.slice(tried.had).map(callOf), tried.calls) ? tried.calls : [];
  }

  /** What the window's calls of the 24 hours before `now` spent. */
  private used(now: number): Used {
    const from = now - DAY_MS;
    const { cachedWeight } = this.settings().spend;
    const used: Used = { tokens: 0, cost: 0, jobTokens: 0, sent: 0, jobSent: 0 };
    for (const call of this.window) {
      if (call.at <= from) continue;
      const tokens = countedIn(call, cachedWeight) + call.out;
      const sent = call.in + call.out;
      used.tokens += tokens;
      used.sent += sent;
      used.cost += call.cost ?? 0;
      if (call.job !== undefined) {
        used.jobTokens += tokens;
        used.jobSent += sent;
      }
    }
    return used;
  }

  /** Reads the last day's documents into the window, unless that was done. A read that fails leaves it for the next try, and the log says what the caps count meanwhile. */
  private async load(): Promise<void> {
    if (this.loaded) return;
    const now = this.host.clock.now();
    const from = now - DAY_MS;
    try {
      const earlier: SpendRecord[] = [];
      for await (const { hour, calls } of this.stored(from, now)) {
        // What this process put in the document itself is its end, and the window holds it already.
        const mine = (this.own.get(hour) ?? 0) + this.landed(hour, calls).length;
        for (const raw of calls.slice(0, Math.max(0, calls.length - mine))) {
          const call = callOf(raw);
          if (call && call.at > from) earlier.push(call);
        }
      }
      this.window = earlier.concat(this.window);
      this.own.clear();
      this.loaded = true;
    } catch (error) {
      this.host.log("warn", `the last day's spend couldn't be read (${errorText(error)}): until it can, the spend caps count only what was spent since the runtime started`);
    }
  }

  /**
   * What the store holds for each UTC hour from the one `from` falls in to the one `to` falls in,
   * oldest first: each hour's calls as its document holds them. A day's documents are read at once,
   * so a long span never has more reads under way than a day has hours.
   */
  private async *stored(from: number, to: number): AsyncGenerator<{ hour: number; calls: unknown[] }> {
    const first = startOf(from, HOUR_MS);
    for (let day = startOf(from, DAY_MS); day <= to; day += DAY_MS) {
      const hours: number[] = [];
      for (let hour = Math.max(day, first); hour < day + DAY_MS && hour <= to; hour += HOUR_MS) hours.push(hour);
      yield* await Promise.all(hours.map(async (hour) => ({ hour, calls: callsOf(await this.host.store.read(hourPath(hour))) })));
    }
  }
}
