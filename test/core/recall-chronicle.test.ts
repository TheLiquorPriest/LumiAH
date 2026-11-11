// The chronicle (DESIGN §24.7): the check of its citations against the chat as it stands, the wrong
// numbers the check writes right, what the main agent is given of it each turn with the line on its
// upkeep, how far its outline reaches, and the built-in chronicler, story reader and skills. Over
// the harbour story of `recall-support.ts`.

import { describe, expect, test } from "bun:test";
import { checkAgent, checkSkill } from "../../src/core/definitions";
import type { ChatDoc, ChatRun } from "../../src/core/recall/chat";
import { citeDoc } from "../../src/core/recall/chat";
import { CHRONICLE_FILES, type ChroniclerJob, checkChronicle, chroniclerJob, chronicleReach, outlineSpans, pinnedChronicle, readChronicle, uncoveredMessages, uncoveredRuns } from "../../src/core/recall/chronicle";
import { citationsIn } from "../../src/core/recall/cite";
import { CHRONICLER, READER, RECALL_SKILL, RECALL_SKILLS, recallAgents } from "../../src/core/recall/definitions";
import { recallOf } from "../../src/core/recall/recall";
import type { Settings } from "../../src/core/settings";
import { BASE_TOOLS } from "../../src/core/tools/base";
import { CHRONICLE_TOOLS } from "../../src/core/tools/chronicle";
import { type AreaAccess, fileAt } from "../../src/core/workspace";
import { CHAT, cursorOf, DAY, harbour, pages, type RecallHost, type Rig, START, toolRig } from "./recall-support";

const CHECK = "chronicle_check";
const FACTS = "learned/chronicle/facts.md";

/** Words that would say the chat changed: the check knows only what it compared, so its answers hold none of them. */
const CHANGED = /\bchanged\b|no longer|\bnow says\b|says something else|\bis gone\b|\bwas (removed|deleted|edited)\b|\bmoved\b/i;

function learnedOf(rig: Rig): AreaAccess {
  const area = rig.env.workspace?.areas.learned;
  if (!area) throw new Error("the rig has no learned area");
  return area;
}

/** Writes a file of the chronicle as the user would on the page. */
async function put(rig: Rig, name: string, text: string): Promise<void> {
  const learned = learnedOf(rig);
  const there = fileAt(await learned.index(), `chronicle/${name}`);
  const done = await learned.write({ path: `chronicle/${name}`, text, base: there?.hash ?? null, by: { who: "user" } });
  expect(done.ok).toBe(true);
}

/** A file of the chronicle as it stands among the chat's files. */
async function fileText(rig: Rig, path: string): Promise<string> {
  return (await readChronicle(learnedOf(rig))).find((file) => file.path === path)?.text ?? "";
}

/** A run over the host's chat as it stands now: each is a run of its own, since a run reads the chat once. */
let runs = 0;
async function runOver(host: RecallHost, settings?: (s: Settings) => void): Promise<{ rig: Rig; chat: ChatRun; m: (i: number) => ChatDoc }> {
  const rig = await toolRig(host, CHRONICLE_TOOLS, { runId: `gen-${++runs}`, ...(settings ? { settings } : {}) });
  const chat = await recallOf(rig.env).chat();
  const m = (i: number): ChatDoc => {
    const doc = chat.messages[i];
    if (!doc) throw new Error(`the chat has no message at place ${i}`);
    return doc;
  };
  return { rig, chat, m };
}

/** What the main agent is given: `jobs` says whether the chronicler is at work (null: jobs can't run), `writes` that the main agent writes the reply itself. */
const pinned = (rig: Rig, chat: ChatRun, jobs: ChroniclerJob | null = "none", writes = false): Promise<string> => pinnedChronicle({ learned: learnedOf(rig), chat, settings: rig.settings, texts: rig.env.texts, jobs, writes });

/** How the upkeep line says a job is started beside write_reply, from a message on. */
const how = (from: number): string => `Call job_start in the same answer as write_reply, never in a round of its own: agent ${CHRONICLER}, task “Bring the chronicle up to date from message #${from}.”`;

/** The four files, each line citing messages of the harbour chat as it stood at `m`. */
async function writeFour(rig: Rig, m: (i: number) => ChatDoc): Promise<void> {
  await put(rig, "outline.md", [`- #${m(0).index}–#${m(3).index} · The harbour: Mara shows Joss the brass key. ${citeDoc(m(0))} ${citeDoc(m(3))}`, `- #${m(4).index}–#${m(7).index} · The lighthouse: Okoro names the ledger. ${citeDoc(m(4))} ${citeDoc(m(7))}`].join("\n"));
  await put(rig, "facts.md", ["# Facts", "", `- The brass key opens the customs house strongbox. ${citeDoc(m(3))}`, `- The ledger is in the strongbox, which wants two keys turned at once. ${citeDoc(m(7))}`].join("\n"));
  await put(rig, "threads.md", `- Ilse will bring Okoro tonight, willing or not. ${citeDoc(m(11))}\n`);
  await put(rig, "cast.md", [`- Joss: at the harbour, agreed to stand watch. ${citeDoc(m(1))} ${citeDoc(m(10))}`, `- Okoro: keeps the lighthouse and the second key. ${citeDoc(m(3))}`].join("\n"));
}

describe("chronicle_check", () => {
  test("a chronicle whose citations all hold", async () => {
    const { rig, chat, m } = await runOver(harbour());
    await writeFour(rig, m);
    const files = await readChronicle(learnedOf(rig));
    expect(files.map((f) => f.path)).toEqual(CHRONICLE_FILES.map((path) => `learned/${path}`));
    const check = checkChronicle(files, chat);
    expect(check.failures).toEqual([]);
    expect(check.moved).toEqual([]);
    expect(check.uncited).toEqual([]);
    // A heading and a blank line are layout: neither is asked for a citation.
    expect(check.files.find((f) => f.path === FACTS)).toMatchObject({ lines: 4, cited: 2, failed: 0 });

    const answer = await rig.run(CHECK);
    expect(answer.error).toBeUndefined();
    expect(answer.files).toBeUndefined();
    expect(answer.text).toContain(`messages #${m(0).index} to #${m(11).index}`);
    // What the check proves is said with it: that the message is there and reads as cited, not that it supports the line.
    expect(answer.text).toContain("not that it supports the line");
    expect(answer.text).toContain(`- ${FACTS}: 4 lines, 2 cited, 0 failed`);
    expect(answer.text).toContain("Every line cites a message, and every citation holds.");
    expect(answer.text).toContain("No outline line covers 4 messages: #8 to #11.");
    expect(answer.text).not.toContain("Corrected");
    expect(answer.text.indexOf("outline.md")).toBeLessThan(answer.text.indexOf("facts.md"));
    expect(answer.text.indexOf("threads.md")).toBeLessThan(answer.text.indexOf("cast.md"));
    // One file that isn't the outline says nothing of what the outline covers.
    expect((await rig.run(CHECK, { path: "facts" })).text).not.toContain("outline line");
  });

  test("a citation fails where the message at its number reads otherwise, and the answer says what was compared", async () => {
    const host = harbour();
    const before = await runOver(host);
    await writeFour(before.rig, before.m);
    host.edit(CHAT, before.m(3).id, "He hands it back. \"I never saw that key before.\"");

    const { rig, chat } = await runOver(host);
    const check = checkChronicle(await readChronicle(learnedOf(rig)), chat);
    expect(check.failures.map((f) => [f.path, f.line, f.why, f.index])).toEqual([
      ["learned/chronicle/outline.md", 1, "changed", before.m(3).index],
      [FACTS, 3, "changed", before.m(3).index],
      ["learned/chronicle/cast.md", 2, "changed", before.m(3).index],
    ]);
    expect(check.moved).toEqual([]);
    expect(check.files.map((f) => f.failed)).toEqual([1, 1, 0, 1]);

    const answer = await rig.run(CHECK);
    expect(answer.text).toContain("3 problems");
    expect(answer.text).toContain(`- FAILED ${FACTS} line 3, ${citeDoc(before.m(3))}: message #${before.m(3).index} doesn't read as cited, and no message of the chat reads as cited: - The brass key opens`);
    expect(answer.text).not.toContain("every citation holds");
    // LumiAH keeps no record of a chat changing: the answer never says that one did.
    expect(answer.text).not.toMatch(CHANGED);

    // One file alone, by its name.
    const one = await rig.run(CHECK, { path: "facts" });
    expect(one.text).toContain("1 problem.");
    expect(one.text).toContain(FACTS);
    expect(one.text).not.toContain("cast.md");
  });

  test("a citation fails where the chat has no message at its number", async () => {
    const host = harbour();
    const before = await runOver(host);
    await writeFour(before.rig, before.m);
    host.remove(CHAT, before.m(11).id);

    const { rig, chat } = await runOver(host);
    const check = checkChronicle(await readChronicle(learnedOf(rig)), chat);
    expect(check.failures.map((f) => [f.path, f.line, f.why])).toEqual([["learned/chronicle/threads.md", 1, "gone"]]);
    expect(check.moved).toEqual([]);
    const answer = await rig.run(CHECK);
    expect(answer.text).toContain(`- FAILED learned/chronicle/threads.md line 1, ${citeDoc(before.m(11))}: the chat has no message #${before.m(11).index}, and no message of the chat reads as cited: - Ilse will bring Okoro`);
    expect(answer.text).not.toMatch(CHANGED);
  });

  test("a hash no message has fails its line, whatever number stands beside it (M2)", async () => {
    const { rig, chat, m } = await runOver(harbour());
    // A made-up hash at a number the chat has, one at a number it doesn't, and four characters of a real hash, which are no citation.
    await put(rig, "facts.md", ["- Mara came by sea. [#3 0123abcd]", "- Brann owns the mill. [#900 0123abcd]", `- Joss mends nets. [#${m(1).index} ${m(1).hash.slice(0, 4)}]`, `- The brass key opens the strongbox. ${citeDoc(m(3))}`].join("\n"));
    const check = checkChronicle(await readChronicle(learnedOf(rig)), chat);
    expect(check.failures.map((f) => [f.line, f.why])).toEqual([
      [1, "changed"],
      [2, "gone"],
    ]);
    expect(check.moved).toEqual([]);
    expect(check.uncited.map((line) => line.line)).toEqual([3]);
    expect(check.files[0]).toMatchObject({ lines: 4, cited: 3, failed: 3 });
    const text = await pinned(rig, chat);
    expect(text).toContain("The brass key opens the strongbox.");
    for (const left of ["Mara came by sea", "Brann owns the mill", "Joss mends nets"]) expect(text).not.toContain(left);
  });

  test("a number that is wrong where exactly one other message reads as cited is written right in the file, and listed (M2)", async () => {
    const host = harbour();
    const before = await runOver(host);
    await put(before.rig, "facts.md", `- The ledger is in the strongbox. ${citeDoc(before.m(7))}\n- Okoro has the other key. ${citeDoc(before.m(3))} ${citeDoc(before.m(7))}\n`);
    host.remove(CHAT, before.m(2).id);

    const { rig, chat, m } = await runOver(host);
    expect(m(6).hash).toBe(before.m(7).hash);
    const check = checkChronicle(await readChronicle(learnedOf(rig)), chat);
    expect(check.failures).toEqual([]);
    expect(check.moved).toEqual([
      { path: FACTS, line: 1, citation: citeDoc(before.m(7)), index: before.m(7).index, now: m(6).index },
      { path: FACTS, line: 2, citation: citeDoc(before.m(3)), index: before.m(3).index, now: m(2).index },
      { path: FACTS, line: 2, citation: citeDoc(before.m(7)), index: before.m(7).index, now: m(6).index },
    ]);
    expect(check.files[0]).toMatchObject({ cited: 2, failed: 0 });
    // Before any check ran, the main agent is shown the lines with the numbers their texts stand at.
    const shown = await pinned(rig, chat);
    expect(shown).toContain(`- The ledger is in the strongbox. ${citeDoc(m(6))}`);
    expect(shown).toContain(`- Okoro has the other key. ${citeDoc(m(2))} ${citeDoc(m(6))}`);

    // The check writes the numbers right in the file, says what it corrected, and fails nothing for it.
    const answer = await rig.run(CHECK);
    expect(answer.error).toBeUndefined();
    expect(answer.text).toContain("Corrected in the files, 3 citations whose number was wrong");
    expect(answer.text).toContain(`- ${FACTS} line 1: ${citeDoc(before.m(7))} now cites #${m(6).index}`);
    expect(answer.text).toContain(`- ${FACTS} line 2: ${citeDoc(before.m(3))} now cites #${m(2).index}`);
    expect(answer.text).toContain("Every line cites a message, and every citation holds.");
    expect(answer.text).not.toContain("FAILED");
    expect(answer.text).not.toMatch(CHANGED);
    expect(answer.files?.map((change) => change.path)).toEqual(["chronicle/facts.md"]);
    expect(await fileText(rig, FACTS)).toBe(`- The ledger is in the strongbox. ${citeDoc(m(6))}\n- Okoro has the other key. ${citeDoc(m(2))} ${citeDoc(m(6))}\n`);

    // Checked again there is nothing left to correct, and nothing is written.
    const again = await rig.run(CHECK);
    expect(again.text).not.toContain("Corrected");
    expect(again.files).toBeUndefined();
    expect(checkChronicle(await readChronicle(learnedOf(rig)), chat).moved).toEqual([]);
  });

  test("a hash several messages have names them and passes nothing; cited at its own number, one of them holds (M2)", async () => {
    const host = harbour();
    // Two messages with the same text have the same hash.
    host.sayAt(CHAT, "user", "Continue.", START + 9 * DAY);
    host.sayAt(CHAT, "user", "Continue.", START + 9 * DAY + 60_000);
    const { rig, chat, m } = await runOver(host);
    expect(m(12).hash).toBe(m(13).hash);
    const wrong = citeDoc({ index: m(5).index, hash: m(12).hash });
    await put(rig, "facts.md", `- Mara tells him to go on. ${wrong}\n- She says it again. ${citeDoc(m(13))}\n`);
    const check = checkChronicle(await readChronicle(learnedOf(rig)), chat);
    expect(check.moved).toEqual([]);
    expect(check.failures.map((f) => [f.line, f.why, f.citation])).toEqual([[1, "changed", wrong]]);

    const answer = await rig.run(CHECK);
    expect(answer.text).toContain(`- FAILED ${FACTS} line 1, ${wrong}: message #${m(5).index} doesn't read as cited, and several messages read as cited (#${m(12).index}, #${m(13).index}), so which was meant can't be told`);
    expect(answer.text).not.toContain("Corrected");
    expect(answer.files).toBeUndefined();
    expect(await fileText(rig, FACTS)).toContain(wrong);
    const text = await pinned(rig, chat);
    expect(text).not.toContain("Mara tells him to go on");
    expect(text).toContain("She says it again.");
  });

  test("a line that cites nothing fails, list item or prose: it is named as citing nothing and never given to the main agent (H5)", async () => {
    const { rig, chat, m } = await runOver(harbour());
    await put(rig, "facts.md", ["# Facts", "Kept by the chronicler.", "---", "- Okoro murdered Brann last winter.", `  * Brann's is the longest page. ${citeDoc(m(9))}`, "2. Joss mends nets.", "", "Mara has agreed to give the brass key to Brann."].join("\n"));
    const check = checkChronicle(await readChronicle(learnedOf(rig)), chat);
    expect(check.uncited).toEqual([
      { path: FACTS, line: 2, text: "Kept by the chronicler." },
      { path: FACTS, line: 4, text: "- Okoro murdered Brann last winter." },
      { path: FACTS, line: 6, text: "2. Joss mends nets." },
      { path: FACTS, line: 8, text: "Mara has agreed to give the brass key to Brann." },
    ]);
    expect(check.failures).toEqual([]);
    // The heading, the rule and the blank line are layout; the four lines that say something uncited fail.
    expect(check.files[0]).toMatchObject({ lines: 8, cited: 1, failed: 4 });

    const answer = await rig.run(CHECK);
    expect(answer.text).toContain("4 problems");
    expect(answer.text).toContain(`- ${FACTS}: 8 lines, 1 cited, 4 failed`);
    expect(answer.text).toContain(`- FAILED ${FACTS} line 4, cites nothing: - Okoro murdered Brann last winter.`);
    expect(answer.text).toContain(`- FAILED ${FACTS} line 8, cites nothing: Mara has agreed to give the brass key to Brann.`);

    const text = await pinned(rig, chat);
    for (const left of ["Okoro murdered Brann", "Mara has agreed to give", "Joss mends nets", "Kept by the chronicler"]) expect(text).not.toContain(left);
    expect(text).toContain(`* Brann's is the longest page. ${citeDoc(m(9))}`);
    expect(text).toContain(`${FACTS} (4 lines left out: they cite nothing, or cite what no message reads as; chronicle_check lists them):`);
  });

  test("a file that was written while it was checked, and one its holder may not write, are left as they are, and the answer says why", async () => {
    const host = harbour();
    const before = await runOver(host);
    await put(before.rig, "facts.md", `- The ledger is in the strongbox. ${citeDoc(before.m(7))}\n`);
    host.remove(CHAT, before.m(2).id);
    const { rig, m } = await runOver(host);
    const [definition] = CHRONICLE_TOOLS;
    const { workspace } = rig.env;
    if (!definition || !workspace) throw new Error("the rig has no workspace");
    const ctx = { signal: new AbortController().signal, agentId: "agent_test", role: "main", callId: "c1" };

    // The holder of the area refuses the path: nothing is written, the reason is the holder's own, and the line still passes.
    const barred = definition.build({ ...rig.env, workspace: { ...workspace, guard: () => "Agents may not write this file." } });
    const refused = await barred?.run({}, ctx);
    expect(refused?.text).toContain(`Not corrected in ${FACTS}, 1 citation whose number is wrong: Agents may not write this file.`);
    expect(refused?.text).not.toContain("FAILED");
    expect(refused?.files).toBeUndefined();
    expect(await fileText(rig, FACTS)).toContain(citeDoc(before.m(7)));

    // Somebody writes the file between the read and the write: the version the check read is no longer the one there is.
    const learned = learnedOf(rig);
    const raced: AreaAccess = {
      ...learned,
      index: () => learned.index(),
      text: (hash) => learned.text(hash),
      write: async (input) => {
        await learned.write({ path: input.path, text: `- Rewritten meanwhile. ${citeDoc(m(0))}\n`, base: input.base, by: { who: "user" } });
        return learned.write(input);
      },
      move: (input) => learned.move(input),
      remove: (input) => learned.remove(input),
      pin: (input) => learned.pin(input),
    };
    const racing = definition.build({ ...rig.env, workspace: { ...workspace, areas: { ...workspace.areas, learned: raced } } });
    const stale = await racing?.run({}, ctx);
    expect(stale?.text).toContain(`Not corrected in ${FACTS}, 1 citation whose number is wrong: the file was written while it was checked; run chronicle_check again`);
    expect(await fileText(rig, FACTS)).toBe(`- Rewritten meanwhile. ${citeDoc(m(0))}\n`);

    // A turn that was stopped changes nothing (H4): the call ends before its write.
    await put(rig, "threads.md", `- The ledger is in the strongbox. ${citeDoc(before.m(7))}\n`);
    const stopped = new AbortController();
    stopped.abort(new Error("the turn was stopped"));
    await expect(rig.tools.get(CHECK)?.run({}, { ...ctx, signal: stopped.signal })).rejects.toThrow("the turn was stopped");
    expect(await fileText(rig, "learned/chronicle/threads.md")).toContain(citeDoc(before.m(7)));
  });

  test("without a file it says there is no chronicle, and names the skill that keeps one", async () => {
    const { rig } = await runOver(harbour());
    // What learning a story keeps beside the chronicle is not the chronicle.
    await put(rig, "plan.md", "- [ ] #0–#11 read closely\n");
    await put(rig, "unverified.md", "- nothing yet\n");
    expect(await readChronicle(learnedOf(rig))).toEqual([]);
    const answer = await rig.run(CHECK);
    expect(answer.error).toBeUndefined();
    expect(answer.text).toContain("no chronicle yet");
    expect(answer.text).toContain(RECALL_SKILL.keep);
  });

  test("a path that is no file of the chronicle is an error that names the files, within Answer length", async () => {
    const { rig, m } = await runOver(harbour());
    await put(rig, "facts.md", `- The brass key opens the strongbox. ${citeDoc(m(3))}\n`);
    const answer = await rig.run(CHECK, { path: "learned/chronicle/places.md" });
    expect(answer.error).toBe(true);
    expect(answer.text).toBe(`learned/chronicle/places.md is no file of the chronicle. Its files are: ${FACTS}.`);
    const long = await rig.run(CHECK, { path: "x".repeat(5000), cursor: "9".repeat(5000) });
    expect(long.error).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);
    const longPath = await rig.run(CHECK, { path: "y".repeat(5000) });
    expect(longPath.error).toBe(true);
    expect(longPath.text).toContain("is no file of the chronicle");
    expect(longPath.text.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);
  });

  test("an answer with many problems and many corrections stays within Answer length and pages", async () => {
    const host = harbour();
    const before = await runOver(host);
    const filler = "and what it led to along the whole coast, told at length ".repeat(8);
    const gone = Array.from({ length: 30 }, (_, i) => `- Something the story dropped (${i}), ${filler} [#${900 + i} abcd0123]`);
    const bare = Array.from({ length: 40 }, (_, i) => `- Something nobody cited (${i}), ${filler}`);
    const wrong = Array.from({ length: 60 }, (_, i) => `- Something cited by a wrong number (${i}). ${citeDoc(before.m(4 + (i % 8)))}`);
    await put(before.rig, "facts.md", [`- The brass key opens the strongbox. ${citeDoc(before.m(1))}`, ...gone].join("\n"));
    await put(before.rig, "threads.md", bare.join("\n"));
    await put(before.rig, "cast.md", wrong.join("\n"));
    host.remove(CHAT, before.m(2).id);

    const { rig } = await runOver(host);
    const all = await pages(rig, CHECK, {});
    expect(all.length).toBeGreaterThan(7);
    for (const page of all) expect(page.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);
    const text = all.join("\n");
    expect(text.match(/^- FAILED .*the chat has no message #9\d\d/gm)?.length).toBe(30);
    expect(text.match(/^- FAILED .*, cites nothing: /gm)?.length).toBe(40);
    // Citations that don't hold come before lines that cite nothing, and the summary is said once.
    expect(text.lastIndexOf("the chat has no message #")).toBeLessThan(text.indexOf(", cites nothing: "));
    expect(all[0]).toContain("70 problems");
    expect(all[0]).toContain(`- ${FACTS}: 31 lines, 31 cited, 30 failed`);
    // Sixty numbers were written right: the answer says how many, shows as many as its share of the page holds, and counts the rest.
    expect(all[0]).toContain("Corrected in the files, 60 citations whose number was wrong");
    expect(all[0]).toMatch(/\(and \d+ more, corrected the same way\)/);
    expect(all[1]).not.toContain("The chronicle against the chat");
    expect(all[1]).not.toContain("Corrected");
    expect(cursorOf(all[0] ?? "")).not.toBeNull();
    expect(checkChronicle(await readChronicle(learnedOf(rig)), await recallOf(rig.env).chat()).moved).toEqual([]);

    const past = await rig.run(CHECK, { cursor: "70" });
    expect(past.error).toBe(true);
    expect(past.text.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);

    // A page as small as Settings allow still holds.
    const small = await runOver(rig.host, (s) => {
      s.tools.pageChars = 200;
    });
    for (const page of await pages(small.rig, CHECK, {})) expect(page.length).toBeLessThanOrEqual(200);
  });

  test("it is offered only where the run has a chat and a learned area, as a tool that writes", async () => {
    const host = harbour();
    const { rig } = await runOver(host);
    expect(rig.offered()).toEqual([CHECK]);
    const [definition] = CHRONICLE_TOOLS;
    expect(definition?.tier).toBe("write");
    expect(definition?.build({ ...rig.env, run: { ...rig.env.run, chatId: "" } })).toBeNull();
    const { workspace } = rig.env;
    if (!workspace) throw new Error("the rig has no workspace");
    expect(definition?.build({ ...rig.env, workspace: { ...workspace, areas: { ...workspace.areas, learned: null } } })).toBeNull();
  });
});

describe("the pinned chronicle", () => {
  test("the top of each file, in the order cast, threads, facts, outline, with the reach and the line on its upkeep", async () => {
    const { rig, chat, m } = await runOver(harbour());
    await writeFour(rig, m);
    const text = await pinned(rig, chat);
    expect(text.length).toBeLessThanOrEqual(rig.settings.recall.chronicle.pinChars);
    const places = ["learned/chronicle/cast.md", "learned/chronicle/threads.md", FACTS, "learned/chronicle/outline.md"].map((path) => text.indexOf(`${path}:`));
    expect(places.every((at) => at > 0)).toBe(true);
    expect([...places].sort((a, b) => a - b)).toEqual(places);
    expect(text).toContain(`It reaches message #${m(11).index}; the chat is at #${m(11).index}, 0 messages past it.`);
    expect(text).toContain("# Facts");
    expect(text).toContain(`- Okoro: keeps the lighthouse and the second key. ${citeDoc(m(3))}`);
    // Nothing is due: the line says when a job is worth it all the same, and the whole of how to start one, so no skill is loaded and no round is spent on it.
    expect(text.endsWith(`\n[Upkeep: nothing is due. Start a job only if this turn changes something the chronicle states. ${how(m(11).index + 1)}]`)).toBe(true);
    expect(text).not.toContain("skill");

    // A chronicler job of the chat that runs or waits: the line says so, and that no other is started.
    expect((await pinned(rig, chat, "running")).endsWith("\n[Upkeep: a chronicler job is running for this chat. Start no other.]")).toBe(true);
    const waiting = await pinned(rig, chat, "waiting");
    expect(waiting.endsWith("\n[Upkeep: a chronicler job is waiting to run for this chat. Start no other.]")).toBe(true);
    expect(waiting).not.toContain("job_start");
    // A main agent that writes the reply itself has no write_reply to put the start beside.
    const writes = await pinned(rig, chat, "none", true);
    expect(writes).toContain("Call job_start among the tool calls of a round this reply needs anyway, never in a round of its own (a turn that needs no tool call leaves it to a later one)");
    expect(writes).not.toContain("write_reply");

    // No line on upkeep where jobs can't run, or where the user switched it off.
    const quiet = await pinned(rig, chat, null);
    expect(quiet).toContain("learned/chronicle/cast.md:");
    expect(quiet).not.toContain("Upkeep");
    rig.settings.recall.chronicle.remind = false;
    expect(await pinned(rig, chat)).toBe(quiet);
    rig.settings.recall.chronicle.pin = false;
    expect(await pinned(rig, chat)).toBe("");
  });

  test("once the chat is further past the chronicle than Settings' tail, the line says to have it brought up to date, and from where", async () => {
    const { rig, chat, m } = await runOver(harbour(), (s) => {
      s.recall.chronicle.tail = 3;
    });
    await put(rig, "facts.md", `- The ledger is in the strongbox. ${citeDoc(m(7))}\n`);
    // Four messages past the chronicle, and the tail is three.
    const due = await pinned(rig, chat);
    expect(due).toContain(`It reaches message #${m(7).index}; the chat is at #${m(11).index}, 4 messages past it.`);
    expect(due.endsWith(`\n[Upkeep: the chat is 4 messages past the chronicle, more than the user's setting allows. Have it brought up to date. ${how(m(8).index)}]`)).toBe(true);
    // At the tail nothing is due.
    rig.settings.recall.chronicle.tail = 4;
    expect(await pinned(rig, chat)).toContain("[Upkeep: nothing is due.");
    // A job that runs already is all the line says, however far behind the chronicle is.
    rig.settings.recall.chronicle.tail = 1;
    expect(await pinned(rig, chat, "running")).not.toContain("Have it brought up to date");
  });

  test("the chronicler's jobs of a chat are read for one that runs or waits; a job that is held or has ended counts as none", () => {
    expect(chroniclerJob([])).toBe("none");
    expect(chroniclerJob([{ agent: "summarizer", state: "running" }])).toBe("none");
    expect(chroniclerJob([{ agent: CHRONICLER, state: "queued" }])).toBe("waiting");
    expect(
      chroniclerJob([
        { agent: CHRONICLER, state: "queued" },
        { agent: CHRONICLER, state: "running" },
      ]),
    ).toBe("running");
    expect(
      chroniclerJob([
        { agent: CHRONICLER, state: "done" },
        { agent: CHRONICLER, state: "failed" },
        { agent: CHRONICLER, state: "cancelled" },
      ]),
    ).toBe("none");
  });

  test("a line that fails the check is left out, and the file says so", async () => {
    const host = harbour();
    const before = await runOver(host);
    await writeFour(before.rig, before.m);
    host.edit(CHAT, before.m(3).id, "He hands it back. \"I never saw that key before.\"");
    host.remove(CHAT, before.m(11).id);

    const { rig, chat, m } = await runOver(host);
    const text = await pinned(rig, chat);
    expect(text).not.toContain("The brass key opens the customs house strongbox.");
    expect(text).not.toContain("Okoro: keeps the lighthouse");
    expect(text).not.toContain("Ilse will bring Okoro tonight");
    expect(text).toContain("The ledger is in the strongbox, which wants two keys turned at once.");
    expect(text).toContain("# Facts");
    expect(text).toContain(`${FACTS} (1 line left out: they cite nothing, or cite what no message reads as; chronicle_check lists them):`);
    // A file whose every line fails keeps its heading, which says so.
    expect(text).toContain("learned/chronicle/threads.md (1 line left out");
    // The reach is the last message a citation that holds names, against where the chat is.
    expect(text).toContain(`It reaches message #${before.m(10).index}; the chat is at #${m(10).index}, 0 messages past it.`);
    expect(text).not.toMatch(CHANGED);
  });

  test("it stays within Pinned chronicle: length, each file by its top", async () => {
    const { rig, chat, m } = await runOver(harbour(), (s) => {
      s.recall.chronicle.pinChars = 1500;
    });
    const many = (what: string, n: number): string => Array.from({ length: n }, (_, i) => `- ${what} ${i}: something the story settled. ${citeDoc(m(i % 12))}`).join("\n");
    await put(rig, "cast.md", `- Joss: at the harbour. ${citeDoc(m(1))}\n`);
    await put(rig, "threads.md", many("Thread", 40));
    await put(rig, "facts.md", many("Fact", 40));
    await put(rig, "outline.md", many("Part", 40));
    const text = await pinned(rig, chat);
    expect(text.length).toBeLessThanOrEqual(1500);
    // The short file is whole; the room it left went to the files after it, each cut from the top.
    expect(text).toContain(`learned/chronicle/cast.md:\n- Joss: at the harbour. ${citeDoc(m(1))}`);
    for (const [path, what] of [["threads", "Thread"], ["facts", "Fact"], ["outline", "Part"]]) {
      expect(text).toMatch(new RegExp(`learned/chronicle/${path}\\.md \\(its first \\d+ of 40 lines; workspace_read reads the rest\\):\\n- ${what} 0:`));
      expect(text).not.toContain(`- ${what} 39:`);
    }
    // The line on its upkeep is said whole or not at all: an instruction cut short misleads.
    expect(text.endsWith(`${how(m(11).index + 1)}]`)).toBe(true);
    expect(text.length).toBeGreaterThan(1200);

    // Whatever the setting, the limit holds; with no room for the upkeep line whole, the note goes without it.
    rig.settings.recall.chronicle.pinChars = 400;
    const short = await pinned(rig, chat);
    expect(short.length).toBeLessThanOrEqual(400);
    expect(short).not.toContain("Upkeep");
    rig.settings.recall.chronicle.pinChars = 200;
    expect((await pinned(rig, chat)).length).toBeLessThanOrEqual(200);
  });

  test("a chronicle none of whose lines passes says so, and gives none of them", async () => {
    const { rig, chat, m } = await runOver(harbour());
    await put(rig, "facts.md", "- Mara came by sea. [#900 abcd0123]\n- Brann owes the mill.\n");
    const text = await pinned(rig, chat);
    expect(text).toContain(`None of its lines passes the check; the chat is at #${m(11).index} and has 12 messages.`);
    expect(text).not.toContain("Brann owes the mill");
    expect(text).not.toContain("Mara came by sea");
    expect(text).toContain(`${FACTS} (2 lines left out`);
  });

  test("without files nothing is said until the chat is longer than Settings' tail; then one line asks for a chronicle to be begun", async () => {
    const { rig, chat, m } = await runOver(harbour());
    // Twelve messages, and the tail is twenty: the prompt still holds the chat, or nearly.
    expect(await pinned(rig, chat)).toBe("");
    rig.settings.recall.chronicle.tail = 5;
    const asks = await pinned(rig, chat);
    expect(asks).toBe(`[This chat has no chronicle yet (learned/chronicle/): nothing keeps what the story established, so the past has to be searched each time. It is at message #${m(11).index} and has 12 messages.]\n[Upkeep: have one begun. ${how(m(0).index)}]`);
    // A chat longer than one reader's stretch: the job begins at its last stretch, and the story before it is the user's to have learned.
    rig.settings.recall.chronicle.stretchMessages = 4;
    expect(await pinned(rig, chat)).toContain(`[Upkeep: have one begun. ${how(m(8).index)} The story before #${m(8).index} stays unlearned until the user has it learned (Learn this story, on the Chronicle page).]`);
    // A chronicler that runs already is all there is to say.
    expect(await pinned(rig, chat, "running")).toContain("a chronicler job is running for this chat");
    expect(await pinned(rig, chat, null)).toBe("");
    // A run without a learned area has nowhere to keep one: it isn't asked to.
    expect(await pinnedChronicle({ learned: null, chat, settings: rig.settings, texts: rig.env.texts, jobs: "none", writes: false })).toBe("");
    rig.settings.recall.chronicle.remind = false;
    expect(await pinned(rig, chat)).toBe("");
  });

  test("it needs no more of the chat than its hashes and the messages that are its story", async () => {
    const { rig, chat, m } = await runOver(harbour());
    await put(rig, "facts.md", `- The brass key opens the strongbox. ${citeDoc(m(3))}\n`);
    const hashes = { hashes: () => chat.hashes(), story: () => chat.story() };
    expect(await pinnedChronicle({ learned: learnedOf(rig), chat: hashes, settings: rig.settings, texts: rig.env.texts, jobs: "none", writes: false })).toBe(await pinned(rig, chat));
    expect(checkChronicle(await readChronicle(learnedOf(rig)), hashes).failures).toEqual([]);
  });
});

describe("how far the outline reaches", () => {
  test("the spans an outline's items open with", () => {
    const text = ["# Outline", "- #120–#159 · The crossing: they reach the far shore. [#120 a3f9c27e] [#159 77b0d41c]", "- #160-#170 · The mill", "* #171 to #180 · The flood", "  1. #200 · One night", "- **#210–215** · The reckoning", "- #230 - 4 boats put out", "- A part that names no messages", "#300–#400 is no item", "- #159–#150 · written backwards"].join("\n");
    expect(outlineSpans(text)).toEqual([
      [120, 159],
      [160, 170],
      [171, 180],
      [200, 200],
      [210, 215],
      [230, 230],
      [150, 159],
    ]);
  });

  test("how many of the chat's messages the outline covers, and which it leaves out", async () => {
    const { rig, chat, m } = await runOver(harbour());
    expect(chronicleReach(await readChronicle(learnedOf(rig)), chat)).toEqual({ covered: 0 });
    // Without an outline every message is left out: the whole chat is one run.
    expect(uncoveredRuns(await readChronicle(learnedOf(rig)), chat)).toEqual([[m(0).index, m(11).index]]);
    // Two parts that share a message count it once, and a span past the chat's end covers only the messages there are.
    await put(rig, "outline.md", [`- #${m(0).index}–#${m(3).index} · The harbour`, `- #${m(3).index} to #${m(5).index} · The lighthouse`, `- #${m(8).index} · The mill`, `- #${m(11).index}-#${m(11).index + 50} · Tonight`].join("\n"));
    // A span in another file is no part of the outline.
    await put(rig, "facts.md", `- #${m(6).index}–#${m(7).index} · not an outline line\n`);
    const files = await readChronicle(learnedOf(rig));
    expect(chronicleReach(files, chat)).toEqual({ covered: 8 });
    // What no outline line spans, as the numbers and as runs of neighbours: a covered message between two of them parts two runs.
    expect(uncoveredMessages(files, chat)).toEqual([m(6).index, m(7).index, m(9).index, m(10).index]);
    expect(uncoveredRuns(files, chat)).toEqual([
      [m(6).index, m(7).index],
      [m(9).index, m(10).index],
    ]);
    // An outline that stops short leaves the chat's tail out: that is a run as well.
    await put(rig, "outline.md", `- #${m(0).index}–#${m(7).index} · The harbour and the lighthouse\n`);
    expect(uncoveredRuns(await readChronicle(learnedOf(rig)), chat)).toEqual([[m(8).index, m(11).index]]);
  });
});

describe("the chronicler, the story reader and the skills", () => {
  /** The tools that read a message of the chat: the chronicler holds none of them, and neither its instructions nor its skills send it to one. */
  const READS = ["chat_read", "chat_around", "chat_grep", "chat_search", "chat_about"];

  test("the chronicler is a definition the page would take: it holds delegate and the check, and no tool that reads a message", () => {
    const [chronicler] = recallAgents();
    if (!chronicler) throw new Error("no chronicler");
    const checked = checkAgent(chronicler, chronicler.tools);
    expect(checked.problems).toEqual([]);
    expect(checked.agent).toEqual(chronicler);
    expect(recallAgents().map((agent) => agent.id)).toEqual([CHRONICLER, READER]);
    expect(chronicler).toMatchObject({ id: CHRONICLER, given: "task", follows: "main", grant: "definition", connectionId: null, model: null });
    expect(chronicler.budget.toolTurns).toBe(40);
    expect(chronicler.tools).toEqual(["chat_outline", "book_outline", "book_read", "lore_search", "lore_read", "lore_about", "workspace_list", "workspace_read", "workspace_grep", "workspace_write", "workspace_edit", CHECK, "skill_load", "delegate"]);
    // Its instructions name the skills it loads and the agent it delegates to by their ids, which no placeholder fills.
    for (const word of ["learned/chronicle/", RECALL_SKILL.keep, RECALL_SKILL.learn, READER, "[#412 a3f9c27e]", "plan.md and unverified.md", "chronicle_check fails every line that cites nothing", "several delegate calls in one answer"]) expect(chronicler.instructions).toContain(word);
    for (const tool of READS) expect(chronicler.instructions).not.toContain(tool);
    // A tool it names that the run doesn't have is a problem the check reports.
    expect(checkAgent(chronicler, ["chat_outline"]).problems.length).toBeGreaterThan(0);
  });

  test("the story reader is a definition the page would take: tools that read and none that writes, its own whoever starts it, and the form it answers in", () => {
    const reader = recallAgents().find((agent) => agent.id === READER);
    if (!reader) throw new Error("no reader");
    const checked = checkAgent(reader, reader.tools);
    expect(checked.problems).toEqual([]);
    expect(checked.agent).toEqual(reader);
    expect(reader).toMatchObject({ name: "Story reader", given: "task", follows: "main", grant: "definition", connectionId: null, model: null });
    expect(reader.tools).toEqual(["chat_read", "chat_around", "chat_grep", "chat_search", "book_outline", "book_read", "lore_search", "lore_read", "lore_about"]);
    // By the registry's own word, every one of them reads.
    expect(reader.tools.map((name) => BASE_TOOLS.find((tool) => tool.name === name)?.tier)).toEqual(reader.tools.map(() => "read"));
    // The form: four headings, a cited line under each, and the line that says how far it read.
    const form = ["outline:", "- #120–#159 · The crossing: what happened, in a sentence. [#120 a3f9c27e] [#159 77b0d41c]", "facts:", "- One thing established and still true at the stretch's end. [#131 0c2e9a51]", "threads:", "- One thing left open. [#140 51aab3f0]", "cast:", "- Mara: where she is, in what state, what she wants, what she knows. [#158 9d1e6c07]", "read: #120 to #159"];
    expect(reader.instructions).toContain(`\n\n${form.join("\n")}\n\n`);
    // Its outline line is one the chronicle reads the span of, and each of its bullets cites as the check reads a citation.
    expect(outlineSpans(form.join("\n"))).toEqual([[120, 159]]);
    expect(form.filter((line) => line.startsWith("- ")).map((line) => citationsIn(line).length)).toEqual([2, 1, 1, 1]);
    for (const word of ["chat_read with from and to", "follow all the cursors at once", "“read: nothing”", "says truthfully how far you read", "stop reading and answer with what you have"]) expect(reader.instructions).toContain(word);
  });

  test("both skills are skills the page would take, the chronicler's own, and say what it must call", () => {
    expect(RECALL_SKILLS.map((s) => s.id)).toEqual([RECALL_SKILL.keep, RECALL_SKILL.learn]);
    for (const skill of RECALL_SKILLS) {
      const checked = checkSkill(skill);
      expect(checked.problems).toEqual([]);
      expect(checked.skill).toEqual(skill);
      // Neither sends the chronicler to a message, and both say what the four files may hold and what the check leaves alone.
      for (const tool of READS) expect(skill.body).not.toContain(tool);
      for (const word of ["chronicle_check", "chat_outline", "`stretches: true`", "`delegate`", `\`${READER}\``, "- #120 to #179 · 60 messages, 34,200 characters", "[#412 a3f9c27e]", "fails every line that cites nothing", "`plan.md` and `unverified.md` are working files", "rewritten or removed", "only the top of each file is given to the main agent", "Start no second reader"]) expect(skill.body).toContain(word);
    }
    const [keep, learn] = RECALL_SKILLS;
    // What a listing shows of the first: every agent that holds skill_load reads it each turn, the main agent among them.
    expect(keep?.description).toBe("For the chronicler: how to bring the chronicle up to date from a message on. The main agent doesn't load it: upkeep never costs the reply a round. When the turn's note says a job is worth it, job_start goes in the same answer as write_reply, with the task the note gives.");
    expect(keep?.body).not.toContain("job_start");
    for (const word of ["`chronicle_check` first", "`from`", "all of them in one answer", "outline.md", "facts.md", "threads.md", "cast.md"]) expect(keep?.body).toContain(word);
    for (const word of ["workspace_list", "book_outline", "learned/chronicle/plan.md", "`[x]`", "`[!]`", "`[~]`", "the newest stretch is read first", "about six", "merge and mark the plan", "no more sub-agents may be started", "stay `[ ]`", "learned/chronicle/unverified.md", "how many are left to read"]) expect(learn?.body).toContain(word);
  });
});
