// A runtime's update from the extension, end to end (PI-BUILD-PLAN §4.8): the extension offers its
// own copy of the runtime, and nothing a page or another user gives, to a runtime that says hello on
// another build; the runtime takes it by itself only once no reply or job is under way, and at once
// from the Runtime page's button, whose answer says what that ended; only the runtime's own user
// may ask it anything; a new worker asks the runtimes linked to it to say hello at once; and a
// runtime back on the new build shows it on the page without a reload.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentUsage } from "../../src/core/ports";
import type { RuntimeConfig } from "../../src/runtime/config";
import type { Runtime } from "../../src/runtime/runtime";
import { UiFailure } from "../support/fake-lumiverse";
import { FAST, type Rig, rig, runtimeFor, until, USER } from "../support/rig";
import { NEW, SOURCE, sha256, type Updating, updating } from "../support/update";

const USAGE: AgentUsage = { calls: 1, toolTurns: 0, in: 10, cachedIn: 0, out: 5, reasoningOut: 0, estimated: false, ms: 1 };
const CONFIG: RuntimeConfig = { name: "mara", base: "http://127.0.0.1:7860", extension: "lumi_ah", listen: "127.0.0.1", port: 7871, relay: "", secret: "", session: { username: "mara", token: "", savedAt: 0 }, tuning: FAST };
const OFFER = { build: "next-build", path: SOURCE, sha256: sha256(NEW) };
const JOB = { id: "job-harbour", chatId: "chat-of-job", state: "queued", when: "now", agent: "main", task: "Map the harbour." };

let open: Rig | null = null;
const also: Runtime[] = [];
afterEach(async () => {
  for (const runtime of also.splice(0)) {
    runtime.shutdown();
    await runtime.close();
  }
  await open?.close();
  open = null;
});

/** A runtime on the build before the extension's, set up from the extension's copy, answering its reply and its one job (`job`: one the core had queued, started once the link is up) only when the test lets them end. */
async function behind(options: { shipped?: boolean; job?: boolean } = {}) {
  const reply = Promise.withResolvers<void>();
  const job = Promise.withResolvers<void>();
  const u: Updating = updating(CONFIG);
  const it = (open = await rig({
    build: "old-build",
    update: u.update,
    ...(options.shipped === true ? { shipped: { sha256: sha256(NEW), size: NEW.length } } : {}),
    harness: () => ({
      answer: async (_turn, sink) => {
        await reply.promise;
        sink.content("Okoro keeps it now.");
        sink.done("stop", USAGE);
        return { status: "done", record: null, reply: "Okoro keeps it now.", usage: USAGE };
      },
      jobs: {
        run: async () => job.promise,
        recover: async () => ({ interrupted: [], paused: [], queued: options.job === true ? [JOB] : [] }),
      },
    }),
  }));
  return { it, u, reply, job };
}

/** The pushes the extension sent of one type. */
const sentOf = (it: Rig, type: string): unknown[] => it.host.sent.flatMap((s) => (typeof s.message === "object" && s.message !== null && "type" in s.message && s.message.type === type ? [s.message] : []));

describe("the extension's offer", () => {
  test("goes to a runtime that says hello on another build: the extension's own copy and hash; taken at once when nothing is under way", async () => {
    const { it, u } = await behind({ shipped: true });
    await it.runtime.link.connect();
    await until(() => u.left.length === 1, "the runtime to leave for its new build");
    // The copy it runs is the extension's build now, checked first that it starts.
    expect(u.files.get("/home/mara/.local/share/lumiah/lumiah.js")).toBe(NEW);
    expect(u.ran).toEqual(["/opt/bun/bin/bun /home/mara/.local/share/lumiah/lumiah.js.mara.tmp --version"]);
    expect(u.left).toEqual([{ command: "/opt/bun/bin/bun", args: ["/home/mara/.local/share/lumiah/lumiah.js", "serve", "--config", "/home/mara/.config/lumiah/mara.json"] }]);
    // Offered on the runtime's own session, naming the file beside the extension's backend and the hash its build wrote in.
    expect(sentOf(it, "update")).toEqual([{ link: expect.any(String), type: "update", build: "test-build", path: SOURCE, sha256: sha256(NEW) }]);
  });

  test("isn't made by a development build, which carries no hash", async () => {
    const { it, u } = await behind();
    await it.runtime.link.connect();
    await it.backend.settle();
    expect(sentOf(it, "update")).toEqual([]);
    expect(it.runtime.update.get()).toMatchObject({ waiting: null, problem: null });
    expect(u.left).toEqual([]);
  });
});

describe("an update by itself", () => {
  test("waits while a reply is under way, and is taken once the runtime is idle", async () => {
    const { it, u, reply } = await behind();
    const chatId = await it.setUp();
    const generating = it.generate(chatId);
    await until(() => it.runtime.turns.count === 1, "the reply to be under way");
    expect(await it.runtime.update.offer(OFFER)).toEqual({ taken: "waiting" });
    for (let i = 0; i < 20; i++) await it.runtime.update.tick();
    expect(u.left).toEqual([]);
    expect(it.runtime.update.get()).toMatchObject({ waiting: { build: "next-build" }, busy: true });
    reply.resolve();
    expect(await generating).toMatchObject({ status: 200, content: "Okoro keeps it now." });
    await until(() => u.left.length === 1, "the update to be taken once the reply ended");
  });

  test("waits while a job runs, and is taken once it has ended", async () => {
    const { it, u, job } = await behind({ job: true });
    await it.runtime.link.connect();
    await until(() => it.runtime.work.runs().jobs === 1, "the queued job to run");
    expect(await it.runtime.update.offer(OFFER)).toEqual({ taken: "waiting" });
    for (let i = 0; i < 20; i++) await it.runtime.update.tick();
    expect(u.left).toEqual([]);
    job.resolve();
    await until(() => it.runtime.work.ids().length === 0, "the job to end");
    await until(() => u.left.length === 1, "the update to be taken once the job ended");
  });
});

describe("the Runtime page", () => {
  test("its Update now takes the update at once, and its answer says what that ended", async () => {
    const { it, u } = await behind();
    const chatId = await it.setUp();
    void it.generate(chatId);
    await until(() => it.runtime.turns.count === 1, "the reply to be under way");
    await it.runtime.update.offer(OFFER);
    const relay = it.registration.relay;

    expect((await it.page.request("lah.runtime.service.get", { relay })).service).toMatchObject({ waiting: { build: "next-build" }, busy: true, underWay: { replies: 1, jobs: 0 } });
    const done = await it.page.request("lah.runtime.update.apply", { relay });
    expect(done.cut).toMatchObject({ replies: 1, jobs: 0, sides: 0 });
    expect(done.service).toMatchObject({ updating: true, waiting: null });
    expect(u.left).toHaveLength(1);
  });

  test("changes only its own user's runtime: another user's page can't update it, restart it or change its memory", async () => {
    const { it, u } = await behind();
    await it.setUp();
    const relay = it.registration.relay;
    // Its own user takes updates from the button only, so the offer waits there.
    expect((await it.page.request("lah.runtime.service.set", { relay, autoUpdate: false })).service.autoUpdate).toBe(false);
    expect(await it.runtime.update.offer(OFFER)).toEqual({ taken: "waiting" });
    const theirs = it.lumiverse.page("user-brann");
    for (const asked of [theirs.request("lah.runtime.update.apply", { relay }), theirs.request("lah.runtime.service.set", { relay, memory: "256M", restart: true }), theirs.request("lah.runtime.service.get", { relay })]) {
      const refused = await asked.then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(UiFailure);
      expect(refused).toMatchObject({ error: { code: "unavailable", message: "That runtime isn't linked now. Start it (its line is on LumiAH's Runtime page) and try again." } });
    }
    expect(u.left).toEqual([]);
    expect(u.config().memory).toBe("1G");
    expect(it.runtime.update.get()).toMatchObject({ waiting: { build: "next-build" }, updating: false });
    // Its own user's page may.
    expect((await it.page.request("lah.runtime.service.set", { relay, memory: "768M" })).service.memory).toBe("768M");
  });

  test("shows the new build once the runtime is back on it, without a reload", async () => {
    const { it } = await behind();
    await it.page.request("lah.hello", {});
    await it.runtime.link.connect();
    const shows = (build: string, update: boolean): boolean => it.page.pushes.some((p) => p.type === "lah.state" && (p.patch.runtime?.relays.some((r) => r.build === build && r.update === update) ?? false));
    await until(() => shows("old-build", true), "the page to show the build before");
    // The runtime restarts on the extension's build: its hello says so.
    it.runtime.shutdown();
    await it.runtime.close();
    const back = runtimeFor(it.lumiverse, it.registration, [], {});
    also.push(back);
    await back.link.connect();
    await until(() => shows("test-build", false), "the page to show the new build");
  });
});

describe("a new worker", () => {
  test("asks the runtimes linked to it to say hello at once, so pages don't say none is linked until the next ping", async () => {
    const it = (open = await rig({ tuning: { heartbeatMs: 3_600_000 } }));
    await it.runtime.link.connect();
    await it.restart();
    expect(it.backend.relays.isLinked(USER, it.registration.relay)).toBe(false);
    await until(() => it.backend.relays.isLinked(USER, it.registration.relay), "the runtime to say hello to the new worker");
    expect((await it.backend.runtimeState(USER)).linked).toBe(true);
  });
});
