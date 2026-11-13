// The runtime's working store as the runtime wires it (PI-BUILD-PLAN §4.4): the core's documents and
// blobs on the runtime's own disk, the extension's storage, over the real link, as their mirror.
// Where they land in the extension's storage (also under a mounting extension's folder); a runtime
// stopped with changes the storage hadn't taken, started again on its folder; another runtime of the
// same name on another folder (a new machine, a wiped disk), which works at once from the mirror;
// a write the extension refuses for good; and what a page view still asks of the extension. Then
// who keeps the copy (one runtime at a time, as the extension says): a second runtime of the user's,
// which works straight on the storage; everything a runtime without a copy still serves, a turn
// among it; the extension started again; and a runtime that loses the mirror with a save under way.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { textHash } from "../../src/core/hash";
import { recordOf } from "../../src/core/sessions";
import { LINK, type LinkRequests } from "../../src/link/contract";
import { isRecord } from "../../src/link/json";
import type { Runtime } from "../../src/runtime/runtime";
import { toolCall } from "../support/fake-host";
import { tempFolder } from "../support/folders";
import { plug } from "../support/plug";
import { BUILD, FAST, PORT, type Rig, rig, runtimeFor, runtimeFrom, until, USER } from "../support/rig";

let r: Rig | null = null;
const also: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of also.splice(0)) await close();
  await r?.close();
  r = null;
});

/** Another runtime started on the rig's registration (or the one given), as `lumiah serve` starts one: on the folder given (its own, after a restart; a new one, on another machine). */
async function started(it: Rig, dir: string, registration = it.registration): Promise<Runtime> {
  const runtime = runtimeFor(it.lumiverse, registration, it.logs, { dir });
  // Its clockwork (pings, reconnects), which `lumiah serve` runs every second, runs every few milliseconds, as the rig runs its own: the two ends talk over queued deliveries, with no one clock a test can move.
  const ticker = setInterval(() => runtime.tick(), 5);
  also.push(async () => {
    clearInterval(ticker);
    runtime.shutdown();
    await runtime.close();
  });
  await runtime.link.connect();
  return runtime;
}

/** A runtime of Mara's other machine: registered on its own, under its own name, on a folder of its own; linked, its clockwork running as the rig's runs. */
async function another(it: Rig, name: string): Promise<Runtime> {
  const registered = await it.lumiverse.raw({ type: "register", name, build: BUILD, host: "laptop", listen: "127.0.0.1", port: PORT + 1 });
  if (registered.type !== "result") throw new Error(`register failed: ${registered.message}`);
  const { relay, secret } = registered.body as LinkRequests["register"]["result"];
  const runtime = runtimeFrom({ name, base: it.lumiverse.base, extension: it.lumiverse.host.identifier, listen: "127.0.0.1", port: PORT + 1, relay, secret, session: { username: "mara", token: it.lumiverse.token, savedAt: 0 }, tuning: FAST }, it.lumiverse, it.logs, { dir: tempFolder() });
  const ticker = setInterval(() => runtime.tick(), 5);
  also.push(async () => {
    clearInterval(ticker);
    runtime.shutdown();
    await runtime.close();
  });
  await runtime.link.connect();
  return runtime;
}

/** Every document the working copy under `dir` holds, by path, as its JSON text. */
function copyDocs(dir: string): Map<string, string> {
  const [copy = ""] = readdirSync(join(dir, "store"));
  const docs = join(dir, "store", copy, "docs");
  const out = new Map<string, string>();
  for (const entry of readdirSync(docs, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name).slice(docs.length + 1);
    out.set(path, readFileSync(join(docs, path), "utf8"));
  }
  return out;
}

describe("the runtime's working store", () => {
  test("mirrors to where the core's documents and blobs have always been kept, and under a mounting extension's folder where it keeps LumiAH's files", async () => {
    const it = (r = await rig({ storage: "harness" }));
    await it.setUp();
    const text = "A transcript of a turn.";
    const hash = await textHash(text);
    await it.runtime.store.store.write("chats/chat-1/session.json", { turns: 1 });
    await it.runtime.store.blobs.put(hash, text);
    await it.mirrored();
    const files = [...it.host.files.keys()];
    expect(it.host.files.get(`${USER}/harness/docs/chats/chat-1/session.json`)).toBe(JSON.stringify({ turns: 1 }));
    expect(it.host.files.get(`${USER}/harness/blobs/${hash.slice(0, 2)}/${hash}`)).toBe(text);
    expect(files).toContain(`${USER}/harness/docs/mirror.json`);
    // Nothing of the core's outside the extension's own folder.
    expect(files.filter((path) => path.startsWith(`${USER}/docs/`) || path.startsWith(`${USER}/blobs/`))).toEqual([]);
  });

  test("stopped with changes the extension's storage hadn't taken, and started again on its folder, loses nothing: the storage then holds what the copy holds", async () => {
    const power = plug();
    const it = (r = await rig({ wire: power.wire }));
    await it.setUp();
    await it.runtime.store.store.write("chats/chat-1/session.json", { turns: 1 });
    await it.mirrored();
    // The process is killed: what it saves from then on stays on its disk, and it never stops in good order.
    power.pull();
    await it.runtime.store.store.write("chats/chat-1/session.json", { turns: 2 });
    await it.runtime.store.store.write("jobs/job-1.json", { state: "running" });
    it.runtime.shutdown();
    await it.runtime.store.close();
    expect(it.host.stored(USER, "docs/jobs/job-1.json")).toBeNull();

    const again = await started(it, it.dir);
    await again.store.settle();
    expect(again.store.state()).toMatchObject({ waiting: 0, takeover: null });
    const held = copyDocs(it.dir);
    expect([...held.keys()].sort()).toEqual(["chats/chat-1/session.json", "jobs/job-1.json"]);
    for (const [path, json] of held) expect(it.host.files.get(`${USER}/docs/${path}`)).toBe(json);
  });

  test("a runtime of the same name on another folder (another machine, a wiped disk) works at once from what the storage holds, and keeps it from then on", async () => {
    const it = (r = await rig());
    await it.setUp();
    const text = "A segment of the session.";
    const hash = await textHash(text);
    await it.runtime.store.store.write("chats/chat-1/session.json", { turns: 3 });
    await it.runtime.store.blobs.put(hash, text);
    await it.close();

    const other = await started(it, tempFolder());
    expect(await other.store.store.read("chats/chat-1/session.json")).toEqual({ turns: 3 });
    expect(await other.store.blobs.get(hash)).toBe(text);
    expect(other.store.state().takeover).toMatchObject({ from: "mara (harbour-box)", dropped: 0 });
    await other.store.store.write("chats/chat-1/session.json", { turns: 4 });
    await other.store.settle();
    expect(it.host.stored(USER, "docs/chats/chat-1/session.json")).toEqual({ turns: 4 });
    expect(it.logs.some((line) => line.includes("this runtime threw its own copy away"))).toBe(true);
  });

  test("a blob the extension refuses for good leaves the store's journal: the settle that covers it is told, the Runtime page's state shows it, and nothing after waits on it", async () => {
    const it = (r = await rig());
    await it.setUp();
    await it.page.request("lah.settings.set", { set: [{ path: ["transport", "link", "joinMaxUnits"], value: 1024 * 1024 }], reset: [] });
    // Past "Largest frame the extension joins" (1 Mi characters here), and past what is sent whole, so it crosses in parts and the extension refuses it.
    const big = "x".repeat(5 * 1024 * 1024);
    const hash = await textHash(big);
    await it.runtime.store.blobs.put(hash, big);
    await expect(it.runtime.store.settle()).rejects.toThrow(`The extension's storage refused the stored text ${hash} for good`);
    await it.runtime.store.store.write("chats/chat-1/session.json", { turns: 1 });
    await it.mirrored();
    const { state } = (await it.page.request("lah.runtime.store", { relay: it.registration.relay })) as { state: { waiting: number; refused: { name: string }[] } };
    expect(state).toMatchObject({ waiting: 0, refused: [{ name: hash }] });
  });

  test("answers a page that lists jobs from its own disk: the same view asked again reads no document of the extension's", async () => {
    const crossings: string[] = [];
    const it = (r = await rig({
      wire: (lumiverse) => ({
        http: lumiverse.http,
        openSocket: (url, events) => {
          const socket = lumiverse.openSocket(url, events);
          return {
            ...socket,
            send: (text: string) => {
              const sent = JSON.parse(text) as { payload?: { link?: string; type?: string } };
              if (sent.payload?.link === LINK && typeof sent.payload.type === "string") crossings.push(sent.payload.type);
              socket.send(text);
            },
          };
        },
      }),
    }));
    const chatId = await it.setUp();
    await it.page.request("lah.jobs.list", { chatId, cursor: null, limit: 10 });
    await it.mirrored();
    crossings.length = 0;
    await it.page.request("lah.jobs.list", { chatId, cursor: null, limit: 10 });
    await until(() => crossings.includes("ask.answer"), "the runtime's answer");
    expect(crossings.filter((type) => type.startsWith("doc.") || type.startsWith("blob."))).toEqual([]);
  });
});

describe("two runtimes of one user and extension", () => {
  test("the one linked second works straight on the storage: neither writes over the other's newer save, each reads the other's, and nothing either saves is dropped (review finding 1)", async () => {
    const it = (r = await rig());
    await it.setUp();
    const path = "jobs/all.json";
    await it.runtime.store.store.write(path, { by: "A", n: 1 });
    await it.mirrored();
    const b = await another(it, "laptop");

    await b.store.store.write(path, { by: "B", n: 2 });
    await b.store.settle();
    expect(it.host.stored(USER, `docs/${path}`)).toEqual({ by: "B", n: 2 });
    // The extension told the runtime that keeps the storage of the other's save as it took it: its next read is the storage's.
    expect(await it.runtime.store.store.read(path)).toEqual({ by: "B", n: 2 });
    await it.runtime.store.store.write(path, { by: "A", n: 3 });
    await it.mirrored();
    expect(it.host.stored(USER, `docs/${path}`)).toEqual({ by: "A", n: 3 });
    expect(await b.store.store.read(path)).toEqual({ by: "A", n: 3 });

    await it.runtime.store.store.write("chats/chat-1/a-only.json", { by: "A" });
    await b.store.store.write("chats/chat-1/b-only.json", { by: "B" });
    await it.mirrored();
    await b.store.settle();
    expect([it.host.stored(USER, "docs/chats/chat-1/a-only.json"), it.host.stored(USER, "docs/chats/chat-1/b-only.json")]).toEqual([{ by: "A" }, { by: "B" }]);
    expect(it.runtime.store.state()).toMatchObject({ mode: "held", takeover: null, lost: null });
    expect(b.store.state()).toMatchObject({ mode: "direct", holder: "mara (harbour-box)", takeover: null, lost: null });
    expect(it.logs.filter((line) => line.includes("threw its own copy away") || line.includes("dropped"))).toEqual([]);
  });
});

describe("a runtime without its own copy (another runtime keeps the storage)", () => {
  test("serves what it served before working copies, straight on the storage: where documents and blobs land (under a mounting extension's folder too), reads, listings, a page of jobs, forgetting a chat; the Runtime page says why", async () => {
    const it = (r = await rig({ storage: "harness", heldElsewhere: "mara (laptop)" }));
    const chatId = await it.setUp();
    const text = "A transcript of a turn.";
    const hash = await textHash(text);
    await it.runtime.store.store.write("chats/chat-1/session.json", { turns: 1 });
    await it.runtime.store.blobs.put(hash, text);
    // Nothing waits to be sent: each went straight to the storage.
    expect(it.host.files.get(`${USER}/harness/docs/chats/chat-1/session.json`)).toBe(JSON.stringify({ turns: 1 }));
    expect(it.host.files.get(`${USER}/harness/blobs/${hash.slice(0, 2)}/${hash}`)).toBe(text);
    expect(await it.runtime.store.store.read("chats/chat-1/session.json")).toEqual({ turns: 1 });
    expect(await it.runtime.store.blobs.get(hash)).toBe(text);
    expect(await it.runtime.store.store.list("chats/chat-1/")).toEqual(["chats/chat-1/session.json"]);
    expect((await it.page.request("lah.jobs.list", { chatId, cursor: null, limit: 10 })).jobs).toEqual([]);
    const { state } = (await it.page.request("lah.runtime.store", { relay: it.registration.relay })) as { state: { mode: string; holder: string | null; waiting: number } };
    expect(state).toMatchObject({ mode: "direct", holder: "mara (laptop)", waiting: 0 });
    expect(await it.runtime.store.forget("chat-1")).toEqual({ documents: 1 });
    expect(it.host.files.has(`${USER}/harness/docs/chats/chat-1/session.json`)).toBe(false);
    // No mark of its own in the storage, nothing on its disk; who keeps the storage is kept per user and per extension, under the mounting extension's folder.
    expect([...it.host.files.keys()].filter((path) => path.endsWith("/mirror.json"))).toEqual([]);
    expect(readdirSync(it.dir, { recursive: true }).filter((path) => String(path).includes("docs/"))).toEqual([]);
    expect(JSON.parse(it.host.files.get(`${USER}/harness/mirror-holder.json`) ?? "null")).toMatchObject({ holder: { owner: "mara (laptop)" } });
  });

  test("answers a turn end to end: the reply streams back, its record goes on the message, and what it names is in the storage", async () => {
    const it = (r = await rig({ heldElsewhere: "mara (laptop)" }));
    const chatId = await it.setUp();
    it.host.script = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." })] }, "Okoro keeps it now."];
    const out = await it.generate(chatId);
    expect(out).toMatchObject({ status: 200, error: null, content: "Okoro keeps it now." });
    const reply = it.host.message(chatId, out.messageId ?? "");
    await until(() => reply.own !== null, "the reply's record");
    const own = reply.own;
    const record = isRecord(own) && isRecord(own.swipes) ? recordOf(own.swipes["0"]) : null;
    expect(record?.generationId).toBe(out.generationId);
    expect(it.host.files.has(`${USER}/blobs/${record?.segment.slice(0, 2)}/${record?.segment}`)).toBe(true);
    expect(it.runtime.store.state()).toMatchObject({ mode: "direct", waiting: 0 });
  });
});

describe("who keeps the copy, over the real link", () => {
  test("the extension started again: the runtime that kept the copy keeps it, the other still works without one", async () => {
    const it = (r = await rig());
    await it.setUp();
    await it.runtime.store.store.write("chats/chat-1/session.json", { turns: 1 });
    await it.mirrored();
    const b = await another(it, "laptop");
    await it.restart();
    // Every runtime says hello to the new worker; whichever comes first, the copy stays where it was.
    await until(() => it.backend.relays.isLinked(USER, it.registration.relay), "the runtime to link again");
    await b.store.store.write("chats/chat-1/session.json", { turns: 2 });
    expect(await it.runtime.store.store.read("chats/chat-1/session.json")).toEqual({ turns: 2 });
    expect(it.runtime.store.state()).toMatchObject({ mode: "held", takeover: null, lost: null });
    expect(b.store.state()).toMatchObject({ mode: "direct", lost: null });
  });

  test("a runtime that loses the copy with a save under way: the extension refuses that save as the copy's, the runtime stops using its copy, sends the save straight (no other runtime saved the file since), and the next save goes straight to the storage too", async () => {
    const held: string[] = [];
    let holding = false;
    const socketOf: { send: ((text: string) => void) | null } = { send: null };
    const it = (r = await rig({
      wire: (lumiverse) => ({
        http: lumiverse.http,
        openSocket: (url, events) => {
          const socket = lumiverse.openSocket(url, events);
          socketOf.send = (text) => socket.send(text);
          return { ...socket, send: (text: string) => (holding && text.includes('"type":"doc.put"') ? void held.push(text) : socket.send(text)) };
        },
      }),
    }));
    await it.setUp();
    await it.mirrored();
    // Its save is on its way to the storage when another process on its registration, started on a copy of its folder (the same copy), says hello.
    const copied = tempFolder();
    await cp(it.dir, copied, { recursive: true });
    holding = true;
    await it.runtime.store.store.write("chats/chat-1/session.json", { turns: 1 });
    await until(() => held.length === 1, "the save to be on its way");
    const settled = it.runtime.store.settle().then(
      () => "done",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const other = await started(it, copied);
    await until(() => it.runtime.store.state().mode === "direct", "the runtime to stop using its copy");
    holding = false;
    for (const text of held.splice(0)) socketOf.send?.(text);
    expect(await settled).toBe("done");
    expect(it.host.stored(USER, "docs/chats/chat-1/session.json")).toEqual({ turns: 1 });
    expect(it.runtime.store.state()).toMatchObject({ mode: "direct", lost: { dropped: 0 } });
    expect(await other.store.store.read("chats/chat-1/session.json")).toEqual({ turns: 1 });
    await it.runtime.store.store.write("chats/chat-1/session.json", { turns: 2 });
    expect(it.host.stored(USER, "docs/chats/chat-1/session.json")).toEqual({ turns: 2 });
    expect(await other.store.store.read("chats/chat-1/session.json")).toEqual({ turns: 2 });
    expect(other.store.state()).toMatchObject({ mode: "held" });
  });
});

/** `lumiah up` registering the rig's runtime anew under its name, as it does given another address or account (it doesn't show the secret the runtime holds then): the same registration, a new secret. */
async function registerAnew(it: Rig): Promise<{ relay: string; secret: string }> {
  const registered = await it.lumiverse.raw({ type: "register", name: "mara", build: BUILD, host: "harbour-box", listen: "127.0.0.1", port: PORT });
  if (registered.type !== "result") throw new Error(`register failed: ${registered.message}`);
  const { relay, secret } = registered.body as LinkRequests["register"]["result"];
  return { relay, secret };
}

// Registered anew by `lumiah up`, or forgotten on the Runtime page, a running runtime's secret speaks
// for nothing, while its link looks up until its next ping hears so. Its stop then has nobody to
// settle with: it doesn't wait the Storage wait (a minute) for them, and what it saved stays on its
// disk for the next runtime on its folder.
describe("a runtime the extension no longer knows", () => {
  test("registered anew while its store still opens: it stops at once, and what it had saved reaches the storage from the runtime started on the new registration", async () => {
    const power = plug();
    const it = (r = await rig({ wire: power.wire }));
    await it.setUp();
    await it.runtime.store.store.write("chats/chat-1/session.json", { turns: 1 });
    await it.mirrored();
    // The process dies with a save the storage hadn't taken: it waits on the runtime's disk.
    power.pull();
    await it.runtime.store.store.write("chats/chat-1/session.json", { turns: 2 });
    it.runtime.shutdown();
    await it.runtime.store.close();

    // Started again on its folder, it says hello and is given the storage back; the hello's answer is on its way when `lumiah up` registers the runtime anew.
    let helloHeld = false;
    it.lumiverse.holds = (frame) => {
      const hello = frame.type === "result" && isRecord(frame.body) && isRecord(frame.body.mirror);
      if (hello) helloHeld = true;
      return hello;
    };
    const again = runtimeFor(it.lumiverse, it.registration, it.logs, { dir: it.dir });
    // Its clockwork, as `started` runs it: the two ends talk over queued deliveries, with no one clock a test can move.
    const ticker = setInterval(() => again.tick(), 5);
    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      clearInterval(ticker);
      again.shutdown();
      await again.close();
    };
    also.push(stop);
    const linking = again.link.connect();
    await until(() => helloHeld, "the hello's answer on its way");
    const anew = await registerAnew(it);
    it.lumiverse.holds = () => false;
    it.lumiverse.letGo();
    await linking;
    // Its store reads the storage's mark to open its copy, and the extension refuses it.
    await until(() => again.store.state().lastError?.words.includes("doesn't know this runtime") === true, "its store to be refused");
    expect([again.store.state().mode, again.link.up]).toEqual(["opening", true]);

    const from = Date.now();
    await stop();
    expect(Date.now() - from).toBeLessThan(5_000);
    expect(it.host.stored(USER, "docs/chats/chat-1/session.json")).toEqual({ turns: 1 });

    // Nothing it saved is lost: the runtime started on the new registration, on the same folder, sends it.
    const next = await started(it, it.dir, anew);
    await next.store.settle();
    expect(it.host.stored(USER, "docs/chats/chat-1/session.json")).toEqual({ turns: 2 });
  }, 30_000);

  test("forgotten with a save on its way to the storage: it stops at once, and the save waits on its disk", async () => {
    const it = (r = await rig());
    await it.setUp();
    await it.runtime.store.store.write("chats/chat-1/session.json", { turns: 1 });
    await it.mirrored();
    await it.page.request("lah.relay", { op: "forget", relay: it.registration.relay });
    // Taken on the runtime's disk, the save goes to the storage, which refuses it.
    await it.runtime.store.store.write("chats/chat-1/session.json", { turns: 2 });
    await until(() => it.runtime.store.state().lastError?.words.includes("doesn't know this runtime") === true, "the save to be refused");
    expect(it.runtime.link.up).toBe(true);

    const from = Date.now();
    await it.close();
    r = null;
    expect(Date.now() - from).toBeLessThan(5_000);
    expect(it.host.stored(USER, "docs/chats/chat-1/session.json")).toEqual({ turns: 1 });
    expect(JSON.parse(copyDocs(it.dir).get("chats/chat-1/session.json") ?? "null")).toEqual({ turns: 2 });
  }, 30_000);
});
