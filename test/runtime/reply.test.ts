// The runtime, which every chat needs (DESIGN §6, §21): the engine writes the reply itself, so each
// released passage and a character's answer handed on reach Lumiverse as one reply, in order, each
// as it is released; Stop ends the turn wherever it is and tells the extension what had been
// released; with no runtime linked a chat's reply fails in plain words and nothing answers in the
// runtime's place; a restart mid-turn ends the reply in plain words and the chat goes on; a dropped
// link comes back by itself; and a refused link version says which side to update and how. Each
// test runs the real runtime, the real backend and the core's own harness over the fake Lumiverse,
// with a scripted model behind the backend.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../../src/core/agents";
import type { AgentModelAsk, ReplyRelease, RunEnded } from "../../src/core/extension";
import type { RemoteToolCall } from "../../src/core/ports";
import { defaultSettings } from "../../src/core/settings";
import type { BackendOptions } from "../../src/extension/backend/backend";
import { LINK_VERSION, type LinkRequests, versionWords } from "../../src/link/contract";
import type { Runtime } from "../../src/runtime/runtime";
import { bare, cast, offers, told } from "../support/cast";
import { toolCall } from "../support/fake-host";
import { plug } from "../support/plug";
import { PORT, type Rig, rig, runtimeFor, until, USER } from "../support/rig";

let r: Rig | null = null;
/** What a test started beside the rig, stopped with it. */
const also: (() => void)[] = [];
afterEach(() => {
  for (const stop of also.splice(0)) stop();
  r?.close();
  r = null;
});

const AUTHOR = "You are the harbour's author. Release the reply yourself, a passage at a time.";
const OKORO = "You are Okoro, who keeps the harbour light. Answer as Okoro, in his own words.";
const LOG = "Okoro lit the lamp at dusk.";
const KEPT_BACK = "That passage tells what Mara can't know.";

/** What the sample extension heard. */
interface Heard {
  ended: RunEnded[];
  asked: ReplyRelease[];
  released: ReplyRelease[];
  models: AgentModelAsk[];
  tools: RemoteToolCall[];
}

/**
 * An extension that plays the harbour's chats itself, as LumiRPEngine does: its author is the main
 * agent of every chat it claims and releases the reply passage by passage, and Okoro is a character
 * the author hands the reply to. It keeps back a passage that says "[kept back]", and hears each
 * release, each agent's start, each call of its tool and each turn's end.
 */
function harbourPlay(): { options: BackendOptions; heard: Heard } {
  const heard: Heard = { ended: [], asked: [], released: [], models: [], tools: [] };
  const base = defaultSettings().agents.main as AgentDefinition;
  // A sub-agent is handed only tools its delegator holds (Settings' delegation grant), so the author holds the lamp log it lets Okoro read.
  const author: AgentDefinition = { ...base, id: "author", name: "Author", description: "Plays the harbour's story.", instructions: AUTHOR, given: "request", tools: ["reply_write", "delegate", "lamp_log"] };
  const okoro: AgentDefinition = { ...base, id: "okoro", name: "Okoro", description: "Okoro, who keeps the light.", instructions: OKORO, given: "task", tools: ["lamp_log"] };
  return {
    heard,
    options: {
      identity: { identifier: "harbour_play", name: "Harbour Play", connectionName: "Harbour Play loopback" },
      extension: {
        name: "Harbour Play",
        definitions: async () => ({ agents: [author, okoro] }),
        claim: async () => ({ mainAgent: "author", reply: "released" as const }),
        agentModel: async (ask) => {
          heard.models.push(ask);
          return null;
        },
        releasing: async (release) => {
          heard.asked.push(release);
          return release.text.includes("[kept back]") ? { refused: KEPT_BACK } : null;
        },
        released: async (release) => void heard.released.push(release),
        runEnded: async (run) => void heard.ended.push(run),
      },
      tools: {
        list: async () => [{ name: "lamp_log", family: "lamp", tier: "read", description: "The lamp room's log.", parameters: { type: "object", properties: {} }, source: "extension" }],
        call: async (call) => {
          heard.tools.push(call);
          return { text: LOG };
        },
      },
    },
  };
}

describe("the reply a runtime streams", () => {
  test("is two released pieces and a character's answer handed on, reaching Lumiverse as one reply, in order, each as it is released", async () => {
    const sample = harbourPlay();
    const it = (r = await rig({ backend: sample.options }));
    const chatId = await it.setUp();
    // A handed-on answer streams as it is generated: nothing of it is held back first.
    await it.page.request("lah.settings.set", { set: [{ path: ["core", "delegation", "replyHoldChars"], value: 0 }], reset: [] });
    const FIRST = "The lamp room is cold. ";
    const SECOND = "Okoro looks up from the log. ";
    const SAYS = ["“I lit it ", "at dusk, ", "as always.”"];
    const pieces: string[] = [];
    /** What had reached Lumiverse of the reply when Okoro was first asked. */
    const seen: { before: string | null } = { before: null };
    const play = cast(
      {
        name: "okoro",
        is: told(OKORO),
        lines: [
          () => {
            seen.before = pieces.join("");
            return { toolCalls: [toolCall("lamp_log", {}, "log_1")] };
          },
          { deltas: SAYS, content: SAYS.join("") },
        ],
      },
      {
        name: "author",
        is: told(AUTHOR),
        lines: [
          { toolCalls: [toolCall("reply_write", { text: FIRST }, "w1")] },
          { toolCalls: [toolCall("reply_write", { text: "Mara knows the keeper lies. [kept back]" }, "w2")] },
          { toolCalls: [toolCall("reply_write", { text: SECOND }, "w3")] },
          { toolCalls: [toolCall("delegate", { agent: "okoro", task: "Mara asks who lit the lamp. Answer her.", as: "okoro", to_reply: true }, "d1")] },
          "The scene rests with Mara.",
        ],
      },
    );
    it.host.script = play.script;

    const out = await it.generate(chatId, { onPiece: (text) => void pieces.push(text) });

    expect(out.error).toBeNull();
    expect(out.finish).toBe("stop");
    // One reply: the first passage, the second, then Okoro's words, in that order. The passage the extension kept back and the author's last answer are no part of it.
    expect(out.content).toBe(`${FIRST}${SECOND}${SAYS.join("")}`);
    expect(pieces.join("")).toBe(out.content);
    // Each passage went out as it was released: both had reached Lumiverse before Okoro was asked, and his answer came piece by piece as he gave it.
    expect(seen.before).toBe(`${FIRST}${SECOND}`);
    expect(pieces.slice(-SAYS.length)).toEqual(SAYS);
    // The thinking block said what the agents were doing.
    expect(out.reasoning).toContain("delegate");

    // The author was told why one passage didn't go, the extension was asked about each passage, and it heard each release in order, and the turn's end with the reply whole.
    // Its third call is the first to hold the second passage's answer.
    expect(JSON.stringify(play.calls("author")[2]?.messages ?? [])).toContain(KEPT_BACK);
    expect(sample.heard.asked.map((a) => a.text)).toEqual([FIRST, "Mara knows the keeper lies. [kept back]", SECOND]);
    await until(() => sample.heard.ended.length === 1, "the turn's end");
    expect(sample.heard.released.map((a) => a.text)).toEqual([FIRST, SECOND, SAYS.join("")]);
    expect(sample.heard.ended[0]).toMatchObject({ userId: USER, chatId, status: "done", reply: out.content });

    // Over the link, the extension's backend was asked which model each agent runs on, and its tool was told which character called it.
    expect(sample.heard.models).toContainEqual(expect.objectContaining({ chatId, definition: "okoro", as: "okoro", standing: "sub" }));
    expect(sample.heard.tools).toMatchObject([{ name: "lamp_log", role: "okoro", as: "okoro", main: false, above: [{ role: "author" }] }]);
  });

  test("ends where Stop is pressed, and the turn's end tells the extension what had been released", async () => {
    const sample = harbourPlay();
    const it = (r = await rig({ backend: sample.options }));
    const chatId = await it.setUp();
    const PASSAGE = "The lamp room is cold. ";
    const play = cast({ name: "author", is: told(AUTHOR), lines: [{ toolCalls: [toolCall("reply_write", { text: PASSAGE }, "w1")] }, { hang: true }] });
    it.host.script = play.script;

    const stop = new AbortController();
    const pieces: string[] = [];
    const generating = it.generate(chatId, { signal: stop.signal, onPiece: (text) => void pieces.push(text) });
    await until(() => pieces.join("") === PASSAGE && play.calls("author").length === 2, "the passage to reach Lumiverse, and the author to work on");
    // Lumiverse's own Stop, while the author works on the next passage.
    stop.abort();
    const out = await generating;

    // What the user saw stays: the passage, and nothing failed.
    expect(out.error).toBeNull();
    expect(out.content).toBe(PASSAGE);
    expect(it.host.message(chatId, it.host.chatList.get(chatId)?.messages.at(-1)?.id ?? "").swipes.at(-1)).toBe(PASSAGE);
    // The turn ended there, its call under way with it, and the extension was told the reply it released.
    await until(() => sample.heard.ended.length === 1, "the turn's end");
    expect(sample.heard.ended[0]).toMatchObject({ chatId, status: "stopped", reply: PASSAGE });
    expect(it.host.cancelled).toBe(1);
  });
});

describe("a chat whose runtime is gone", () => {
  test("says so in its view and in the extension's runtime state, in plain words; its reply fails, the user told first, and nothing answers in the runtime's place", async () => {
    const sample = harbourPlay();
    const power = plug();
    const it = (r = await rig({ backend: sample.options, wire: power.wire }));
    await it.setUp();
    const chat = it.host.addChat(USER, "The lamp room");
    it.host.say(chat.id, "user", "Who lit the lamp?");

    // Switched on, it is pinned to the loopback connection, and the extension reads its runtime as ready.
    const on = (await it.page.request("lah.chat.set", { chatId: chat.id, on: true })).chat;
    expect(on).toMatchObject({ on: true, connection: { loopback: true } });
    expect(it.host.chatList.get(chat.id)?.metadata.connection_profile_id).toBe(on.connection?.id);
    expect(await it.backend.runtimeState(USER, chat.id)).toMatchObject({ linked: true, ready: true, connection: true, words: null });

    // The runtime's process goes away.
    const heard: string[] = [];
    it.backend.onRuntime((userId) => void heard.push(userId));
    power.pull();
    await until(() => !it.backend.relays.isLinked(USER, it.registration.relay), "the runtime's link to be gone");
    expect(heard).toContain(USER);
    // The chat's view says so, still pinned to the runtime; and the extension reads the same in plain words.
    expect((await it.page.request("lah.chat.get", { chatId: chat.id })).chat).toMatchObject({ on: true, away: true, connection: { loopback: true } });
    const state = await it.backend.runtimeState(USER, chat.id);
    expect(state).toMatchObject({ linked: false, ready: false, connection: true });
    expect(state.words).toContain("Start it again");
    expect(state.start.service).toContain("up --url");

    // A reply: the user is told before it fails; nothing answers at the loopback's address, so Lumiverse fails it.
    const out = await it.lumiverse.generate(
      async () => {
        throw new TypeError("Unable to connect. Is the computer able to access the url?");
      },
      chat.id,
      { key: it.key, port: PORT },
    );
    expect(out.status).not.toBe(200);
    expect(out.error?.message).toContain("Unable to connect");
    await it.backend.settle();
    expect(it.host.toasts.map((t) => t.text)).toContain("Harbour Play's runtime isn't answering, so this reply will fail. Start the runtime (its line is on Harbour Play's Runtime page), then send your message again.");
    // Nothing stood in for the runtime: no prompt went to Lumiverse's own generation, and no model was called for the chat.
    expect(it.lumiverse.provided).toEqual([]);
    expect(it.host.calls).toEqual([]);
  });
});

describe("a runtime fit to be required", () => {
  test("restarted mid-turn ends that reply in plain words, and the chat's next reply is answered once the runtime is back", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    const play = cast({ name: "main", is: offers("write_reply"), lines: [{ hang: true }, { toolCalls: [toolCall("write_reply", { brief: "Okoro keeps it." }, "r1")] }] }, { name: "writer", is: bare, lines: ["Okoro keeps it now."] });
    it.host.script = play.script;
    const first = it.generate(chatId);
    await until(() => play.calls("main").length === 1, "the turn to be under way");

    // Its service restarts it: what it has under way ends in words the chat shows, then it stops.
    it.runtime.shutdown();
    const cut = await first;
    expect(cut.error).toEqual({ message: "The runtime is restarting. Press Retry in a moment.", code: "unavailable" });
    it.runtime.close();

    // The service starts it again from the same config: it links, and the chat's next reply is answered.
    const again: Runtime = runtimeFor(it.lumiverse, it.registration, it.logs);
    // Its own clockwork (pings, reconnects), which `lumiah serve` runs every second and the rig every few milliseconds: the two ends talk over queued deliveries, with no one clock to move by hand.
    const ticker = setInterval(() => again.tick(), 5);
    also.push(() => {
      clearInterval(ticker);
      again.shutdown();
      again.close();
    });
    await again.link.connect();
    const next = await it.lumiverse.generate(again.fetch, chatId, { key: it.key, port: PORT });
    expect(next.error).toBeNull();
    expect(next.content).toBe("Okoro keeps it now.");
  });

  test("links again by itself after Lumiverse drops its socket, and answers the chat's next reply", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.lumiverse.dropSockets();
    await until(() => it.logs.some((line) => line.startsWith("linked again")), "the runtime to link again by itself");
    expect(it.backend.relays.isLinked(USER, it.registration.relay)).toBe(true);

    it.host.script = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." })] }, "Okoro keeps it now."];
    const out = await it.generate(chatId);
    expect(out.error).toBeNull();
    expect(out.content).toBe("Okoro keeps it now.");
  });

  test("refused for its link version, is said to be so, with which side to update and how, to the extension's own pages too", async () => {
    // The rig's own runtime has no way to Lumiverse: the only runtime that says hello is the old one.
    const power = plug();
    const it = (r = await rig({ wire: power.wire }));
    power.pull();
    const registered = await it.lumiverse.raw({ type: "register", name: "old", build: "older-build", host: "harbour-box", listen: "127.0.0.1", port: 7872 });
    if (registered.type !== "result") throw new Error("register failed");
    const { secret } = registered.body as LinkRequests["register"]["result"];
    const refused = await it.lumiverse.raw({ type: "hello", secret, version: LINK_VERSION - 1, build: "older-build", report: { name: "old", build: "older-build", runtime: { bun: "/opt/bun/bin/bun", script: "/home/mara/.local/share/lumiah/lumiah.js", unit: "lumiah-old.service" }, host: "harbour-box", listen: "127.0.0.1", port: 7872, scheduler: "unknown", session: { valid: true, expiresAt: null, checkedAt: null }, turns: 0 }, open: [] });
    expect(refused).toMatchObject({ type: "error", code: "version" });

    const state = await it.backend.runtimeState(USER);
    expect(state.linked).toBe(false);
    expect(state.words).toBe(versionWords(LINK_VERSION - 1, LINK_VERSION));
    expect(state.words).toContain("update the runtime by running its start line on LumiAH's Runtime page again");
  });
});

describe("an agent with no connection of its own, in a chat that plays in the runtime", () => {
  test("runs on the connection the chat was on before its pin, else on the one selected in Lumiverse, though the account has no default; with none, the reply fails naming all three", async () => {
    const it = (r = await rig());
    // No connection of the account's is its default, as on the test bed.
    for (const c of it.host.connectionList) c.isDefault = false;
    it.host.addConnection({ id: "conn-own", name: "Own", provider: "openai", model: "model-own", isDefault: false });
    await it.runtime.link.connect();
    it.key = (await it.page.request("lah.key", { op: "mint" })).key ?? "";
    const chat = it.host.addChat(USER, "Harbour light");
    chat.metadata.connection_profile_id = "conn-own";
    it.host.say(chat.id, "user", "Who keeps the harbour light now?");
    await it.page.request("lah.chat.set", { chatId: chat.id, on: true });
    it.host.script = [
      { toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." })] },
      "Okoro keeps it now.",
      { toolCalls: [toolCall("write_reply", { brief: "Brann sells mackerel." })] },
      "Brann sells mackerel on market day.",
    ];

    const out = await it.generate(chat.id);
    expect(out.error).toBeNull();
    expect(out.content).toBe("Okoro keeps it now.");
    // The main agent and the writer both ran on the chat's own earlier connection, never the loopback it is pinned to now.
    expect(it.host.calls.map((c) => (c.kind === "call" ? c.request.connectionId : "passed"))).toEqual(["conn-own", "conn-own"]);

    // A chat that had no connection of its own before its pin ran on the one selected in Lumiverse, so its agents run on that one.
    const bare = it.host.addChat(USER, "The fish market");
    it.host.say(bare.id, "user", "What does Brann sell on market day?");
    await it.page.request("lah.chat.set", { chatId: bare.id, on: true });
    it.host.select(USER, "conn-own");
    const selected = await it.generate(bare.id);
    expect(selected.error).toBeNull();
    expect(selected.content).toBe("Brann sells mackerel on market day.");
    expect(it.host.calls.slice(2).map((c) => (c.kind === "call" ? c.request.connectionId : "passed"))).toEqual(["conn-own", "conn-own"]);

    // With nothing selected either, on an account with no default: nothing runs, and the words name all three.
    it.host.select(USER, null);
    it.host.say(bare.id, "user", "And on the feast day?");
    const failed = await it.generate(bare.id);
    expect(failed.error?.message ?? "").toContain("it has none of its own, its chat had none before it was set to play in the runtime, no connection is selected in Lumiverse, and Lumiverse has no default connection");
    expect(it.host.calls).toHaveLength(4);
  });
});

describe("a backend that switches its chats on in its own pages", () => {
  test("names itself on the Runtime view, pins its chats to the runtime like any, and its runtime's health names it", async () => {
    const it = (r = await rig({ backend: { identity: { identifier: "harbour_play", name: "Harbour Play", connectionName: "Harbour Play loopback" }, ownSwitch: true } }));
    const chatId = await it.setUp();
    expect((await it.page.request("lah.hello", {})).runtime.switchedBy).toBe("Harbour Play");
    expect((await it.page.request("lah.chat.get", { chatId })).chat).toMatchObject({ on: true, connection: { loopback: true } });
    const health = await it.runtime.fetch(new Request(`http://127.0.0.1:${PORT}/healthz`, { headers: { host: `127.0.0.1:${PORT}` } }));
    expect(await health.json()).toMatchObject({ link: "up", backend: "Harbour Play" });
  });
});

describe("a backend that leaves built-in agents out", () => {
  test("lists them nowhere, and job_start and delegate in a runtime turn are told they aren't offered here", async () => {
    const it = (r = await rig({ backend: { withoutAgents: ["chronicler", "story-reader"] } }));
    const chatId = await it.setUp();
    const listed = (await it.page.request("lah.defs.get", {})).agents.map((a) => a.id);
    expect(listed).toContain("summarizer");
    expect(listed).not.toContain("chronicler");
    expect(listed).not.toContain("story-reader");
    it.host.script = [
      { toolCalls: [toolCall("job_start", { agent: "chronicler", task: "Keep the chronicle up to date.", when: "now" }, "j1"), toolCall("delegate", { agent: "story-reader", task: "Read the chat." }, "d1")] },
      { toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." }, "w1")] },
      "Okoro keeps it now.",
    ];
    const out = await it.generate(chatId);
    expect(out.error).toBeNull();
    const told = JSON.stringify(it.host.calls[1]);
    expect(told).toContain("chronicler isn't offered here");
    expect(told).toContain("story-reader isn't offered here");
    // No job was started, so nothing of the chronicler's runs after the reply either.
    expect(it.backend.jobs.state(USER, false, false).active).toEqual([]);
  });
});
