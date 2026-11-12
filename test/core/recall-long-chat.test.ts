// A long chat read by the history tools: 1,200 messages, about 8 MB of text, made up here. The core
// reads it through the extension's own chat module (`Chats`) over a stand-in Lumiverse that counts
// every read of the chat's messages and charges a read of the whole chat 2 seconds, a read of part
// of it its share of that. What a call costs is what it read, at those prices, and the time it took
// to work. Each run here is a job's: it reads the chat as it stands at every call.

import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../../src/core/ports";
import { CHAT_TOOLS } from "../../src/core/tools/chat";
import { Chats, type PathKeeping } from "../../src/extension/backend/chat";
import { FakeHost } from "../support/fake-host";
import { RecallHost, type Rig, toolRig } from "./recall-support";

const USER = "user-long";
/** As a user's settings keep a chat's list by default: sixteen chats, five minutes each. */
const KEEPING: PathKeeping = { chats: 16, ms: 5 * 60_000 };
const MESSAGES = 1200;
/** What the stand-in charges for a read of the whole chat, in milliseconds. */
const WHOLE_MS = 2000;

/** A seeded generator (mulberry32), so every run makes the same chat. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = "the a street morning light window coffee table door quiet slowly turns walks says looks small warm rain evening room chair book phone road market bread river bridge train station paper letter garden wall stairs kitchen laughs nods waits listens smiles after before while under over near again still then and but with into from across softly bright cold old new long short".split(" ");

/** Paragraphs of plain filler, `chars` long in all. */
function filler(rand: () => number, chars: number): string {
  const parts: string[] = [];
  let length = 0;
  while (length < chars) {
    const word = `${WORDS[Math.floor(rand() * WORDS.length)] ?? "the"}${rand() < 0.01 ? ".\n" : rand() < 0.08 ? ". " : " "}`;
    parts.push(word);
    length += word.length;
  }
  return parts.join("").slice(0, chars);
}

/** The text of message `i`: the player's are short, the replies long; every fiftieth reply names the brass key. */
function textOf(rand: () => number, i: number): string {
  if (i % 2 === 0) return filler(rand, 600);
  const body = filler(rand, 13_000);
  return i % 100 === 1 ? `${body}\nMara turns the brass key in the lock.` : body;
}

interface Long {
  lumiverse: FakeHost;
  host: RecallHost;
  chatId: string;
  /** The ids of the chat's messages, oldest first, as made. */
  ids: string[];
  /** The reads of the chat's messages so far, at the stand-in's prices: how many were of the whole chat, and what they cost in all, in ms. */
  reads(): { whole: number; parts: number; ms: number };
  /** A job's run of the history tools on the chat, as a new agent starts one. */
  run(runId: string): Promise<Rig>;
}

/** The made-up chat in a stand-in Lumiverse, and the core's host reading it through the extension's chat module, kept as `keeping` says. Its messages are numbered as Lumiverse numbers a chat some messages were deleted from: a number, once given, is never given again, so every 25th is missing. */
function longChat(keeping: PathKeeping = KEEPING): Long {
  const lumiverse = new FakeHost();
  lumiverse.permissions.add("chat_mutation");
  const chat = lumiverse.addChat(USER, "A long story");
  const numbers = new Map<string, number>();
  let next = 0;
  /** A message's number: the next one free the first time it is seen, past one never given. */
  const numberOf = (id: string): number => {
    let n = numbers.get(id);
    if (n === undefined) {
      if (next % 25 === 24) next++;
      n = next++;
      numbers.set(id, n);
    }
    return n;
  };
  const rand = seeded(7);
  const ids: string[] = [];
  for (let i = 0; i < MESSAGES; i++) ids.push(lumiverse.say(chat.id, i % 2 === 0 ? "user" : "assistant", textOf(rand, i)).id);
  for (const id of ids) numberOf(id);
  const read = lumiverse.chats.messages;
  lumiverse.chats.messages = async (chatId, range) => (await read(chatId, range)).map((m) => ({ ...m, index: numberOf(m.id) }));
  lumiverse.reads.length = 0;
  const chats = new Chats(lumiverse, async () => keeping, () => Date.now());
  lumiverse.events.onChatTouched((chatId, gone) => (gone ? chats.dropped(chatId) : chats.touched(chatId)));
  const host = new RecallHost();
  host.chat.path = (chatId) => chats.path(USER, chatId);
  host.chat.messages = (chatId, from, to) => chats.messages(USER, chatId, from, to);
  host.recall = { ...host.recall, chat: { messages: async (chatId, from, to) => (await chats.messages(USER, chatId, from, to)).map((m) => ({ ...m, at: null })) } };
  const begin = lumiverse.reads.length;
  return {
    lumiverse,
    host,
    chatId: chat.id,
    ids,
    run: (runId) => toolRig(host, CHAT_TOOLS, { chatId: chat.id, turn: null, runId }),
    reads() {
      let whole = 0;
      let parts = 0;
      let ms = 0;
      for (const { range } of lumiverse.reads.slice(begin)) {
        if (range === null) {
          whole++;
          ms += WHOLE_MS;
        } else {
          parts++;
          ms += (WHOLE_MS * Math.min(MESSAGES, "tail" in range ? range.tail : range.count)) / MESSAGES;
        }
      }
      return { whole, parts, ms: Math.round(ms) };
    },
  };
}

/** What one call read of the chat, and what it cost: the stand-in's time for its reads, and its own work. */
async function measured(long: Long, call: () => Promise<unknown>): Promise<{ whole: number; parts: number; host: number; work: number }> {
  const before = long.reads();
  const t0 = performance.now();
  await call();
  const work = Math.round(performance.now() - t0);
  const after = long.reads();
  return { whole: after.whole - before.whole, parts: after.parts - before.parts, host: after.ms - before.ms, work };
}

/** A tool's answer, which the test expects not to be an error. */
async function ok(rig: Rig, name: string, args: JsonObject): Promise<string> {
  const out = await rig.run(name, args);
  if (out.error) throw new Error(`${name} failed: ${out.text}`);
  return out.text;
}

/** Whether chat_grep finds `text` in the chat as the run reads it now. */
async function finds(rig: Rig, text: string): Promise<boolean> {
  return !(await ok(rig, "chat_grep", { text })).startsWith("No line of this chat holds");
}

describe("a long chat", () => {
  test("each history tool reads the chat once: a second call, and the next agent, read none of it, and the whole chat is never read for a range", async () => {
    const long = longChat();
    const table: string[] = [];
    const note = (label: string, m: { whole: number; parts: number; host: number; work: number }): void => void table.push(`${label}: ${m.whole} whole, ${m.parts} partial reads; host ${m.host} ms, work ${m.work} ms`);
    let rig = await long.run("job-1");
    const first = await measured(long, () => ok(rig, "chat_grep", { text: "brass key" }));
    note("chat_grep 1", first);
    // The run's first call reads every message once: one small read of the chat's last message, then a batch of 200 numbers at a time, over the numbers deletions left free (the last one is 1,248).
    expect(first.whole).toBe(0);
    expect(first.parts).toBe(1 + Math.ceil(1249 / 200));
    const later: [string, JsonObject][] = [
      ["chat_grep", { text: "brass key" }],
      ["chat_read", { from: "100", to: "104" }],
      ["chat_read", { from: "100", to: "104" }],
      ["chat_outline", {}],
      ["chat_outline", {}],
    ];
    for (const [name, args] of later) {
      const m = await measured(long, () => ok(rig, name, args));
      note(name, m);
      // One small read of the chat's last message, which tells a change at its end: nothing more.
      expect({ name, whole: m.whole, parts: m.parts }).toEqual({ name, whole: 0, parts: 1 });
    }
    rig = await long.run("job-2");
    const next = await measured(long, () => ok(rig, "chat_grep", { text: "brass key" }));
    note("next agent's chat_grep", next);
    expect({ whole: next.whole, parts: next.parts }).toEqual({ whole: 0, parts: 1 });
    console.log(table.join("\n"));
  });

  test("a message added, edited, deleted or swiped between two calls is read again, and the next call sees it", async () => {
    const long = longChat();
    const { lumiverse, chatId } = long;
    const rig = await long.run("job-1");
    expect(await finds(rig, "brass key")).toBe(true);
    const told = (): void => lumiverse.everywhere((emit) => emit.touched(chatId));
    const changes: [string, () => Promise<void> | void, string, boolean][] = [
      ["added", () => void lumiverse.say(chatId, "user", "Mara hums the lighthouse song."), "lighthouse song", true],
      [
        "edited",
        () => {
          const m = lumiverse.message(chatId, long.ids[3] ?? "");
          m.swipes[m.swipeId] = "Joss writes the ferry times on the wall.";
          told();
        },
        "ferry times",
        true,
      ],
      ["deleted", () => lumiverse.chats.deleteMessage(chatId, long.ids[3] ?? ""), "ferry times", false],
      [
        "swiped",
        () => {
          const m = lumiverse.message(chatId, long.ids[5] ?? "");
          m.swipes.push("The harbour bell rings twice.");
          m.swipeId = m.swipes.length - 1;
          told();
        },
        "harbour bell",
        true,
      ],
    ];
    for (const [what, change, text, seen] of changes) {
      await change();
      const m = await measured(long, async () => expect({ what, seen: await finds(rig, text) }).toEqual({ what, seen }));
      expect({ what, readAgain: m.whole }).toEqual({ what, readAgain: 1 });
    }
  });

  test("with keeping off, every call reads the chat again", async () => {
    const long = longChat({ chats: 16, ms: 0 });
    const rig = await long.run("job-1");
    for (const name of ["chat_outline", "chat_outline", "chat_read"]) {
      const m = await measured(long, () => ok(rig, name, name === "chat_read" ? { from: "10" } : {}));
      expect({ name, whole: m.whole }).toEqual({ name, whole: 1 });
    }
  });

  test("a pattern over all 8 MB answers in well under a second, and one cut by its time says so", async () => {
    const long = longChat();
    const rig = await long.run("job-1");
    await ok(rig, "chat_outline", {});
    const t0 = performance.now();
    const found = await ok(rig, "chat_grep", { text: "brass\\s+key in the (lock|door)", regex: true });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(found).toMatch(/^\d+ lines found; showing 1 to 10\.\n/);
    // The host's clock moves a millisecond each time the search looks at it.
    const { clock } = long.host;
    clock.auto = true;
    clock.now = () => (clock.t += 1);
    rig.settings.recall.grep.ms = 10;
    rig.settings.recall.grep.sliceMs = 5;
    const cut = await rig.run("chat_grep", { text: "[a-z]+ing\\b", regex: true });
    expect(cut.error).toBe(true);
    expect(cut.text).toMatch(/^The search was stopped: it took longer than 10 ms \(Time for one search\) and had gone through \d+ of 1200 messages\./);
  });
});
