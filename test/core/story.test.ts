// What counts as the story (DESIGN §24.4), over the harbour chat of `recall-support.ts`: whose word
// holds, member by member, and Settings saved before there was a choice; each history tool with a
// hidden message left out and read again; only the model's replies as the story, in the history
// tools, in what the chronicler is given to learn, in the chronicle the main agent is given and in
// what is embedded for search by meaning; a chronicle line resting on a message hidden afterwards;
// and the main agent's opening note where the user directs.

import { describe, expect, test } from "bun:test";
import type { JsonObject, PathMessage } from "../../src/core/ports";
import { checkChronicle, pinnedChronicle, readChronicle, storyHashes, uncoveredMessages } from "../../src/core/recall/chronicle";
import { citationsIn } from "../../src/core/recall/cite";
import { Recall, recallOf } from "../../src/core/recall/recall";
import { settingsOf } from "../../src/core/settings";
import { STORY_DEFAULTS, type StorySource, storyHolds } from "../../src/core/story";
import { Texts } from "../../src/core/texts";
import { CHAT_TOOLS } from "../../src/core/tools/chat";
import { CHRONICLE_TOOLS } from "../../src/core/tools/chronicle";
import { directedNote } from "../../src/core/turn";
import type { AreaAccess } from "../../src/core/workspace";
import { CHAT, FakeEmbedder, harbour, type RecallHost, type Rig, toolRig } from "./recall-support";

const SHOWN: StorySource = { hidden: "leave_out", from: "everyone", newest: "directive" };
const REPLIES: StorySource = { ...SHOWN, from: "replies" };

/** Words only each of the user's messages of the harbour chat holds (#0, #2 … #10). */
const USER_LINES = ["harbour at dusk", "I show him the brass key", "row out to the lighthouse", "I set the oars down", "at the mill, I ask Ilse", "Joss has agreed to stand watch"];

const cited = (text: string): number[] => citationsIn(text).map((c) => c.index);

/** Each history tool's answer, asked so that `words`, and the messages around #5, would be in it. */
async function answers(rig: Rig, words: string): Promise<[string, string][]> {
  const calls: [string, JsonObject][] = [
    ["chat_read", { from: 0, to: 11 }],
    ["chat_around", { message: 5 }],
    ["chat_grep", { text: words }],
    ["chat_search", { queries: [words] }],
    ["chat_about", { names: [words] }],
    ["chat_outline", {}],
  ];
  const out: [string, string][] = [];
  for (const [name, args] of calls) {
    const answer = await rig.run(name, args);
    if (answer.error) throw new Error(`${name} failed: ${answer.text}`);
    out.push([name, answer.text]);
  }
  return out;
}

/** Hides a message of the harbour chat from the prompt, as the user does in Lumiverse. */
async function hide(host: RecallHost, index: number): Promise<void> {
  host.message(CHAT, (await host.chat.path(CHAT))[index]?.id ?? "").hidden = true;
}

/** A message's citation as the chat tools print it. */
async function cite(host: RecallHost, index: number): Promise<string> {
  return `[#${index} ${(await host.chat.path(CHAT))[index]?.hash.slice(0, 8)}]`;
}

function learnedOf(rig: Rig): AreaAccess {
  const area = rig.env.workspace?.areas.learned;
  if (!area) throw new Error("the rig has no learned area");
  return area;
}

/** Writes a new file of the chronicle as the user would on the page. */
async function put(rig: Rig, name: string, text: string): Promise<void> {
  await learnedOf(rig).write({ path: `chronicle/${name}`, text, base: null, by: { who: "user" } });
}

/** What the main agent is given of the chronicle in a run of `rig`'s. */
async function given(rig: Rig): Promise<string> {
  return pinnedChronicle({ learned: learnedOf(rig), chat: await recallOf(rig.env).chat(), settings: rig.settings, texts: rig.env.texts, jobs: "none", writes: false });
}

describe("whose word holds", () => {
  test("the claim's, then the chat's own choice, then the user's setting, member by member; following Lumiverse, only the replies while Sovereign Hand is on", () => {
    const user = { hidden: "include", from: "everyone", newest: "leave_out" } as const;
    expect(storyHolds({ user, sovereignHand: null })).toEqual({ source: user, by: { hidden: "user", from: "user", newest: "user" } });
    expect(storyHolds({ claim: { from: "replies" }, chat: { hidden: "leave_out", from: "everyone" }, user, sovereignHand: null })).toEqual({ source: { hidden: "leave_out", from: "replies", newest: "leave_out" }, by: { hidden: "chat", from: "claim", newest: "user" } });
    const follow = { ...user, from: "lumiverse" } as const;
    expect(storyHolds({ user: follow, sovereignHand: true }).source.from).toBe("replies");
    expect(storyHolds({ user: follow, sovereignHand: false }).source.from).toBe("everyone");
    // Where Lumiverse doesn't say, nothing is guessed: everyone's, as before there was a choice, and the page is told it wasn't said.
    expect(storyHolds({ user: follow, sovereignHand: null })).toMatchObject({ source: { from: "everyone" }, sovereignHand: null });
    // A chat that names its own leaves Sovereign Hand out of it.
    expect(storyHolds({ chat: { from: "replies" }, user: follow, sovereignHand: true }).sovereignHand).toBeUndefined();
  });

  test("Settings saved before there was a choice read as shipped, and a part of it saved keeps the rest as shipped", () => {
    expect(settingsOf({}).story).toEqual(STORY_DEFAULTS);
    expect(settingsOf({ story: { from: "replies" } }).story).toEqual({ ...STORY_DEFAULTS, from: "replies" });
  });
});

describe("a hidden message", () => {
  test("is left out of every history tool, the others keeping their numbers; read again like any other where Settings say so", async () => {
    const host = harbour();
    await hide(host, 4);
    const out = await toolRig(host, CHAT_TOOLS, { runId: "gen-1", turn: null });
    for (const [name, text] of await answers(out, "row out to the lighthouse")) {
      // An answer that finds nothing names what was looked for: it is the message's own words that must not be there.
      expect(`${name}: ${cited(text).includes(4)} ${text.includes("The next morning")}`).toBe(`${name}: false false`);
    }
    expect(cited((await out.run("chat_read", { from: 0, to: 11 })).text)).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11]);

    const read = await toolRig(host, CHAT_TOOLS, { runId: "gen-2", turn: null, settings: (s) => void (s.story.hidden = "include") });
    const found = new Map(await answers(read, "row out to the lighthouse"));
    expect(cited(found.get("chat_read") ?? "")).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const name of ["chat_around", "chat_grep", "chat_search", "chat_about"]) expect(`${name}: ${cited(found.get(name) ?? "").includes(4)}`).toBe(`${name}: true`);
  });

  test("hidden after a chronicle line cited it: the line is not given to the main agent, and its citation still holds", async () => {
    const host = harbour();
    const first = await toolRig(host, CHRONICLE_TOOLS, { runId: "gen-1", turn: null });
    await put(first, "facts.md", [`- Joss knows the key opens the customs house strongbox. ${await cite(host, 3)}`, `- The ledger is in the strongbox. ${await cite(host, 7)}`].join("\n"));
    expect(await given(first)).toContain("Joss knows the key");
    await hide(host, 3);
    const later = await toolRig(host, CHRONICLE_TOOLS, { runId: "gen-2", turn: null });
    const pinned = await given(later);
    expect(pinned).toContain("The ledger is in the strongbox.");
    expect(pinned).not.toContain("Joss knows the key");
    expect(checkChronicle(await readChronicle(learnedOf(later)), await recallOf(later.env).chat()).failures).toEqual([]);
  });
});

describe("only the model's replies", () => {
  test("no history tool holds a message of the user's, and the replies keep their numbers", async () => {
    const rig = await toolRig(harbour(), CHAT_TOOLS, { story: REPLIES, turn: null });
    for (const [name, text] of await answers(rig, "brass key")) {
      expect(`${name}: ${cited(text).filter((index) => index % 2 === 0)}`).toBe(`${name}: `);
      for (const line of USER_LINES) expect(`${name}: ${text.includes(line)}`).toBe(`${name}: false`);
    }
    expect(cited((await rig.run("chat_grep", { text: "brass key" })).text)).toEqual([11]);
  });

  test("what the chronicler is given to learn, and the chronicle the main agent is given, hold no message of the user's", async () => {
    const host = harbour();
    const rig = await toolRig(host, CHRONICLE_TOOLS, { story: REPLIES, turn: null });
    expect(uncoveredMessages(await readChronicle(learnedOf(rig)), storyHashes(await host.chat.path(CHAT), REPLIES))).toEqual([1, 3, 5, 7, 9, 11]);
    await put(rig, "facts.md", [`- Mara rowed out to find Okoro. ${await cite(host, 4)}`, `- The ledger is in the strongbox. ${await cite(host, 7)}`].join("\n"));
    const pinned = await given(rig);
    expect(pinned).toContain("The ledger is in the strongbox.");
    expect(pinned).not.toContain("Mara rowed out");
  });

  test("search by meaning embeds no message the story leaves out", async () => {
    const host = harbour();
    await hide(host, 5);
    const embedder = new FakeEmbedder([["lighthouse", "lamp", "beacon"]]);
    host.recall = { ...host.recall, embeddings: embedder };
    const rig = await toolRig(host, CHAT_TOOLS, { story: REPLIES, turn: null, settings: (s) => void (s.recall.meaning.enabled = true) });
    await rig.run("chat_search", { queries: ["beacon"] });
    await Recall.of(host).meaning.settled();
    const embedded = embedder.calls.filter((c) => c.kind === "stored").flatMap((c) => c.texts);
    // The replies less the hidden one: #1, #3, #7, #9 and #11.
    expect(embedded).toHaveLength(5);
    for (const line of [...USER_LINES, "trimming the lamp"]) expect(`${line}: ${embedded.some((text) => text.includes(line))}`).toBe(`${line}: false`);
  });
});

describe("the main agent's opening note", () => {
  test("nothing with everyone's messages; with only the replies, the user's newest message as the direction or no direction; a hidden one is none", async () => {
    const texts = new Texts();
    const host = harbour();
    host.say(CHAT, "user", "Tonight we open the strongbox.");
    const reads: number[] = [];
    const read = async (message: PathMessage): Promise<string | null> => {
      reads.push(message.index);
      return (await host.chat.messages(CHAT, message.index, message.index + 1))[0]?.content ?? null;
    };
    const path = await host.chat.path(CHAT);
    expect(await directedNote({ source: SHOWN, before: path, read, texts })).toBeNull();
    expect(await directedNote({ source: REPLIES, before: path, read, texts })).toContain("Tonight we open the strongbox.");
    const quiet = await directedNote({ source: { ...REPLIES, newest: "leave_out" }, before: path, read, texts });
    expect(quiet).not.toBeNull();
    expect(quiet).not.toContain("Tonight");
    // Only the direction is read, and only where it is given.
    expect(reads).toEqual([12]);
    // A chat that ends with a reply has no direction for this one, and a message that can't be read gives none.
    expect(await directedNote({ source: REPLIES, before: path.slice(0, 12), read, texts })).not.toContain("Tonight");
    expect(await directedNote({ source: REPLIES, before: path, read: async () => null, texts })).not.toContain("Tonight");
    // Hidden by the user: no direction where hidden messages are left out, the direction where they are read.
    await hide(host, 12);
    const hidden = await host.chat.path(CHAT);
    expect(await directedNote({ source: REPLIES, before: hidden, read, texts })).not.toContain("Tonight");
    expect(await directedNote({ source: { ...REPLIES, hidden: "include" }, before: hidden, read, texts })).toContain("Tonight we open the strongbox.");
  });
});
