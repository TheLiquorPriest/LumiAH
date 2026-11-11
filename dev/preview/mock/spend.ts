// The stand-in backend's spend and storage (DESIGN §20). Ninety days of made-up model calls, each
// counted under its day, its chat, its agent, its connection and its model, so every way of adding
// them up gives the same total; the caps Settings hold, with what today used of them; what the
// store keeps of each kind; and a sweep that takes two seconds and then leaves less stored.

import type { JsonObject, JsonValue, SettingPath, SpendCap, SpendRow, SpendView, StoredKind, UpkeepView } from "../../../src/shared/ui";
import { type Handlers, MOCK_AGENTS, type MockCtx, Refusal } from "./ctx";

type Requests = "lah.spend.get" | "lah.upkeep.get" | "lah.upkeep.sweep";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** How far back the story's spend goes, in days: before that nothing was spent. */
export const HISTORY_DAYS = 90;

/** The longest period the stand-in answers: it builds a row for each day asked for, so a period without end is refused. */
export const MOST_DAYS = 366;

/** How long the stand-in's sweep takes, in milliseconds: long enough to see the page wait for it. */
export const SWEEP_MS = 2000;

/** A source of numbers from 0 to 1 that gives the same ones each time, so the story's figures are the same at every start. */
function numbers(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A model: the connection it is called on, and its price in US dollars for a million tokens (null: none is known, so its calls have no cost). */
const MODELS: Readonly<Record<string, { connection: string; price: { in: number; cached: number; out: number } | null }>> = {
  "deepseek-v4-pro": { connection: "conn-deepseek", price: { in: 0.55, cached: 0.14, out: 2.19 } },
  "deepseek-v4-flash": { connection: "conn-deepseek", price: { in: 0.14, cached: 0.014, out: 0.28 } },
  "llama-local": { connection: "conn-local", price: null },
};

const CONNECTIONS: Readonly<Record<string, string>> = { "conn-deepseek": "Deepseek", "conn-local": "Local llama" };

/** An agent's work: its share of a day's calls, the model it calls, and the tokens one call of its sends and writes. */
const WORK: Readonly<Record<string, { share: number; model: string; in: number; out: number }>> = {
  main: { share: 0.4, model: "deepseek-v4-pro", in: 9000, out: 500 },
  writer: { share: 0.25, model: "deepseek-v4-pro", in: 12_000, out: 900 },
  summarizer: { share: 0.1, model: "deepseek-v4-flash", in: 6000, out: 400 },
  archivist: { share: 0.1, model: "deepseek-v4-flash", in: 3000, out: 250 },
  reader: { share: 0.1, model: "llama-local", in: 2500, out: 200 },
  cartographer: { share: 0.05, model: "deepseek-v4-flash", in: 2000, out: 300 },
};

/** The agents jobs run as: what they send and write counts toward the jobs' own cap. */
const JOB_AGENTS: Readonly<Record<string, true>> = { archivist: true, reader: true, cartographer: true };

/** A chat: its name where the state has none, its share of a day's calls, and how many days ago it began. */
const CHATS: readonly { id: string; name: string; share: number; since: number }[] = [
  { id: "chat-mara", name: "Mara at the harbour", share: 0.6, since: HISTORY_DAYS },
  { id: "chat-brann", name: "Brann's long watch", share: 0.25, since: HISTORY_DAYS },
  { id: "chat-okoro", name: "Okoro audits", share: 0.15, since: 40 },
];

/** The calls of one agent in one chat on one day, added up. A cost is held in millionths of a dollar, whole, so sums by any key agree to the last place. */
interface Cell {
  /** How many days before today. */
  back: number;
  chat: string;
  agent: string;
  model: string;
  calls: number;
  in: number;
  cachedIn: number;
  out: number;
  micro: number;
  unpriced: number;
}

/** The story's calls: busy days and quiet ones, fewer in its first month, and today the busiest, so a cap is reached. */
function story(): Cell[] {
  const next = numbers(20_261_110);
  const cells: Cell[] = [];
  for (let back = HISTORY_DAYS - 1; back >= 0; back -= 1) {
    const busy = back === 0 ? 1.6 : next() < 0.1 ? 0 : (0.45 + next() * 0.8) * (back > 60 ? 0.6 : 1);
    for (const chat of CHATS) {
      if (back >= chat.since) continue;
      for (const [agent, work] of Object.entries(WORK)) {
        const calls = Math.round(120 * busy * chat.share * work.share * (0.8 + next() * 0.4));
        if (calls === 0) continue;
        const price = MODELS[work.model]?.price ?? null;
        const sent = Math.round(calls * work.in * (0.85 + next() * 0.3));
        const cachedIn = price === null ? 0 : Math.round(sent * (0.6 + next() * 0.25));
        const out = Math.round(calls * work.out * (0.8 + next() * 0.4));
        const micro = price === null ? 0 : Math.round((sent - cachedIn) * price.in + cachedIn * price.cached + out * price.out);
        cells.push({ back, chat: chat.id, agent, model: work.model, calls, in: sent, cachedIn, out, micro, unpriced: price === null ? calls : 0 });
      }
    }
  }
  return cells;
}

interface Tally {
  calls: number;
  in: number;
  cachedIn: number;
  out: number;
  micro: number;
  unpriced: number;
}

const nothing = (): Tally => ({ calls: 0, in: 0, cachedIn: 0, out: 0, micro: 0, unpriced: 0 });

function add(to: Tally, cell: Cell): void {
  to.calls += cell.calls;
  to.in += cell.in;
  to.cachedIn += cell.cachedIn;
  to.out += cell.out;
  to.micro += cell.micro;
  to.unpriced += cell.unpriced;
}

const rowOf = (key: string, label: string, t: Tally): SpendRow => ({ key, label, calls: t.calls, in: t.in, cachedIn: t.cachedIn, out: t.out, cost: t.micro / 1_000_000, unpriced: t.unpriced });

/** The cells added up under a key of each, as rows in the order their keys first came. */
function rowsBy(cells: readonly Cell[], keyOf: (cell: Cell) => string, labelOf: (key: string) => string): SpendRow[] {
  const sums = new Map<string, Tally>();
  for (const cell of cells) {
    const key = keyOf(cell);
    const sum = sums.get(key) ?? nothing();
    sums.set(key, sum);
    add(sum, cell);
  }
  return [...sums].map(([key, sum]) => rowOf(key, labelOf(key), sum));
}

/** A moment's calendar day, as a day's row is keyed: "2026-11-10". */
const dayKey = (at: number): string => new Date(at).toISOString().slice(0, 10);

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** A setting as the preview holds it: whether its schema has it at all (the made-up settings have none of LumiAH's own), and its value. */
function settingAt(ctx: MockCtx, path: SettingPath): { there: boolean; value: JsonValue | undefined } {
  const settings = ctx.state().settings;
  let schema: JsonValue | undefined = settings.schema;
  let value: JsonValue | undefined = settings.values;
  for (const key of path) {
    schema = isObject(schema) && isObject(schema.properties) ? schema.properties[key] : undefined;
    value = isObject(value) ? value[key] : undefined;
  }
  return { there: isObject(schema), value };
}

/** A limit a setting holds: its number, or null for none; where the preview has no such setting, the story's own. */
function limitAt(ctx: MockCtx, path: SettingPath, told: number | null): number | null {
  const setting = settingAt(ctx, path);
  if (!setting.there) return told;
  return typeof setting.value === "number" ? setting.value : null;
}

/** A cap of the story: its setting, what it bounds, and the limit the story's user set. */
const CAPS: readonly { path: SettingPath; label: string; unit: SpendCap["unit"]; limit: number; used: "tokens" | "cost" | "jobTokens" }[] = [
  { path: ["core", "spend", "tokensPerDay"], label: "Tokens every agent may send and write in any 24 hours", unit: "tokens", limit: 2_000_000, used: "tokens" },
  { path: ["core", "spend", "costPerDay"], label: "What every agent's calls may cost in any 24 hours", unit: "usd", limit: 0.5, used: "cost" },
  { path: ["core", "jobs", "tokensPerDay"], label: "Tokens all jobs may send and write in any 24 hours", unit: "tokens", limit: 400_000, used: "jobTokens" },
];

/** A kind of thing stored, as the story has it: how many, how big, the setting that says how long it is kept (null: as long as something refers to it) with the story's own time in days, and how many days ago its oldest was stored. */
interface Stock {
  kind: string;
  label: string;
  count: number;
  bytes: number;
  keep: { path: SettingPath; days: number | null } | null;
  oldestAt: number | null;
}

const STOCK: readonly (Omit<Stock, "oldestAt"> & { oldestDays: number })[] = [
  { kind: "prompt", label: "Prompts", count: 3812, bytes: 64_300_000, keep: { path: ["core", "keep", "promptDays"], days: 30 }, oldestDays: 41 },
  { kind: "transcript", label: "Transcripts", count: 486, bytes: 10_070_000, keep: { path: ["core", "keep", "transcriptDays"], days: 90 }, oldestDays: 97 },
  { kind: "segment", label: "Turns that summaries replaced", count: 64, bytes: 1_990_000, keep: { path: ["core", "keep", "spanDays"], days: null }, oldestDays: 88 },
  { kind: "file", label: "Workspace file versions", count: 931, bytes: 4_610_000, keep: null, oldestDays: 90 },
  { kind: "report", label: "Job reports", count: 73, bytes: 397_000, keep: null, oldestDays: 52 },
];

export function spendMock(ctx: MockCtx): Handlers<Requests> {
  const cells = ctx.ready ? story() : [];
  const born = ctx.now();
  const stock: Stock[] = STOCK.map(({ oldestDays, ...kind }) => (ctx.ready ? { ...kind, oldestAt: born - oldestDays * DAY_MS - 5 * HOUR_MS } : { ...kind, count: 0, bytes: 0, oldestAt: null }));
  let loose: UpkeepView["loose"] = ctx.ready ? { count: 23, bytes: 655_000, at: born - 26 * HOUR_MS } : null;
  let lastSweep: UpkeepView["lastSweep"] = ctx.ready ? { at: born - 26 * HOUR_MS, removed: 318, bytes: 5_450_000, ms: 1840 } : null;
  let sweeping = false;

  if (ctx.ready) {
    // The story's user has set caps. They are written to the preview's settings once its state is
    // there, so the setting a cap leads to holds the limit the Spend page shows; a limit set since
    // is left as it is.
    ctx.later(() => {
      const set = CAPS.filter((cap) => {
        const setting = settingAt(ctx, cap.path);
        return setting.there && setting.value === null;
      }).map((cap) => ({ path: cap.path, value: cap.limit }));
      if (set.length === 0) return;
      try {
        ctx.settings(set, []);
      } catch {
        // Settings that refuse the story's limits keep their own: the caps then show with no limit, which is true of them.
      }
    }, 0);
  }

  const chatName = (id: string): string =>
    ctx
      .state()
      .chats.find((c) => c.chatId === id)
      ?.name?.trim() ||
    CHATS.find((c) => c.id === id)?.name ||
    id;

  const spend = (days: number): SpendView => {
    const now = ctx.now();
    const within = cells.filter((cell) => cell.back < days);
    const byDay = new Map(rowsBy(within, (c) => String(c.back), (key) => key).map((row): [string, SpendRow] => [row.key, row]));
    const dayRows: SpendRow[] = [];
    for (let back = days - 1; back >= 0; back -= 1) {
      const key = dayKey(now - back * DAY_MS);
      const row = byDay.get(String(back));
      dayRows.push(row ? { ...row, key, label: key } : rowOf(key, key, nothing()));
    }
    const total = nothing();
    for (const cell of within) add(total, cell);
    // What a cap counts is the last 24 hours: here, today's calls.
    const today = nothing();
    const jobs = nothing();
    for (const cell of cells) {
      if (cell.back !== 0) continue;
      add(today, cell);
      if (JOB_AGENTS[cell.agent]) add(jobs, cell);
    }
    const used = { tokens: today.in + today.out, cost: today.micro / 1_000_000, jobTokens: jobs.in + jobs.out };
    return {
      days: dayRows,
      chats: rowsBy(within, (c) => c.chat, chatName),
      agents: rowsBy(within, (c) => c.agent, (id) => MOCK_AGENTS.find((a) => a.id === id)?.name ?? id),
      connections: rowsBy(within, (c) => MODELS[c.model]?.connection ?? "", (id) => CONNECTIONS[id] ?? id),
      models: rowsBy(within, (c) => c.model, (id) => id),
      total: rowOf("total", `The last ${days} days`, total),
      caps: CAPS.map((cap): SpendCap => {
        const limit = limitAt(ctx, cap.path, cap.limit);
        const spent = used[cap.used];
        return { path: [...cap.path], label: cap.label, unit: cap.unit, limit, used: spent, reached: limit !== null && spent >= limit };
      }),
    };
  };

  const keptDays = (kind: Stock): number | null => (kind.keep === null ? null : limitAt(ctx, kind.keep.path, kind.keep.days));

  const upkeep = (): UpkeepView => {
    const kinds = stock.map((kind): StoredKind => {
      const days = keptDays(kind);
      return { kind: kind.kind, label: kind.label, count: kind.count, bytes: kind.bytes, kept: kind.keep === null ? null : { path: [...kind.keep.path], words: days === null ? "No limit" : `${days} ${days === 1 ? "day" : "days"}` }, oldestAt: kind.oldestAt };
    });
    return { kinds, total: { count: stock.reduce((n, k) => n + k.count, 0), bytes: stock.reduce((n, k) => n + k.bytes, 0) }, loose: loose ? { ...loose } : null, lastSweep: lastSweep ? { ...lastSweep } : null, sweeping };
  };

  /** Removes what Settings no longer keep (of a kind kept for a time, the share older than that time, as if it had been stored evenly since its oldest) and the blobs nothing refers to. */
  const sweep = (): void => {
    const now = ctx.now();
    let removed = loose?.count ?? 0;
    let bytes = loose?.bytes ?? 0;
    for (const kind of stock) {
      const days = keptDays(kind);
      if (days === null || kind.oldestAt === null) continue;
      const from = now - days * DAY_MS;
      if (kind.oldestAt >= from) continue;
      const share = Math.min(1, (from - kind.oldestAt) / (now - kind.oldestAt));
      const gone = Math.round(kind.count * share);
      if (gone === 0) continue;
      const freed = Math.round(kind.bytes * (gone / kind.count));
      kind.count -= gone;
      kind.bytes -= freed;
      kind.oldestAt = kind.count > 0 ? from : null;
      removed += gone;
      bytes += freed;
    }
    loose = { count: 0, bytes: 0, at: now };
    lastSweep = { at: now, removed, bytes, ms: SWEEP_MS };
  };

  return {
    "lah.spend.get": (r) => {
      if (r.days > MOST_DAYS) throw new Refusal("invalid", `Ask for at most ${MOST_DAYS} days of spend.`, [{ path: ["days"], message: `At most ${MOST_DAYS}.` }]);
      return spend(r.days);
    },
    "lah.upkeep.get": () => upkeep(),
    "lah.upkeep.sweep": () => {
      if (sweeping) throw new Refusal("conflict", "A sweep is already running. Wait for it to end: the Storage page shows what it removed.");
      sweeping = true;
      return new Promise<UpkeepView>((resolve) => {
        ctx.later(() => {
          sweep();
          sweeping = false;
          resolve(upkeep());
        }, SWEEP_MS);
      });
    },
  };
}
