// Spend (DESIGN §20) on an in-memory host: each model call written once to the document of the hour
// it was made in, the caps counting a rolling 24 hours across runs of the process, each cap refusing
// in words that name its setting, and the page's view of spend by day, chat, agent, connection and
// model.

import { describe, expect, test } from "bun:test";
import { DOC } from "../../src/core/paths";
import { isRecord } from "../../src/core/ports";
import { AgentStop } from "../../src/core/provider";
import { HarnessRefusal } from "../../src/core/refusal";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { Spend, type SpendRecord, type SpendRow } from "../../src/core/spend";
import { Texts } from "../../src/core/texts";
import { MemoryHost } from "./support/host";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A host whose clock stands at ten to eight in the morning, UTC, on the first of May 2026; the settings a test changes; and a `Spend` over them. */
function rig(change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  host.clock.t = Date.UTC(2026, 4, 1, 7, 50);
  const settings = defaultSettings();
  change(settings);
  const spend = new Spend(host, () => settings);
  /** A call of the main agent's made now: 900 tokens sent, 100 written, a quarter of a dollar. */
  const call = (fields: Partial<SpendRecord> = {}): SpendRecord => ({ at: host.clock.now(), run: "gen-1", kind: "new", chatId: "chat-1", agent: "main", agentId: "agent_1", connection: "conn-main", model: "model-main", in: 900, cachedIn: 0, out: 100, reasoningOut: 0, cost: 0.25, estimated: false, ...fields });
  /** Adds calls made now, and gives them. */
  const add = (...calls: Partial<SpendRecord>[]): SpendRecord[] => {
    const made = calls.map(call);
    for (const record of made) spend.add(record);
    return made;
  };
  /** The calls an hour's document holds, as the store has them; none where there is no such document. */
  const calls = (day: string, hour: string): unknown[] => {
    const doc = host.documents.get(DOC.spend(day, hour));
    return isRecord(doc) && Array.isArray(doc.calls) ? doc.calls : [];
  };
  return { host, settings, spend, call, add, calls };
}

const texts = new Texts();
const turn = { job: false, texts };
const job = { job: true, texts };

describe("each model call is written", () => {
  test("once, to the document of the UTC hour it was made in, across flushes and an hour's end", async () => {
    const r = rig();
    const early = r.add({ agentId: "agent_1" });
    r.host.clock.advance(5 * MINUTE);
    early.push(...r.add({ agentId: "agent_2", cost: undefined, estimated: true }));
    // Nothing is written until the run ends.
    expect(r.host.documents.size).toBe(0);
    await r.spend.flush();
    expect(DOC.spend("2026-05-01", "07")).toBe("spend/2026-05-01/07.json");
    expect(r.host.documents.get("spend/2026-05-01/07.json")).toMatchObject({ v: 1, kind: "spend" });
    expect(r.calls("2026-05-01", "07")).toEqual(early);
    // A call whose cost isn't known is stored without one.
    expect(r.calls("2026-05-01", "07")[1]).not.toHaveProperty("cost");

    // A run that goes on past the hour: its calls before the hour's end join that hour's document, the ones after start the next.
    r.host.clock.advance(4 * MINUTE);
    early.push(...r.add({ run: "gen-2" }));
    r.host.clock.advance(6 * MINUTE);
    const late = r.add({ run: "gen-2" });
    await r.spend.flush();
    expect(r.calls("2026-05-01", "07")).toEqual(early);
    expect(r.calls("2026-05-01", "08")).toEqual(late);

    // Nothing new, nothing written; and two flushes asked for at once write a call once.
    await r.spend.flush();
    late.push(...r.add({ run: "gen-3" }));
    await Promise.all([r.spend.flush(), r.spend.flush()]);
    expect(r.calls("2026-05-01", "07")).toEqual(early);
    expect(r.calls("2026-05-01", "08")).toEqual(late);
    expect([...r.host.documents.keys()].sort()).toEqual(["spend/2026-05-01/07.json", "spend/2026-05-01/08.json"]);
  });

  test("on the UTC day it was made, whatever day that is where the user lives", async () => {
    const r = rig();
    r.host.clock.t = Date.UTC(2026, 11, 31, 23, 59, 59);
    r.add({});
    r.host.clock.advance(1000);
    r.add({});
    await r.spend.flush();
    expect([...r.host.documents.keys()].sort()).toEqual(["spend/2026-12-31/23.json", "spend/2027-01-01/00.json"]);
  });

  test("after the calls its hour's document already holds, which stay as they are", async () => {
    const r = rig();
    // Calls a later build wrote in a form this one can't read are no reason to lose them.
    const unread = { at: r.host.clock.now(), from: "a later build" };
    r.host.documents.set(DOC.spend("2026-05-01", "07"), { v: 1, kind: "spend", calls: [unread] });
    const made = r.add({});
    await r.spend.flush();
    expect(r.calls("2026-05-01", "07")).toEqual([unread, ...made]);
    // What it can't read counts as nothing.
    expect((await r.spend.get({ days: 1 })).total.calls).toBe(1);
  });

  test("at the next flush when its write fails, and the log says it is kept", async () => {
    const r = rig();
    const write = r.host.store.write;
    let away = true;
    r.host.store.write = async (path, value) => {
      if (away) throw new Error("503: the store is away");
      return write(path, value);
    };
    const made = r.add({});
    await r.spend.flush();
    expect(r.host.documents.size).toBe(0);
    expect(r.host.logs.at(-1)?.level).toBe("warn");
    expect(r.host.logs.at(-1)?.message).toContain("503: the store is away");
    // It is still counted, and still part of what the page is shown.
    expect((await r.spend.get({ days: 1 })).total).toMatchObject({ calls: 1, in: 900, out: 100 });
    away = false;
    made.push(...r.add({}));
    await r.spend.flush();
    expect(r.calls("2026-05-01", "07")).toEqual(made);
    expect((await r.spend.get({ days: 1 })).total.calls).toBe(2);
  });

  test("once even when a write fails after it landed: the next read of the document tells that it did", async () => {
    const r = rig();
    const write = r.host.store.write;
    let lost = true;
    r.host.store.write = async (path, value) => {
      await write(path, value);
      if (lost) throw new Error("the answer was lost on the way back");
    };
    const made = r.add({ agentId: "agent_1" }, { agentId: "agent_2", cost: undefined });
    await r.spend.flush();
    expect(r.host.logs.at(-1)?.message).toContain("the answer was lost on the way back");
    // The document holds them, so they are counted from it, and not again from memory.
    expect((await r.spend.get({ days: 1 })).total.calls).toBe(2);
    lost = false;
    made.push(...r.add({ agentId: "agent_3" }));
    await r.spend.flush();
    expect(r.calls("2026-05-01", "07")).toEqual(made);
    expect((await r.spend.get({ days: 1 })).total.calls).toBe(3);
    await r.spend.flush();
    expect(r.calls("2026-05-01", "07")).toHaveLength(3);
  });

  test("unless it isn't a call's record: that one is left out, and the log says so", async () => {
    const r = rig((s) => void (s.spend.tokensPerDay = 1000));
    r.add({ at: Number.NaN }, { in: -5 });
    expect(r.spend.refusal(turn)).toBeNull();
    expect(r.host.logs.map((l) => l.level)).toEqual(["warn", "warn"]);
    expect(r.host.logs[0]?.message).toContain("a model call's spend wasn't recorded");
    await r.spend.flush();
    expect(r.host.documents.size).toBe(0);
  });
});

describe("the caps", () => {
  test("Tokens per day refuses at the limit and not below it, in words that name the setting", () => {
    const r = rig((s) => void (s.spend.tokensPerDay = 3000));
    r.add({}, {});
    expect(r.spend.refusal(turn)).toBeNull();
    r.add({ cost: undefined });
    const stop = r.spend.refusal(turn);
    expect(stop).toBeInstanceOf(AgentStop);
    expect(stop?.code).toBe("spend");
    expect(stop?.message).toBe("what every agent's calls sent and wrote in the last 24 hours is counted as 3000 tokens of the 3000 Tokens per day allows (a cached re-read counts as 0.1 of a token)");
    // A job's call is every agent's call too.
    expect(r.spend.refusal(job)?.message).toBe(stop?.message ?? "");
  });

  test("Cost per day refuses at the limit and not below it, and a call whose cost isn't known counts as nothing", () => {
    const r = rig((s) => void (s.spend.costPerDay = 0.5));
    r.add({}, { cost: undefined, in: 500_000 });
    expect(r.spend.refusal(turn)).toBeNull();
    r.add({});
    expect(r.spend.refusal(turn)?.code).toBe("spend");
    expect(r.spend.refusal(turn)?.message).toBe("every agent's calls together have cost $0.50 in the last 24 hours, and Cost per day allows $0.50");
    r.add({ cost: 0.0125 });
    expect(r.spend.refusal(turn)?.message).toBe("every agent's calls together have cost $0.5125 in the last 24 hours, and Cost per day allows $0.50");
  });

  test("Job tokens per day refuses a job's call and not a turn's, and counts the jobs' calls alone", () => {
    const r = rig((s) => void (s.jobs.tokensPerDay = 2000));
    // A turn's calls, however many, are no job's.
    r.add({}, {}, {}, { kind: "job", run: "job-1", job: "job-1", agent: "summarizer" });
    expect(r.spend.refusal(job)).toBeNull();
    r.add({ kind: "job", run: "job-2", job: "job-2", agent: "summarizer" });
    const stop = r.spend.refusal(job);
    expect(stop?.code).toBe("spend");
    expect(stop?.message).toBe("what jobs sent and wrote in the last 24 hours is counted as 2000 tokens of the 2000 Job tokens per day allows (a cached re-read counts as 0.1 of a token)");
    expect(r.spend.refusal(turn)).toBeNull();
  });

  test("a prompt token read again from a provider's cache counts at What a cached re-read counts as against both limits on a day's tokens, and in full once that is 1", () => {
    const limits = (s: Settings): void => {
      s.spend.tokensPerDay = 3000;
      s.jobs.tokensPerDay = 3000;
    };
    // Two job calls of 10,000 prompt tokens each, 9,000 of them cached re-reads, and 100 written: 20,200 tokens truly, counted as 1000 fresh + 900 for the cached + 100 written each.
    const reread = { in: 10_000, cachedIn: 9000, out: 100, kind: "job" as const, run: "job-1", job: "job-1" };
    const r = rig(limits);
    expect(r.settings.spend.cachedWeight).toBe(0.1);
    r.add(reread);
    expect([r.spend.refusal(turn), r.spend.refusal(job)]).toEqual([null, null]);
    r.add(reread);
    expect(r.spend.refusal(turn)?.message).toBe("what every agent's calls sent and wrote in the last 24 hours is counted as 4000 tokens of the 3000 Tokens per day allows (a cached re-read counts as 0.1 of a token)");
    // With Tokens per day out of the way, the jobs' own limit counts the same.
    r.settings.spend.tokensPerDay = null;
    expect(r.spend.refusal(job)?.message).toBe("what jobs sent and wrote in the last 24 hours is counted as 4000 tokens of the 3000 Job tokens per day allows (a cached re-read counts as 0.1 of a token)");
    // The setting is read at each call: at 0 a cached re-read counts as nothing, at 1 in full.
    r.settings.spend.cachedWeight = 0;
    expect(r.spend.refusal(job)).toBeNull();
    r.settings.spend.cachedWeight = 1;
    expect(r.spend.refusal(job)?.message).toContain("counted as 20200 tokens of the 3000 Job tokens per day allows (a cached re-read counts as 1 of a token)");
  });

  test("the page is shown both: what a cap counts, and what was truly sent and written", async () => {
    const r = rig((s) => void (s.jobs.tokensPerDay = 3000));
    r.add({ in: 10_000, cachedIn: 9000, out: 100, kind: "job", run: "job-1", job: "job-1" });
    const got = await r.spend.get({ days: 1 });
    expect(got.caps.map((cap) => [cap.setting.join("."), cap.used, cap.sent, cap.reached])).toEqual([
      ["spend.tokensPerDay", 2000, 10_100, false],
      ["spend.costPerDay", 0.25, undefined, false],
      ["jobs.tokensPerDay", 2000, 10_100, false],
    ]);
    // The rows are the true counts, whatever the limits count.
    expect(got.total).toMatchObject({ in: 10_000, cachedIn: 9000, out: 100 });
  });

  test("a limit that isn't set never refuses, and a changed setting takes effect on the next call", () => {
    const r = rig((s) => void (s.jobs.tokensPerDay = null));
    r.add({ in: 9_000_000, cost: 400 }, { in: 9_000_000, kind: "job", job: "job-1" });
    expect(r.spend.refusal(turn)).toBeNull();
    expect(r.spend.refusal(job)).toBeNull();
    r.settings.spend.costPerDay = 400;
    expect(r.spend.refusal(turn)?.message).toContain("Cost per day allows $400.00");
  });

  test("are said in the user's own words where they replaced them", () => {
    const r = rig((s) => void (s.spend.tokensPerDay = 1000));
    r.add({});
    const own = new Texts({ "stop.spend_tokens": "{{tokens}} of {{limit}} used (Tokens per day)", "word.token": "jeton|jetons" });
    const stop = r.spend.refusal({ job: false, texts: own });
    expect(own.render(stop?.text.id ?? "", stop?.text.vars)).toBe("1000 jetons of 1000 used (Tokens per day)");
  });

  test("count a rolling 24 hours: a call older than that no longer counts", () => {
    const r = rig((s) => void (s.spend.tokensPerDay = 2000));
    r.add({});
    r.host.clock.advance(HOUR);
    r.add({});
    expect(r.spend.refusal(turn)?.code).toBe("spend");
    r.host.clock.advance(23 * HOUR - 1);
    expect(r.spend.refusal(turn)?.code).toBe("spend");
    // The first call was made 24 hours ago to the millisecond: it has left the window.
    r.host.clock.advance(1);
    expect(r.spend.refusal(turn)).toBeNull();
    r.add({});
    expect(r.spend.refusal(turn)?.code).toBe("spend");
    r.host.clock.advance(HOUR);
    expect(r.spend.refusal(turn)).toBeNull();
  });
});

describe("across runs of the process", () => {
  test("a second Spend over the same store counts what the first wrote, once it is ready", async () => {
    const r = rig((s) => void (s.spend.tokensPerDay = 2000));
    r.add({}, {});
    await r.spend.flush();
    r.host.clock.advance(2 * HOUR);
    const again = new Spend(r.host, () => r.settings);
    expect(again.refusal(turn)).toBeNull();
    await again.ready();
    expect(again.refusal(turn)?.message).toContain("2000 tokens");
    // Ready reads once: asked again, and after a flush of its own, nothing is counted twice.
    again.add(r.call({ in: 400, out: 100 }));
    await again.flush();
    await again.ready();
    expect((await again.get({ days: 1 })).caps[0]).toEqual({ setting: ["spend", "tokensPerDay"], unit: "tokens", limit: 2000, used: 2500, sent: 2500, reached: true });
    expect((await again.get({ days: 1 })).total.calls).toBe(3);
  });

  test("what was written more than 24 hours ago is not counted, and yesterday's is, to the hour", async () => {
    const r = rig((s) => void (s.spend.tokensPerDay = 1000));
    r.add({});
    r.host.clock.advance(HOUR);
    r.add({ in: 300, out: 0 });
    await r.spend.flush();
    // 24 hours after the first call: only the second is still within the window.
    r.host.clock.advance(23 * HOUR);
    const again = new Spend(r.host, () => r.settings);
    await again.ready();
    expect(again.refusal(turn)).toBeNull();
    expect((await again.get({ days: 2 })).caps[0]).toMatchObject({ used: 300, reached: false });
  });

  test("a process that wrote before it could read the last day counts its own calls once", async () => {
    const r = rig((s) => void (s.spend.tokensPerDay = 1000));
    r.add({}, {});
    await r.spend.flush();
    r.host.clock.advance(3 * HOUR);
    const again = new Spend(r.host, () => r.settings);
    // The store can't give the earlier hour's document just now.
    const read = r.host.store.read;
    let away = true;
    r.host.store.read = async (path) => {
      if (away && path === DOC.spend("2026-05-01", "07")) throw new Error("the store timed out");
      return read(path);
    };
    again.add(r.call());
    await again.flush();
    expect(r.host.logs.some((l) => l.level === "warn" && l.message.includes("the store timed out"))).toBe(true);
    // Its own call is written all the same, and the caps count what it has spent itself.
    expect(r.calls("2026-05-01", "10")).toHaveLength(1);
    expect(again.refusal(turn)?.message).toContain("counted as 1000 tokens");
    away = false;
    await again.ready();
    expect(again.refusal(turn)?.message).toContain("counted as 3000 tokens");
    expect((await again.get({ days: 1 })).total.calls).toBe(3);
  });
});

describe("what the page is shown", () => {
  const sums = (rows: SpendRow[]) => rows.map((row) => [row.key, row.calls, row.in + row.out, row.cost, row.unpriced]);

  test("the calls of the last days by day, chat, agent, connection and model, the unpriced ones counted, and each cap's use", async () => {
    const r = rig((s) => {
      s.spend.tokensPerDay = 10_000;
      s.spend.costPerDay = 1;
      s.jobs.tokensPerDay = 1000;
    });
    r.host.clock.t = Date.UTC(2026, 4, 1, 22, 30);
    r.add({ cachedIn: 300 }, { agent: "writer", agentId: "agent_2", connection: "conn-writer", model: "model-writer", in: 400, out: 300, cost: undefined, estimated: true }, { agent: "scout", agentId: "agent_3", in: 800, out: 100, cost: undefined });
    await r.spend.flush();
    // Past midnight, a job of another chat; the run it belongs to hasn't ended, so its call isn't written yet.
    r.host.clock.advance(2 * HOUR);
    r.add({ kind: "job", run: "job-1", job: "job-1", chatId: "chat-2", agent: "summarizer", agentId: "agent_4", in: 600, out: 400, cost: 0.5 });
    r.host.clock.advance(8 * HOUR);

    const got = await r.spend.get({ days: 3 });
    expect(got.days).toEqual([
      { key: "2026-04-30", calls: 0, in: 0, cachedIn: 0, out: 0, cost: 0, unpriced: 0 },
      { key: "2026-05-01", calls: 3, in: 2100, cachedIn: 300, out: 500, cost: 0.25, unpriced: 2 },
      { key: "2026-05-02", calls: 1, in: 600, cachedIn: 0, out: 400, cost: 0.5, unpriced: 0 },
    ]);
    // The largest cost first, then the most tokens.
    expect(sums(got.chats)).toEqual([["chat-2", 1, 1000, 0.5, 0], ["chat-1", 3, 2600, 0.25, 2]]);
    expect(sums(got.agents)).toEqual([["summarizer", 1, 1000, 0.5, 0], ["main", 1, 1000, 0.25, 0], ["scout", 1, 900, 0, 1], ["writer", 1, 700, 0, 1]]);
    expect(sums(got.connections)).toEqual([["conn-main", 3, 2900, 0.75, 1], ["conn-writer", 1, 700, 0, 1]]);
    expect(sums(got.models)).toEqual([["model-main", 3, 2900, 0.75, 1], ["model-writer", 1, 700, 0, 1]]);
    expect(got.total).toEqual({ key: "total", calls: 4, in: 2700, cachedIn: 300, out: 900, cost: 0.75, unpriced: 2 });
    // One call read 300 of its prompt tokens again from the cache: the caps count those at a tenth, and say what was truly sent beside it.
    expect(got.caps).toEqual([
      { setting: ["spend", "tokensPerDay"], unit: "tokens", limit: 10_000, used: 3330, sent: 3600, reached: false },
      { setting: ["spend", "costPerDay"], unit: "usd", limit: 1, used: 0.75, reached: false },
      { setting: ["jobs", "tokensPerDay"], unit: "tokens", limit: 1000, used: 1000, sent: 1000, reached: true },
    ]);

    // Today alone: the job's call, and the caps still as the last 24 hours have them.
    const today = await r.spend.get({ days: 1 });
    expect(sums(today.days)).toEqual([["2026-05-02", 1, 1000, 0.5, 0]]);
    expect(sums(today.chats)).toEqual([["chat-2", 1, 1000, 0.5, 0]]);
    expect(today.caps).toEqual(got.caps);
  });

  test("with no cap set and nothing spent: every day asked for, empty, and the caps unreached", async () => {
    const r = rig((s) => void (s.jobs.tokensPerDay = null));
    const got = await r.spend.get({ days: 2 });
    expect(sums(got.days)).toEqual([["2026-04-30", 0, 0, 0, 0], ["2026-05-01", 0, 0, 0, 0]]);
    expect([got.chats, got.agents, got.connections, got.models]).toEqual([[], [], [], []]);
    expect(got.caps.map((cap) => [cap.limit, cap.used, cap.reached])).toEqual([[null, 0, false], [null, 0, false], [null, 0, false]]);
  });

  test("a number of days that isn't one is refused as a bad request, in words that say what to ask for", async () => {
    const r = rig();
    // The page's request reaches the core as it was sent: whatever it holds for days.
    for (const days of [0, -3, 1.5, 367, Number.NaN, "7", undefined]) {
      const refused: unknown = await r.spend.get({ days: days as number }).then(
        () => null,
        (error: unknown) => error,
      );
      if (!(refused instanceof HarnessRefusal)) throw new Error(`${String(days)} days wasn't refused`);
      expect(refused.code).toBe("bad_request");
      expect(refused.message).toBe("Spend is shown for a whole number of days, from 1 to 366. Ask for a number of days in that range.");
    }
    expect((await r.spend.get({ days: 366 })).days).toHaveLength(366);
  });
});
