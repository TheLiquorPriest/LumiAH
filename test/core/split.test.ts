// A turn whose reply the host writes (DESIGN §25, built in): the turn in two halves. `prepare`
// runs the main agent and gives back what Lumiverse's own generation is to be sent, with no writer
// called; `complete` takes the reply once it is written and gives the turn's record; between the two
// the turn is pending, and one that never completes leaves nothing. The reply is due at a moment
// the host names: the main agent is told its time, warned near the end, and handed over at the
// moment itself. Whatever fails, the request comes back as it came.

import { describe, expect, test } from "bun:test";
import { createHarness, type Harness } from "../../src/core/harness";
import type { HarnessExtension } from "../../src/core/extension";
import { DOC } from "../../src/core/paths";
import type { JsonValue, ModelRequest, TraceEvent, TurnRequest, TurnResult } from "../../src/core/ports";
import { HarnessRefusal } from "../../src/core/refusal";
import { segmentOf } from "../../src/core/sessions";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { parseJson } from "../../src/core/util";
import { call, idle, MemoryHost, runTurn, type Script, until } from "./support/host";

const CHAT = "chat-1";
const never = new AbortController().signal;

const isMain = (request: ModelRequest): boolean => request.tools?.some((t) => t.name === "write_reply") === true;
const BRIEF: Script = (request) => (isMain(request) ? { toolCalls: [call("write_reply", { brief: "Okoro opens the door a hand's width." }, "w1")] } : "never: no writer is called here");

let generation = 1;

function rig(script: Script = BRIEF, change: (s: Settings) => void = () => undefined, extension?: HarnessExtension) {
  const host = new MemoryHost();
  host.script = script;
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I walk down to the lighthouse and knock.");
  const stored = { values: defaultSettings(), texts: {} as Record<string, string> };
  change(stored.values);
  let broken: string | null = null;
  const harness: Harness = createHarness(host, {
    settings: async () => {
      if (broken !== null) throw new Error(broken);
      return structuredClone(stored);
    },
    ...(extension ? { extension } : {}),
  });
  /** The request Lumiverse assembled for a new reply in the chat, as the host hands it to `prepare`. */
  const request = (more: Partial<TurnRequest> = {}): TurnRequest => ({
    userId: "user-1",
    chatId: CHAT,
    generationId: `built-in-${generation++}`,
    kind: "new",
    target: { messageId: null, swipeId: 0 },
    presetId: null,
    messages: host.requestOf(CHAT, host.chats.get(CHAT)?.length ?? 0, null),
    params: { temperature: 0.9 },
    maxTokens: 700,
    ...more,
  });
  /** Lumiverse saved the reply its own generation wrote: the second half, and the record anchored on the new message. */
  const written = async (turn: TurnRequest, reply: string): Promise<TurnResult> => {
    const result = await harness.complete({ generationId: turn.generationId, reply, finish: "stop" });
    const saved = host.message(CHAT, host.say(CHAT, "assistant", reply));
    if (result.record) host.anchorOn(saved, 0, result.record as unknown as JsonValue);
    return result;
  };
  return { host, harness, stored, request, written, breakSettings: (why: string | null) => void (broken = why) };
}

const events = (host: MemoryHost, turn: string): TraceEvent[] => host.traced.filter((t) => t.turn === turn).map((t) => t.event);
const notices = (host: MemoryHost, turn: string): string[] => events(host, turn).flatMap((e) => (e.kind === "notice" ? [e.text] : []));
const ended = (host: MemoryHost, turn: string) => events(host, turn).find((e) => e.kind === "turn_ended");

async function refused(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof HarnessRefusal) return error.code;
    throw error;
  }
  return "not refused";
}

describe("the first half", () => {
  test("runs the main agent and gives back the request with its brief put in, each message that came still bearing where it came from; no writer is called", async () => {
    const r = rig();
    const turn = r.request();
    const prepared = await r.harness.prepare(turn, { replyBy: null }, never);
    expect(prepared).toMatchObject({ part: "brief", pending: true });
    expect(prepared.reason).toBeUndefined();
    // The one model call made is the main agent's.
    expect(r.host.calls).toHaveLength(1);
    expect(isMain(r.host.calls[0] as ModelRequest)).toBe(true);
    // The messages that came are there as they came, in order; the brief is one message more, before the user's last.
    expect(prepared.messages).toHaveLength(turn.messages.length + 1);
    expect(prepared.messages.filter((m) => m.source !== undefined)).toEqual(turn.messages);
    const added = prepared.messages.filter((m) => m.source === undefined);
    expect(added).toHaveLength(1);
    expect(added[0]?.content).toContain("Okoro opens the door a hand's width.");
    expect(prepared.messages.indexOf(added[0] as (typeof added)[number])).toBe(turn.messages.length - 1);
    // The live view is told what was handed over, and the turn hasn't ended: it waits for its reply.
    expect(notices(r.host, turn.generationId)).toEqual(["Lumiverse writes the reply from its prompt with the main agent's brief."]);
    // Nothing went wrong, and the notice says so: a page shows it as a plain line, not among what failed.
    expect(events(r.host, turn.generationId).flatMap((e) => (e.kind === "notice" ? [e.info] : []))).toEqual([true]);
    expect(ended(r.host, turn.generationId)).toBeUndefined();
    expect(prepared.usage.calls).toBe(1);
  });

  test("always has the main agent brief a writer, whatever Settings say of who writes the reply", async () => {
    const r = rig(BRIEF, (s) => {
      s.reply.writer = "main";
    });
    const prepared = await r.harness.prepare(r.request(), { replyBy: null }, never);
    expect(prepared.part).toBe("brief");
    expect(r.host.calls[0]?.tools?.map((t) => t.name)).toContain("write_reply");
    expect(r.host.calls[0]?.messages[0]?.content).toContain("hand it to the writer");
  });

  test("an answer without write_reply stands in the brief's place, and is named as that", async () => {
    const r = rig((request) => (isMain(request) ? "Okoro is wary of strangers at night." : "never"));
    const turn = r.request();
    const prepared = await r.harness.prepare(turn, { replyBy: null }, never);
    expect(prepared).toMatchObject({ part: "answer", pending: true, reason: "The main agent ended without calling write_reply; Lumiverse writes the reply from its prompt with the agent's last answer as the brief." });
    expect(prepared.messages.find((m) => m.source === undefined)?.content).toContain("Okoro is wary of strangers at night.");
    // Its notes keep the answer as what it wrote, never as a call it didn't make.
    const result = await r.written(turn, "The door stays shut.");
    const segment = JSON.parse(r.host.blobStore.get(result.record?.segment ?? "") ?? "{}") as { steps: { kind: string; name?: string }[] };
    expect(segment.steps.map((s) => s.kind)).toEqual(["said", "stop"]);
  });

  test("a main agent that stops short costs no reply: the request goes as it came, the turn still waits, and its notes keep what it did", async () => {
    const r = rig(
      (request, n) => (isMain(request) ? { toolCalls: [call("chat_search", { query: `lighthouse ${n}` }, `c${n}`)] } : "never"),
      (s) => {
        // Even where Settings fail a turn whose writer has no brief: here Lumiverse writes, and never loses a reply to LumiAH.
        s.reply.withoutBrief = "fail";
        (s.agents.main as NonNullable<typeof s.agents.main>).budget.toolTurns = 2;
      },
    );
    const turn = r.request();
    const prepared = await r.harness.prepare(turn, { replyBy: null }, never);
    expect(prepared.part).toBe("none");
    expect(prepared.pending).toBe(true);
    expect(prepared.messages).toBe(turn.messages);
    expect(prepared.reason).toContain("Tool rounds");
    expect(notices(r.host, turn.generationId)[0]).toStartWith("LumiAH had no part in this reply (");
    // A turn LumiAH had no part in is a warning: its notice isn't marked as plain news.
    expect(events(r.host, turn.generationId).flatMap((e) => (e.kind === "notice" ? [e.info] : []))[0]).toBeUndefined();
    const result = await r.written(turn, "The door stays shut.");
    expect(result.status).toBe("done");
    expect(result.record).not.toBeNull();
  });

  test("the extension's rewrite of the writer's request is what goes to Lumiverse", async () => {
    const r = rig(BRIEF, undefined, {
      name: "Harbour",
      writerRequest: async (input) => [...input.messages, { role: "system", content: "The tide is in." }],
    });
    const prepared = await r.harness.prepare(r.request(), { replyBy: null }, never);
    expect(prepared.messages.at(-1)).toEqual({ role: "system", content: "The tide is in." });
    expect(prepared.messages.some((m) => m.content.includes("Okoro opens the door a hand's width."))).toBe(true);
  });
});

describe("the second half", () => {
  test("takes the reply once it is written and gives the turn's record; the next turn's main agent goes on from its notes", async () => {
    const r = rig();
    const turn = r.request();
    await r.harness.prepare(turn, { replyBy: null }, never);
    const result = await r.written(turn, "The door opens a hand's width. A lamp swings behind it.");
    expect(result).toMatchObject({ status: "done", reply: "The door opens a hand's width. A lamp swings behind it." });
    expect(result.record).toMatchObject({ generationId: turn.generationId, kind: "new" });
    expect(result.usage.calls).toBe(1);
    expect(ended(r.host, turn.generationId)).toMatchObject({ kind: "turn_ended", status: "done" });
    // The notes hold the brief it gave and that the reply was written, with its length.
    const segment = r.host.blobStore.get(result.record?.segment ?? "") ?? "";
    expect(segment).toContain("Okoro opens the door a hand's width.");
    expect(segment).toContain("the writer wrote the reply (55 characters; it is chat message #2)");
    // The next turn, by either way of running, resumes from them.
    r.host.say(CHAT, "user", "I step inside.");
    const next = r.request();
    await r.harness.prepare(next, { replyBy: null }, never);
    expect(JSON.stringify(r.host.calls.at(-1)?.messages.slice(0, -1))).toContain("Okoro opens the door a hand's width.");
    await r.written(next, "Inside it smells of oil and salt.");
    r.host.say(CHAT, "user", "I look around.");
    r.host.script = (request) => (isMain(request) ? { toolCalls: [call("write_reply", { brief: "The lamp room is above." }, "w3")] } : "A stair winds up into the dark.");
    const third = await runTurn(r.host, r.harness, CHAT, {});
    expect(third.result.status).toBe("done");
    expect(JSON.stringify(r.host.calls.at(-2)?.messages)).toContain("Okoro opens the door a hand's width.");
  });

  test("is refused for a turn that isn't pending: one never prepared, one already recorded", async () => {
    const r = rig();
    expect(await refused(r.harness.complete({ generationId: "nobody", reply: "x", finish: "stop" }))).toBe("not_found");
    const turn = r.request();
    await r.harness.prepare(turn, { replyBy: null }, never);
    await r.written(turn, "The door opens.");
    expect(await refused(r.harness.complete({ generationId: turn.generationId, reply: "again", finish: "stop" }))).toBe("not_found");
    expect(await refused(r.harness.abandon({ generationId: turn.generationId }))).toBe("not_found");
  });
});

describe("a pending turn that never completes", () => {
  /** A first half in which the main agent writes a file to the chat's area and one to learned/, starts a job, then briefs. */
  const busy: Script = (request, n) => {
    if (!isMain(request)) return "never";
    if (n === 0) {
      return {
        toolCalls: [
          call("workspace_write", { path: "/scene.md", content: "Okoro is at the door.", base: "new" }, "f1"),
          call("workspace_write", { path: "learned/who.md", content: "Okoro keeps the lighthouse.", base: "new" }, "f2"),
          call("job_start", { agent: "summarizer", task: "Tidy the notes.", when: "after_reply" }, "j1"),
        ],
      };
    }
    return { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "w1")] };
  };

  test("abandoned, it leaves no record and nothing half-written: the chat's area is as it was, and its job learns no record is coming", async () => {
    const r = rig(busy);
    const turn = r.request();
    const prepared = await r.harness.prepare(turn, { replyBy: null }, never);
    expect(prepared).toMatchObject({ part: "brief", pending: true });
    expect(r.host.queued).toHaveLength(1);
    expect(await r.harness.abandon({ generationId: turn.generationId, reason: "the generation was stopped" })).toEqual({ abandoned: true });
    expect(ended(r.host, turn.generationId)).toMatchObject({ status: "stopped", reason: "the generation was stopped" });
    // Nothing is recorded on the chat, and the second half can't come any more.
    expect(r.host.last(CHAT).role).toBe("user");
    expect(await refused(r.harness.complete({ generationId: turn.generationId, reply: "late", finish: "stop" }))).toBe("not_found");
    // What it wrote to the chat's own area is gone with it; learned/ is the chat's, and stays.
    expect((await r.harness.workspace.list({ chatId: CHAT, area: "chat" })).files).toEqual([]);
    expect((await r.harness.workspace.list({ chatId: CHAT, area: "learned" })).files.map((f) => f.path)).toEqual(["who.md"]);
    // Its job belongs to a turn that left no record: run, it stops as off the path.
    const job = await r.harness.jobs.run({ id: r.host.queued[0]?.id ?? "" }, never);
    expect(job.state).toBe("off_path");
  });

  test("an empty reply gives it up the same way", async () => {
    const r = rig();
    const turn = r.request();
    await r.harness.prepare(turn, { replyBy: null }, never);
    const result = await r.harness.complete({ generationId: turn.generationId, reply: "", finish: "stop" });
    expect(result).toMatchObject({ status: "stopped", record: null, reply: "", reason: "Lumiverse's generation wrote no reply, so no record of the turn is kept" });
    expect(ended(r.host, turn.generationId)).toMatchObject({ status: "stopped" });
  });

  test("nobody completing it, its run is given up once Give up a reply that isn't written has passed", async () => {
    const r = rig(BRIEF, (s) => {
      s.reply.pendingMs = 120_000;
    });
    const turn = r.request();
    await r.harness.prepare(turn, { replyBy: null }, never);
    r.host.clock.advance(119_999);
    await idle(2);
    expect(ended(r.host, turn.generationId)).toBeUndefined();
    r.host.clock.advance(1);
    await until(() => ended(r.host, turn.generationId) !== undefined);
    expect(ended(r.host, turn.generationId)).toMatchObject({ status: "stopped", reason: "its reply wasn't written within 120 seconds of the hand-over (Give up a reply that isn't written), so its run was let go; if the reply is still saved, the turn gets its record then" });
  });

  test("completed in time, its job stands: the record it belongs to is there", async () => {
    const r = rig(busy);
    const turn = r.request();
    await r.harness.prepare(turn, { replyBy: null }, never);
    const result = await r.written(turn, "The door opens.");
    expect(result.record?.jobs?.map((j) => j.agent)).toEqual(["summarizer"]);
    expect(result.record?.changed).toBe(1);
    r.host.script = () => "The notes are tidy.";
    const job = await r.harness.jobs.run({ id: r.host.queued[0]?.id ?? "" }, never);
    expect(job.state).toBe("done");
  });
});

describe("a waiting turn is kept in storage (a restart, a late reply)", () => {
  /** A first half in which the main agent writes a file to the chat's area, starts a job, then briefs. */
  const busy: Script = (request, n) => {
    if (!isMain(request)) return "never";
    if (n === 0) return { toolCalls: [call("workspace_write", { path: "/scene.md", content: "Okoro is at the door.", base: "new" }, "f1"), call("job_start", { agent: "summarizer", task: "Tidy the notes.", when: "after_reply" }, "j1")] };
    return { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "w1")] };
  };
  const kept = (host: MemoryHost, turn: TurnRequest): JsonValue | undefined => host.documents.get(DOC.pending(turn.generationId));
  const stored = (host: MemoryHost): string[] => [...host.documents.keys()].filter((path) => path.startsWith("pending/"));
  /** The extension restarted: a new harness over the same storage, which holds no turn in memory. */
  const restarted = (r: { host: MemoryHost; stored: { values: Settings; texts: Record<string, string> } }): Harness => createHarness(r.host, { settings: async () => structuredClone(r.stored) });
  const steps = (host: MemoryHost, result: TurnResult) => segmentOf(parseJson(host.blobStore.get(result.record?.segment ?? "") ?? ""))?.steps;

  test("at the hand-over what the record needs is stored, as hashes and counts and never a text; a turn that never waits stores nothing", async () => {
    const r = rig(busy);
    const turn = r.request();
    await r.harness.prepare(turn, { replyBy: null }, never);
    expect(kept(r.host, turn)).toMatchObject({ v: 1, kind: "pending", generationId: turn.generationId, chatId: CHAT, turn: "new", at: r.host.clock.now(), until: r.host.clock.now() + 600_000, replied: [2], asBrief: null });
    expect(JSON.stringify(kept(r.host, turn))).not.toContain("Okoro");
    expect(JSON.stringify(kept(r.host, turn)).length).toBeLessThan(2000);
    const none = rig();
    none.breakSettings("the link is down");
    await none.harness.prepare(none.request(), { replyBy: null }, never);
    expect(stored(none.host)).toEqual([]);
  });

  test("completed or abandoned by the harness that holds it, nothing of it is left in storage", async () => {
    const r = rig();
    const [one, two, three] = [r.request(), r.request(), r.request()];
    await r.harness.prepare(one, { replyBy: null }, never);
    expect((await r.written(one, "The door opens.")).recovered).toBeUndefined();
    r.host.say(CHAT, "user", "I step inside.");
    await r.harness.prepare(two, { replyBy: null }, never);
    await r.harness.abandon({ generationId: two.generationId });
    await r.harness.prepare(three, { replyBy: null }, never);
    await r.harness.complete({ generationId: three.generationId, reply: "", finish: "stop" });
    expect(stored(r.host)).toEqual([]);
  });

  test("after a restart the reply still gets the turn's record: its notes, its files, its job and what it spent, and no transcript", async () => {
    const r = rig(busy);
    const turn = r.request();
    const prepared = await r.harness.prepare(turn, { replyBy: null }, never);
    const again = restarted(r);
    const result = await again.complete({ generationId: turn.generationId, reply: "The door opens.", finish: "stop" });
    expect(result).toMatchObject({ status: "done", reply: "The door opens.", recovered: "restart", usage: prepared.usage });
    expect(result.record).toMatchObject({ generationId: turn.generationId, kind: "new", recovered: "restart", changed: 1, jobs: [{ agent: "summarizer", state: "queued" }] });
    expect(result.record?.transcript).toBeUndefined();
    expect(steps(r.host, result)?.at(-1)).toEqual({ kind: "call", name: "write_reply", args: { brief: "Okoro opens the door." }, result: "the writer wrote the reply (15 characters; it is chat message #2)" });
    expect(stored(r.host)).toEqual([]);
    // The record is anchored as any is: the chat's files are the turn's, its job runs, and the next turn goes on from its notes.
    r.host.anchorOn(r.host.message(CHAT, r.host.say(CHAT, "assistant", "The door opens.")), 0, result.record as unknown as JsonValue);
    expect((await again.workspace.list({ chatId: CHAT, area: "chat" })).files.map((f) => f.path)).toEqual(["scene.md"]);
    r.host.script = () => "The notes are tidy.";
    expect((await again.jobs.run({ id: r.host.queued[0]?.id ?? "" }, never)).state).toBe("done");
    r.host.say(CHAT, "user", "I step inside.");
    r.host.script = BRIEF;
    await again.prepare(r.request(), { replyBy: null }, never);
    expect(JSON.stringify(r.host.calls.at(-1)?.messages.slice(0, -1))).toContain("the writer wrote the reply (15 characters; it is chat message #2)");
    // It was taken once: a second reply for it finds nothing.
    expect(await refused(again.complete({ generationId: turn.generationId, reply: "again", finish: "stop" }))).toBe("not_found");
  });

  test("a reply that comes after Give up a reply that isn't written still gets its record, marked late", async () => {
    const r = rig(BRIEF, (s) => {
      s.reply.pendingMs = 120_000;
    });
    const turn = r.request();
    await r.harness.prepare(turn, { replyBy: null }, never);
    r.host.clock.advance(120_000);
    await until(() => ended(r.host, turn.generationId) !== undefined);
    // The wait ran out and the run was given up; what storage keeps of the turn stays.
    expect(stored(r.host)).toEqual([DOC.pending(turn.generationId)]);
    const result = await r.written(turn, "The door opens at last.");
    expect(result).toMatchObject({ status: "done", reply: "The door opens at last.", recovered: "late" });
    expect(result.record).toMatchObject({ generationId: turn.generationId, recovered: "late" });
    expect(steps(r.host, result)?.at(-1)).toMatchObject({ kind: "call", name: "write_reply", result: "the writer wrote the reply (23 characters; it is chat message #2)" });
    expect(stored(r.host)).toEqual([]);
    expect(await refused(r.harness.complete({ generationId: turn.generationId, reply: "again", finish: "stop" }))).toBe("not_found");
  });

  test("an answer that stood in the brief's place is kept as that in a recovered record too", async () => {
    const r = rig((request) => (isMain(request) ? "Okoro is wary of strangers at night." : "never"));
    const turn = r.request();
    await r.harness.prepare(turn, { replyBy: null }, never);
    const result = await restarted(r).complete({ generationId: turn.generationId, reply: "The door stays shut.", finish: "stop" });
    expect(steps(r.host, result)).toEqual([
      { kind: "said", text: "Okoro is wary of strangers at night." },
      { kind: "stop", reason: "you ended without calling write_reply, so that answer was handed to the writer as your brief, and the writer wrote the reply (20 characters; it is chat message #2)" },
    ]);
  });

  test("a turn only storage holds is given up quietly: by abandon, or by an empty reply; its job learns no record is coming", async () => {
    const r = rig(busy);
    const turn = r.request();
    await r.harness.prepare(turn, { replyBy: null }, never);
    const again = restarted(r);
    expect(await again.abandon({ generationId: turn.generationId })).toEqual({ abandoned: true });
    expect(stored(r.host)).toEqual([]);
    expect(await refused(again.complete({ generationId: turn.generationId, reply: "late", finish: "stop" }))).toBe("not_found");
    expect(await refused(again.abandon({ generationId: turn.generationId }))).toBe("not_found");
    expect((await again.jobs.run({ id: r.host.queued[0]?.id ?? "" }, never)).state).toBe("off_path");
    const other = rig();
    const next = other.request();
    const prepared = await other.harness.prepare(next, { replyBy: null }, never);
    expect(await restarted(other).complete({ generationId: next.generationId, reply: "", finish: "stop" })).toEqual({ status: "stopped", reason: "Lumiverse's generation wrote no reply, so no record of the turn is kept", record: null, reply: "", usage: prepared.usage });
    expect(stored(other.host)).toEqual([]);
  });

  test("a generation that was never handed over is refused as not found, by a fresh harness too", async () => {
    const r = rig();
    expect(await refused(restarted(r).complete({ generationId: "nobody", reply: "x", finish: "stop" }))).toBe("not_found");
    expect(await refused(restarted(r).abandon({ generationId: "nobody" }))).toBe("not_found");
    expect(stored(r.host)).toEqual([]);
  });
});

describe("the time before the reply", () => {
  test("the main agent is told how long it has, and the trace says when the reply is due", async () => {
    const r = rig();
    const turn = r.request();
    const replyBy = r.host.clock.now() + 240_000;
    await r.harness.prepare(turn, { replyBy }, never);
    expect(r.host.calls[0]?.messages.at(-1)?.content).toContain("[The reply is due in about 240 seconds: Lumiverse waits no longer than that before it writes.");
    expect(events(r.host, turn.generationId)[0]).toMatchObject({ kind: "turn_started", replyBy });
    // Without such a moment nothing is said of time.
    const free = rig();
    await free.harness.prepare(free.request(), { replyBy: null }, never);
    expect(free.host.calls[0]?.messages.at(-1)?.content).not.toContain("The reply is due");
  });

  test("it is warned once, with a round's results, when as little is left as Settings say", async () => {
    const r = rig(
      (request, n) => {
        if (!isMain(request)) return "never";
        // Each round takes a minute of the four minutes and ten seconds it has.
        r.host.clock.advance(60_000);
        return n < 3 ? { toolCalls: [call("chat_search", { query: `lighthouse ${n}` }, `c${n}`)] } : { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "w1")] };
      },
      (s) => {
        s.reply.warnMs = 90_000;
      },
    );
    const turn = r.request();
    // The reply is due ten seconds after the fourth round would end: at the moment it is due nothing more is begun, so the brief has to be in by then.
    const prepared = await r.harness.prepare(turn, { replyBy: r.host.clock.now() + 250_000 }, never);
    expect(prepared.part).toBe("brief");
    const told = r.host.calls.map((c) => c.messages.at(-1)?.content ?? "");
    // After two minutes, 130 seconds are left: no warning yet. After three, 70 are left: the warning comes with that round's results, and only once.
    expect(told[2]).not.toContain("seconds are left before the reply is due");
    expect(told[3]).toContain("[About 70 seconds are left before the reply is due. Call write_reply now with what you have; what is left to do belongs in a job.]");
    expect(told.filter((text) => text.includes("seconds are left before the reply is due"))).toHaveLength(1);
    expect(events(r.host, turn.generationId).some((e) => e.kind === "agent_entry" && e.entry.kind === "notice" && e.entry.text.startsWith("[About 70 seconds"))).toBe(true);
    // With the warning switched off nothing is said.
    const quiet = rig(
      (request, n) => {
        if (!isMain(request)) return "never";
        quiet.host.clock.advance(100_000);
        return n < 1 ? { toolCalls: [call("chat_search", { query: "lighthouse" }, "c0")] } : { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "w1")] };
      },
      (s) => {
        s.reply.warnMs = null;
      },
    );
    await quiet.harness.prepare(quiet.request(), { replyBy: quiet.host.clock.now() + 240_000 }, never);
    expect(quiet.host.calls.some((c) => (c.messages.at(-1)?.content ?? "").includes("seconds are left"))).toBe(false);
  });

  test("when the reply is due before a brief, the request goes as it came, the turn still waits for its record, sub-agents in flight are cancelled and jobs started stand", async () => {
    const r = rig((request, n) => {
      // The summarizer, delegated to, never answers: it is in flight when the time is up.
      if (!isMain(request)) return { hang: true };
      if (n === 0) return { toolCalls: [call("job_start", { agent: "summarizer", task: "Tidy the notes.", when: "after_reply" }, "j1")] };
      return { toolCalls: [call("delegate", { agent: "summarizer", task: "Summarize the chat so far." }, "d1")] };
    });
    const turn = r.request();
    const preparing = r.harness.prepare(turn, { replyBy: r.host.clock.now() + 240_000 }, never);
    // The sub-agent's call is under way.
    await until(() => r.host.calls.length === 3);
    r.host.clock.advance(240_000);
    const prepared = await preparing;
    expect(prepared.part).toBe("none");
    expect(prepared.pending).toBe(true);
    expect(prepared.messages).toBe(turn.messages);
    expect(prepared.reason).toBe("the reply was due before its work was done: Lumiverse waits only so long before it writes");
    expect(notices(r.host, turn.generationId)).toEqual(["LumiAH had no part in this reply (the reply was due before its work was done: Lumiverse waits only so long before it writes): Lumiverse writes it from its prompt as it was."]);
    // The sub-agent was cancelled with it: both stopped because the reply was due, and no call was made after that.
    const stops = events(r.host, turn.generationId).flatMap((e) => (e.kind === "agent_entry" && e.entry.kind === "stop" ? [e.entry.code] : []));
    expect(stops).toEqual(["reply_time", "reply_time"]);
    await idle(2);
    expect(r.host.calls).toHaveLength(3);
    // Its handle is gone: nothing of the turn can message it any more.
    expect(events(r.host, turn.generationId).filter((e) => e.kind === "agent_started")).toHaveLength(2);
    // The job it started stands, and once the reply is written the turn's record holds it and what the agent did.
    expect(r.host.queued).toHaveLength(1);
    const result = await r.written(turn, "The door stays shut.");
    expect(result.record?.jobs).toHaveLength(1);
    const segment = r.host.blobStore.get(result.record?.segment ?? "") ?? "";
    expect(segment).toContain("job_start");
    expect(segment).toContain("the reply was due before its work was done");
    r.host.script = () => "The notes are tidy.";
    expect((await r.harness.jobs.run({ id: r.host.queued[0]?.id ?? "" }, never)).state).toBe("done");
  });

  test("a brief given before the reply is due is handed over, however late the hand-over itself comes", async () => {
    const r = rig((request) => {
      if (!isMain(request)) return "never";
      r.host.clock.advance(239_000);
      return { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "w1")] };
    });
    const prepared = await r.harness.prepare(r.request(), { replyBy: r.host.clock.now() + 240_000 }, never);
    expect(prepared.part).toBe("brief");
  });

  test("a reply already due when the turn begins costs nothing: no model is called, and the request goes as it came", async () => {
    const r = rig();
    const turn = r.request();
    const prepared = await r.harness.prepare(turn, { replyBy: r.host.clock.now() - 1 }, never);
    expect(prepared).toMatchObject({ part: "none", pending: false });
    expect(prepared.messages).toBe(turn.messages);
    expect(r.host.calls).toHaveLength(0);
    expect(ended(r.host, turn.generationId)).toMatchObject({ status: "stopped" });
  });
});

describe("a failure", () => {
  test("settings that can't be read: the request comes back as it came, with why, and nothing waits", async () => {
    const r = rig();
    r.breakSettings("the link is down");
    const turn = r.request();
    const prepared = await r.harness.prepare(turn, { replyBy: null }, never);
    expect(prepared).toMatchObject({ part: "none", pending: false });
    expect(prepared.messages).toBe(turn.messages);
    expect(prepared.reason).toContain("the link is down");
    expect(r.host.calls).toHaveLength(0);
    expect(await refused(r.harness.complete({ generationId: turn.generationId, reply: "x", finish: "stop" }))).toBe("not_found");
  });

  test("something breaking before the main agent begins: the same, and the trace ends with why", async () => {
    const r = rig();
    const path = r.host.chat.path;
    r.host.chat.path = async () => {
      throw new Error("the chat couldn't be read");
    };
    const turn = r.request();
    const prepared = await r.harness.prepare(turn, { replyBy: null }, never);
    r.host.chat.path = path;
    expect(prepared).toMatchObject({ part: "none", pending: false, reason: "the chat couldn't be read" });
    expect(prepared.messages).toBe(turn.messages);
    expect(ended(r.host, turn.generationId)).toMatchObject({ status: "failed", reason: "the chat couldn't be read" });
    expect(notices(r.host, turn.generationId)).toEqual(["LumiAH had no part in this reply (the chat couldn't be read): Lumiverse writes it from its prompt as it was."]);
    // The chat is none the worse: the next turn works.
    const next = r.request();
    expect((await r.harness.prepare(next, { replyBy: null }, never)).part).toBe("brief");
  });

  test("the main agent's model failing: the request goes as it came, and the turn's notes keep the failure", async () => {
    const r = rig([{ error: "401: the key was refused" }]);
    const turn = r.request();
    const prepared = await r.harness.prepare(turn, { replyBy: null }, never);
    expect(prepared.part).toBe("none");
    expect(prepared.messages).toBe(turn.messages);
    expect(prepared.reason).toContain("401: the key was refused");
  });

  test("the user's stop during the first half: nothing waits for a reply Lumiverse won't write", async () => {
    const stop = new AbortController();
    const r = rig((request) => (isMain(request) ? { hang: true } : "never"));
    const turn = r.request();
    const preparing = r.harness.prepare(turn, { replyBy: null }, stop.signal);
    await until(() => r.host.calls.length === 1);
    stop.abort();
    const prepared = await preparing;
    expect(prepared).toMatchObject({ part: "none", pending: false });
    expect(ended(r.host, turn.generationId)).toMatchObject({ status: "stopped" });
  });
});

describe("the chat's own connection", () => {
  test("an agent with no connection set uses the one the turn names; one with its own keeps it", async () => {
    const r = rig();
    await r.harness.prepare(r.request({ connectionId: "conn-writer" }), { replyBy: null }, never);
    expect(r.host.calls[0]?.connectionId).toBe("conn-writer");
    const own = rig(BRIEF, (s) => {
      (s.agents.main as NonNullable<typeof s.agents.main>).connectionId = "conn-main";
    });
    await own.harness.prepare(own.request({ connectionId: "conn-writer" }), { replyBy: null }, never);
    expect(own.host.calls[0]?.connectionId).toBe("conn-main");
    // A turn that names none leaves it to the user's default, as a runtime's turn does.
    const none = rig();
    await none.harness.prepare(none.request(), { replyBy: null }, never);
    expect(none.host.calls[0]?.connectionId).toBeNull();
  });

  test("a chat's job and side session use the chat's own, which the host gives with the chat", async () => {
    const r = rig(["The notes are tidy.", "Nothing to add."]);
    r.host.infos.set(CHAT, { connectionId: "conn-writer" });
    const { job } = await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: "Tidy the notes.", when: "now" });
    await r.harness.jobs.run({ id: job.id }, never);
    expect(r.host.calls[0]?.connectionId).toBe("conn-writer");
  });
});

describe("the writer and the agents' guidance", () => {
  test("off, as it ships, the writer's request holds the brief alone; on, the guidance goes beside it, each level named", async () => {
    const r = rig();
    await r.harness.guidance.set({ chatId: CHAT, level: "user", text: "Keep replies under eighty words.", base: null });
    await r.harness.guidance.set({ chatId: CHAT, level: "chat", text: "Okoro never raises his voice.", base: null });
    const off = await r.harness.prepare(r.request(), { replyBy: null }, never);
    expect(JSON.stringify(off.messages)).not.toContain("Keep replies under eighty words.");
    r.stored.values.reply.writerGuidance = true;
    const on = await r.harness.prepare(r.request(), { replyBy: null }, never);
    const added = on.messages.find((m) => m.source === undefined)?.content ?? "";
    expect(added).toStartWith("[Guidance from the user, for every chat. Follow it.]\nKeep replies under eighty words.\n\n[Guidance for this chat. Follow it.]\nOkoro never raises his voice.\n\n");
    expect(added).toContain("Okoro opens the door a hand's width.");
  });

  test("where a writer of LumiAH's writes, the same setting puts the guidance in its call", async () => {
    const r = rig((request) => (isMain(request) ? { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "w1")] } : "The door opens."));
    await r.harness.guidance.set({ chatId: CHAT, level: "user", text: "Keep replies under eighty words.", base: null });
    await runTurn(r.host, r.harness, CHAT, {});
    expect(JSON.stringify(r.host.calls[1]?.messages)).not.toContain("Keep replies under eighty words.");
    r.stored.values.reply.writerGuidance = true;
    r.host.say(CHAT, "user", "I knock again.");
    await runTurn(r.host, r.harness, CHAT, {});
    const writer = r.host.calls.at(-1)?.messages ?? [];
    expect(writer.some((m) => m.content.startsWith("[Guidance from the user, for every chat. Follow it.]\nKeep replies under eighty words.\n\n") && m.content.includes("Okoro opens the door."))).toBe(true);
  });
});
