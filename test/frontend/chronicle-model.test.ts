// What the Chronicle page shows (src/extension/frontend/chronicle-model.ts): which files it offers
// and under what names, a file's text as lines with their citations and the check's marks, the
// counts and the words for what no longer holds, how a cited message stands, and the card for
// learning the story in every state a job can leave it in.

import { describe, expect, test } from "bun:test";
import { agentChoices, agentsPath, allowanceWords, BUDGET_MARGIN, budgetFor, CARRY_ON, carryOnGrant, type ChronLine, citedBadge, citedNote, citedState, countsOf, estimateWords, extraPaths, failedPlaces, failedWords, failingLines, failWords, fileChoices, fileLabel, grantWords, hasChronicle, learnBlock, learnBody, learnDraft, linesOf, marksOf, moveWords, nextPlace, ownFiles, progressOf, quietWords, saidBy, shownChoice, storyCard, storyJobOf, workspaceTarget } from "../../src/extension/frontend/chronicle-model";
import type { ChronicleView, CitedView, JobView, StoryEstimate, StoryView } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const DIR = "learned/chronicle/";

const file = (name: string): ChronicleView["files"][number] => ({ path: `${DIR}${name}`, chars: 400, lines: 6, cited: 4, failed: 0 });
const view = (over: Partial<ChronicleView> = {}): ChronicleView => ({ files: [file("outline.md"), file("facts.md"), file("threads.md"), file("cast.md")], failures: [], moved: [], uncited: [], ...over });
const failure = (name: string, line: number, index: number, why: "gone" | "changed", text = `- A line of ${name} [#${index} a3f9c27e]`): ChronicleView["failures"][number] => ({ path: `${DIR}${name}`, line, text, citation: `[#${index} a3f9c27e]`, index, why });

/** A line as it would read on the page: its words, with each citation as the press it becomes. */
const shown = (line: ChronLine): string => line.pieces.map((p) => ("text" in p ? p.text : `<#${p.cite.index}>`)).join("");

describe("the files the page offers", () => {
  test("the chronicle's own four come in a reader's order, under plain names, whatever order the check gave them in", () => {
    const mixed = view({ files: [file("cast.md"), file("threads.md"), file("outline.md"), file("facts.md")] });
    expect(ownFiles(mixed).map((f) => f.path)).toEqual([`${DIR}outline.md`, `${DIR}facts.md`, `${DIR}threads.md`, `${DIR}cast.md`]);
    expect(fileChoices(mixed, []).map((c) => c.label)).toEqual(["Outline", "Established", "Open threads", "Cast"]);
    expect(fileChoices(mixed, []).every((c) => c.own && c.about !== null)).toBe(true);
  });

  test("what else the chronicle's folder holds follows: the plan, what wasn't verified, then any other by its own name", () => {
    const listed = [{ path: "chronicle/unverified.md" }, { path: "people/okoro.md" }, { path: "chronicle/facts.md" }, { path: "chronicle/tides.md" }, { path: "chronicle/plan.md" }];
    const extras = extraPaths(listed, null);
    expect(extras).toEqual([`${DIR}plan.md`, `${DIR}unverified.md`, `${DIR}tides.md`]);
    expect(fileChoices(view(), extras).map((c) => c.label)).toEqual(["Outline", "Established", "Open threads", "Cast", "Plan", "Not verified", "tides.md"]);
    expect(fileChoices(view(), extras).filter((c) => !c.own).map((c) => c.failed)).toEqual([0, 0, 0]);
    expect(fileLabel("chronicle/unverified.md")).toBe("Not verified");
  });

  test("the story's plan is offered though the listing hasn't it yet, and never twice", () => {
    expect(extraPaths([], `${DIR}plan.md`)).toEqual([`${DIR}plan.md`]);
    expect(extraPaths([{ path: "chronicle/plan.md" }], `${DIR}plan.md`)).toEqual([`${DIR}plan.md`]);
  });

  test("a chat has a chronicle once one of the four is there: a plan alone is none yet", () => {
    expect(hasChronicle(view({ files: [] }))).toBe(false);
    expect(hasChronicle(view({ files: [file("plan.md")] }))).toBe(false);
    expect(hasChronicle(view({ files: [file("cast.md")] }))).toBe(true);
  });

  test("each file says how many of its lines fail, a line once however many of its citations do", () => {
    const failing = view({ failures: [failure("facts.md", 10, 23, "changed"), failure("facts.md", 10, 40, "changed"), failure("threads.md", 7, 49, "gone")] });
    expect(fileChoices(failing, []).map((c) => [c.label, c.failed])).toEqual([["Outline", 0], ["Established", 1], ["Open threads", 1], ["Cast", 0]]);
  });

  test("the file shown is the one asked for, by either way of writing its path; else the first", () => {
    const choices = fileChoices(view(), [`${DIR}plan.md`]);
    expect(shownChoice(choices, `${DIR}threads.md`)?.label).toBe("Open threads");
    expect(shownChoice(choices, "chronicle/plan.md")?.label).toBe("Plan");
    expect(shownChoice(choices, `${DIR}gone.md`)?.label).toBe("Outline");
    expect(shownChoice(choices, null)?.label).toBe("Outline");
    expect(shownChoice([], null)).toBeNull();
    expect(agentsPath("chronicle/cast.md")).toBe(`${DIR}cast.md`);
  });

  test("a file opens in the Workspace under learned/, as it stands", () => {
    expect(workspaceTarget(`${DIR}facts.md`)).toEqual({ area: "learned", path: "chronicle/facts.md", hash: null });
    expect(workspaceTarget("chronicle/facts.md")).toEqual({ area: "learned", path: "chronicle/facts.md", hash: null });
  });
});

describe("a file's text as lines", () => {
  const TEXT = ["# Established", "", "## The ledger", "- It is kept in the harbour office, in the back room cabinet [#41 0b1c5d2f]", "- Okoro signs it on the first [#29 77aa01be]; no one else does [#38 a3f9c27e].", "  - Joss watched him", "1. Read #1 to #400 closely.", "Left out: the weather."].join("\n");

  test("headings, bullets, numbered items and plain words are told apart, and empty lines dropped with the numbers kept", () => {
    const lines = linesOf(TEXT, null);
    expect(lines.map((l) => [l.n, l.kind, l.level, l.marker])).toEqual([
      [1, "heading", 1, null],
      [3, "heading", 2, null],
      [4, "item", 0, null],
      [5, "item", 0, null],
      [6, "item", 1, null],
      [7, "item", 0, "1."],
      [8, "text", 0, null],
    ]);
    expect(lines.map(shown)).toEqual(["Established", "The ledger", "It is kept in the harbour office, in the back room cabinet<#41>", "Okoro signs it on the first<#29>; no one else does<#38>.", "Joss watched him", "Read #1 to #400 closely.", "Left out: the weather."]);
  });

  test("a citation is cut out of the words and stands as a press where it stood", () => {
    const [, , kept, signed] = linesOf(TEXT, null);
    if (!kept || !signed) throw new Error("the text has fewer lines than it was written with");
    expect(shown(kept)).toBe("It is kept in the harbour office, in the back room cabinet<#41>");
    expect(shown(signed)).toBe("Okoro signs it on the first<#29>; no one else does<#38>.");
    expect(signed.citations.map((c) => c.citation)).toEqual(["[#29 77aa01be]", "[#38 a3f9c27e]"]);
    expect(signed.pieces.flatMap((p) => ("cite" in p ? [p.nth] : []))).toEqual([0, 1]);
  });

  test("an outline's item that opens with message numbers is an item, not a heading", () => {
    const [line] = linesOf("- #1 to #16: Mara crosses on the packet boat [#2 9f3c44d0]", null);
    expect(line?.kind).toBe("item");
    expect(line ? shown(line) : "").toBe("#1 to #16: Mara crosses on the packet boat<#2>");
  });

  test("the check's marks land on their lines: what fails and why, what moved, what cites nothing", () => {
    const checked = view({ failures: [failure("facts.md", 5, 38, "changed")], moved: [{ path: `${DIR}facts.md`, line: 4, citation: "[#41 0b1c5d2f]", index: 41, now: 40 }], uncited: [{ path: `${DIR}facts.md`, line: 6, text: "  - Joss watched him" }, { path: `${DIR}cast.md`, line: 4, text: "- The pilot" }] });
    const lines = linesOf(TEXT, marksOf(checked, `${DIR}facts.md`));
    const at = (n: number): ChronLine | undefined => lines.find((l) => l.n === n);
    expect(at(5)?.fails).toEqual([{ index: 38, citation: "[#38 a3f9c27e]", why: "changed" }]);
    expect(at(4)?.moves).toEqual([{ index: 41, citation: "[#41 0b1c5d2f]", now: 40 }]);
    expect(at(6)?.uncited).toBe(true);
    // Another file's marks are not this one's, though they share a line number.
    expect(at(4)?.uncited).toBe(false);
    expect(lines.filter((l) => l.fails.length > 0).length).toBe(1);
  });

  test("a file the check doesn't read carries no marks", () => {
    expect(linesOf(TEXT, null).every((l) => l.fails.length === 0 && l.moves.length === 0 && !l.uncited)).toBe(true);
  });
});

describe("the counts and the words for what no longer holds", () => {
  const checked = view({
    failures: [failure("threads.md", 7, 49, "gone"), failure("facts.md", 10, 23, "changed"), failure("facts.md", 10, 40, "changed"), failure("facts.md", 3, 9, "gone")],
    moved: [{ path: `${DIR}cast.md`, line: 5, citation: "[#45 77aa01be]", index: 45, now: 44 }],
    uncited: [{ path: `${DIR}facts.md`, line: 14, text: "- Joss never lies to Mara" }, { path: `${DIR}threads.md`, line: 9, text: "- Where is the pilot?" }],
  });

  test("lines are counted once each", () => {
    expect(countsOf(checked)).toEqual({ failed: 3, moved: 1, uncited: 2 });
    expect(countsOf(view())).toEqual({ failed: 0, moved: 0, uncited: 0 });
  });

  test("the count that leads to them reads as a sentence", () => {
    expect(failedWords(3)).toBe("3 lines no longer hold");
    expect(failedWords(1)).toBe("1 line no longer holds");
    expect(quietWords({ moved: 1, uncited: 2 })).toBe("2 lines cite no message. 1 line cites a message that stands unchanged at another number now.");
    expect(quietWords({ moved: 0, uncited: 1 })).toBe("1 line cites no message.");
    expect(quietWords({ moved: 0, uncited: 0 })).toBeNull();
  });

  test("the failing lines come file by file in the page's order, then down each file", () => {
    expect(failedPlaces(checked)).toEqual([
      { path: `${DIR}facts.md`, line: 3 },
      { path: `${DIR}facts.md`, line: 10 },
      { path: `${DIR}threads.md`, line: 7 },
    ]);
  });

  test("the next one follows the one the reader stands on, and the first follows the last", () => {
    const places = failedPlaces(checked);
    expect(nextPlace(places, null)).toEqual({ path: `${DIR}facts.md`, line: 3 });
    expect(nextPlace(places, { path: `${DIR}facts.md`, line: 3 })).toEqual({ path: `${DIR}facts.md`, line: 10 });
    expect(nextPlace(places, { path: "chronicle/threads.md", line: 7 })).toEqual({ path: `${DIR}facts.md`, line: 3 });
    expect(nextPlace(places, { path: `${DIR}cast.md`, line: 1 })).toEqual({ path: `${DIR}facts.md`, line: 3 });
    expect(nextPlace([], null)).toBeNull();
  });

  test("a failing line says why, and that agents are no longer given it", () => {
    expect(failWords([{ index: 40, citation: "[#40 a3f9c27e]", why: "changed" }])).toBe("No longer holds: message #40 has changed since this was written (a swipe or an edit). Agents are no longer given this line.");
    expect(failWords([{ index: 49, citation: "[#49 a3f9c27e]", why: "gone" }])).toBe("No longer holds: message #49 is gone from the chat. Agents are no longer given this line.");
    expect(
      failWords([
        { index: 23, citation: "[#23 a3f9c27e]", why: "changed" },
        { index: 40, citation: "[#40 a3f9c27e]", why: "changed" },
        { index: 49, citation: "[#49 a3f9c27e]", why: "gone" },
      ]),
    ).toBe("No longer holds: messages #23 and #40 have changed since this was written (a swipe or an edit), and message #49 is gone from the chat. Agents are no longer given this line.");
  });

  test("a moved citation says where its message stands now, and that the line holds", () => {
    expect(moveWords([{ index: 45, citation: "[#45 77aa01be]", now: 44 }])).toBe("Message #45 stands unchanged at #44 now, so the line still holds.");
    expect(moveWords([{ index: 45, citation: "[#45 77aa01be]", now: 44 }, { index: 47, citation: "[#47 0b1c5d2f]", now: 46 }])).toBe("#45 stands at #44 now, #47 stands at #46 now: each unchanged, so the line still holds.");
  });

  test("showing only the failing lines needs no file read: each file's lines come as the check gave them", () => {
    const groups = failingLines(checked);
    expect(groups.map((g) => [g.label, g.lines.map((l) => l.n)])).toEqual([["Established", [3, 10]], ["Open threads", [7]]]);
    const [, twice] = groups[0]?.lines ?? [];
    expect(twice?.fails.map((f) => f.index)).toEqual([23, 40]);
    expect(twice ? shown(twice) : "").toBe("A line of facts.md<#23>");
  });

  test("a failing line given without its bullet or its citations still shows as an item with the citations that fail", () => {
    const bare = view({ failures: [failure("facts.md", 10, 40, "changed", "Brann holds the only key to it")] });
    const [line] = failingLines(bare)[0]?.lines ?? [];
    expect(line?.kind).toBe("item");
    expect(line ? shown(line) : "").toBe("Brann holds the only key to it<#40>");
    expect(line?.citations.map((c) => c.citation)).toEqual(["[#40 a3f9c27e]"]);
  });
});

describe("a cited message", () => {
  const message = { index: 38, role: "assistant", name: "Joss", at: T0, text: '"Okoro signed it on the first," Joss said.' };

  test("one that still says what was cited needs no word", () => {
    const cited: CitedView = { index: 38, ok: true, message };
    expect(citedState(cited)).toBe("holds");
    expect(citedBadge(cited)).toBeNull();
    expect(citedNote(cited)).toBeNull();
  });

  test("one whose text changed says so, and that what cites it no longer holds", () => {
    const cited: CitedView = { index: 40, ok: false, why: "changed", message: { ...message, index: 40 } };
    expect(citedState(cited)).toBe("changed");
    expect(citedBadge(cited)).toMatchObject({ word: "changed", icon: "alert" });
    expect(citedNote(cited)).toContain("swiped or edited");
  });

  test("one that is gone has no text to show, and says why", () => {
    const cited: CitedView = { index: 49, ok: false, why: "gone", message: null };
    expect(citedState(cited)).toBe("gone");
    expect(citedBadge(cited)).toMatchObject({ word: "gone" });
    expect(citedNote(cited)).toBe("This message is gone from the chat, so what cites it no longer holds.");
  });

  test("one that moved holds, and says where it stands now", () => {
    const cited: CitedView = { index: 45, ok: true, why: "moved", now: 44, message: { ...message, index: 44 } };
    expect(citedState(cited)).toBe("moved");
    expect(citedBadge(cited)).toMatchObject({ word: "now #44" });
    expect(citedNote(cited)).toContain("unchanged at #44 now");
  });

  test("who said it is its name, else its role in words", () => {
    expect(saidBy({ name: "Joss", role: "assistant" })).toBe("Joss");
    expect(saidBy({ name: "  ", role: "user" })).toBe("You");
    expect(saidBy({ name: "", role: "assistant" })).toBe("The character");
    expect(saidBy({ name: "", role: "narrator" })).toBe("narrator");
  });
});

const USAGE: JobView["usage"] = { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0, cost: 0 };
const job = (over: Partial<JobView> = {}): JobView => ({ id: "job-story", chatId: "chat-brann", agent: "archivist", task: "Learn this story from its start.", when: "now", state: "running", by: { who: "user" }, basis: null, createdAt: T0, usage: USAGE, ...over });
/** What learning all of Brann's chat is expected to take, and what is left of it once the winter is learned. */
const WHOLE: StoryEstimate = { messages: 2412, chars: 2_170_800, stretches: 41, promptTokens: 1_200_000, cachedTokens: 800_000, writtenTokens: 60_000, weighedTokens: 480_000, toolTurns: 130, usd: 1.9 };
const REST: StoryEstimate = { messages: 1112, chars: 1_000_800, stretches: 19, promptTokens: 500_000, cachedTokens: 333_000, writtenTokens: 30_000, weighedTokens: 200_000, toolTurns: 60, usd: 0.8 };
const story = (over: Partial<StoryView> = {}): StoryView => ({ job: null, plan: null, messages: 2412, covered: 0, suggested: { task: "Learn this story from its start.", agent: "archivist" }, estimate: WHOLE, refused: null, ...over });
const card = (of: Partial<StoryView>, more: Partial<Parameters<typeof storyCard>[0]> = {}) => storyCard({ story: story(of), active: [], held: new Set(), switches: { off: false, paused: false }, has: false, on: true, ...more });

describe("how far the chronicle has come", () => {
  test("it says how many of the chat's messages it covers, with the share where the chat is long", () => {
    expect(progressOf({ messages: 48, covered: 47 })).toEqual({ words: "The chronicle covers 47 of 48 messages.", fraction: 47 / 48, behind: 1 });
    expect(progressOf({ messages: 2412, covered: 1300 })).toMatchObject({ words: "The chronicle covers 1,300 of 2,412 messages (53%).", behind: 1112 });
    expect(progressOf({ messages: 2412, covered: 0 })).toEqual({ words: "The chronicle covers 0 of 2,412 messages.", fraction: 0, behind: 2412 });
  });

  test("a chronicle that spans the chat says so, and a chat with no message has no bar", () => {
    expect(progressOf({ messages: 48, covered: 48 })).toEqual({ words: "The chronicle covers all 48 messages.", fraction: 1, behind: 0 });
    expect(progressOf({ messages: 1, covered: 1 }).words).toBe("The chronicle covers the chat's one message.");
    expect(progressOf({ messages: 0, covered: 0 })).toEqual({ words: "This chat has no messages yet.", fraction: null, behind: 0 });
    // More covered than there is (a message was deleted since) is all of it, never more.
    expect(progressOf({ messages: 48, covered: 50 })).toMatchObject({ fraction: 1, behind: 0 });
  });
});

describe("the card for learning the story", () => {
  test("with no chronicle and no job, Learn this story is the thing to do, and what it should cost is said first", () => {
    const c = card({});
    expect(c).toMatchObject({ state: "offer", title: "This chat has no chronicle yet", learn: true, job: null, badge: null, live: false });
    expect(c.estimate).toBe("Learning the 2,412 messages the chronicle doesn't cover yet should cost about $1.90 (about 1.2M tokens read and 60k written).");
    expect(c.text).toContain("reads the chat from its start");
    expect(c.text).toContain("a budget sized to that");
    expect(c.actions).toEqual({ cancel: false, again: false, grant: false, carryOn: false, resume: false });
  });

  test("a chronicle that is behind the chat offers it too, in words for what is missing", () => {
    const c = card({ messages: 48, covered: 47, estimate: { ...REST, messages: 1 } }, { has: true });
    expect(c).toMatchObject({ state: "offer", title: "The chronicle is behind the chat", learn: true });
    expect(c.text).toContain("reads what is missing");
    expect(c.estimate).toStartWith("Learning the one message the chronicle doesn't cover yet should cost about $0.80");
    expect(c.progress.words).toBe("The chronicle covers 47 of 48 messages.");
  });

  test("a chronicle that spans the chat offers nothing", () => {
    expect(card({ messages: 48, covered: 48 }, { has: true })).toMatchObject({ state: "whole", title: "The chronicle is up to date", learn: false, text: "" });
  });

  test("a chat with no message has nothing to learn", () => {
    const c = card({ messages: 0 });
    expect(c).toMatchObject({ state: "empty", learn: false });
    expect(c.text).toContain("no messages yet");
  });

  test("a chat LumiAH isn't switched on for is sent to Home, not offered a job that can't start", () => {
    const c = card({}, { on: false });
    expect(c).toMatchObject({ state: "off", learn: false, title: "This chat has no chronicle yet" });
    expect(c.text).toContain("Switch it on at Home");
    // Until the page knows, the offer stands: the backend says why if it can't be.
    expect(card({}, { on: null }).state).toBe("offer");
  });

  test("a job that waits says so, and can be cancelled", () => {
    const c = card({ job: job({ state: "queued" }) }, { switches: { off: false, paused: true } });
    expect(c).toMatchObject({ state: "waiting", title: "Learning this story: waiting to start", live: true, learn: false });
    expect(c.text).toContain("jobs are paused");
    expect(c.actions.cancel).toBe(true);
    expect(c.badge).toMatchObject({ word: "queued" });
  });

  test("a job that runs is followed, and says when it is held", () => {
    const running = card({ job: job({}), covered: 400 });
    expect(running).toMatchObject({ state: "running", title: "Learning this story", live: true, learn: false });
    expect(running.badge).toMatchObject({ word: "running" });
    const held = card({ job: job({}) }, { held: new Set(["job-story"]) });
    expect(held).toMatchObject({ state: "running", title: "Learning this story: paused" });
    expect(held.badge).toMatchObject({ word: "paused" });
  });

  test("out of budget, it says so plainly with the backend's reason, what the rest should cost, and one press carries it on", () => {
    const c = card({ job: job({ state: "spent", stoppedAt: "allowance", reason: "It reached its budget of 720,000 tokens read.", report: "a".repeat(64), opening: "Stopped at my budget." }), covered: 1300, estimate: REST });
    expect(c).toMatchObject({ state: "spent", title: "Learning this story ran out of budget", live: false });
    expect(c.estimate).toBe("Learning the 1,112 messages the chronicle doesn't cover yet should cost about $0.80 (about 500k tokens read and 30k written).");
    expect(c.text).toBe(`Nothing it wrote is lost. ${CARRY_ON} gives it what the rest should need, and it goes on from where it stopped.`);
    expect(c.reason).toEqual({ title: "Why it stopped", text: "It reached its budget of 720,000 tokens read.", tone: "warn" });
    expect(c.actions).toEqual({ cancel: false, again: false, grant: true, carryOn: false, resume: false });
    expect(c.badge).toMatchObject({ word: "out of budget" });
  });

  test("paused at a day's limit, it reads the same way, and carries on as it is", () => {
    const c = card({ job: job({ state: "spent", stoppedAt: "day", reason: "Jobs have used the 2,000,000 tokens a day Settings allow them." }), covered: 1300, estimate: REST });
    expect(c).toMatchObject({ state: "spent", title: "Learning this story is paused at a day's limit", live: false });
    expect(c.estimate).toContain("1,112 messages");
    expect(c.text).toContain("once the last 24 hours count less or you have raised that limit");
    expect(c.actions).toEqual({ cancel: false, again: false, grant: false, carryOn: true, resume: false });
    expect(c.badge).toMatchObject({ word: "at a day's limit" });
  });

  test("held with no run, it can be resumed", () => {
    const c = card({ job: job({ state: "paused", paused: true }) });
    expect(c).toMatchObject({ state: "paused", title: "Learning this story is on hold" });
    expect(c.actions.resume).toBe(true);
  });

  test("cut off, failed or cancelled, it says which and why, and can be started again", () => {
    expect(card({ job: job({ state: "interrupted" }) })).toMatchObject({ state: "ended", title: "Learning this story was cut off", actions: { again: true } });
    const failed = card({ job: job({ state: "failed", reason: "Its connection refused the call." }) });
    expect(failed).toMatchObject({ state: "ended", title: "Learning this story failed", reason: { title: "Why it failed", tone: "neg" } });
    expect(card({ job: job({ state: "cancelled", reason: "You cancelled it." }) })).toMatchObject({ state: "ended", title: "Learning this story was cancelled", reason: { title: "Why it was cancelled", tone: "warn" } });
  });

  test("a job that ended badly is forgotten once the chronicle spans the chat", () => {
    expect(card({ job: job({ state: "cancelled" }), messages: 48, covered: 48 }, { has: true })).toMatchObject({ state: "whole", job: null });
  });

  test("done, it says so; and where the chat has gone on since, the rest can be learned", () => {
    const whole = card({ job: job({ state: "done", opening: "Learned the story to its latest message." }), covered: 2412 }, { has: true });
    expect(whole).toMatchObject({ state: "done", title: "This story is learned", learn: false, live: false });
    // Its report is with the job, a press away, not under this card: the card says so rather than point below.
    expect(whole.text).toContain("open the job to read it");
    expect(card({ job: job({ state: "done" }), covered: 2400 }, { has: true })).toMatchObject({ state: "done", learn: true });
    expect(card({ job: job({ state: "done" }), covered: 2400 }, { has: true, on: false })).toMatchObject({ state: "done", learn: false });
  });

  test("while the job isn't over, the state's own copy of it is the one shown", () => {
    const read = story({ job: job({ state: "queued" }) });
    const now = job({ state: "running", usage: { ...USAGE, calls: 3 } });
    expect(storyJobOf(read, [job({ id: "job-other" }), now])).toBe(now);
    expect(storyJobOf(read, [])?.state).toBe("queued");
    expect(storyJobOf(story({}), [now])).toBeNull();
    expect(storyCard({ story: read, active: [now], held: new Set(), switches: { off: false, paused: false }, has: false, on: true }).state).toBe("running");
  });
});

describe("what learning the rest is expected to take, and the budget sized to it", () => {
  const NONE_LEFT: StoryEstimate = { ...WHOLE, messages: 0, chars: 0, stretches: 0, promptTokens: 0, weighedTokens: 0, writtenTokens: 0, toolTurns: 0, usd: 0 };

  test("the estimate is said in money where the model has a price, and in tokens where it has none", () => {
    expect(estimateWords(WHOLE)).toBe("Learning the 2,412 messages the chronicle doesn't cover yet should cost about $1.90 (about 1.2M tokens read and 60k written).");
    expect(estimateWords({ ...WHOLE, usd: null })).toBe("Learning the 2,412 messages the chronicle doesn't cover yet should take about 1.2M tokens read and 60k written. The model that does it has no price set, so that can't be said in money.");
    // Nothing left to learn is nothing to say.
    expect(estimateWords(NONE_LEFT)).toBe("");
  });

  test("the budget offered is the estimate and half as much again, as a budget counts it, with time left to Settings", () => {
    expect(BUDGET_MARGIN).toBe(1.5);
    expect(budgetFor(WHOLE)).toEqual({ tokensIn: 720_000, tokensOut: 90_000, toolTurns: 195 });
    // A figure is rounded up to one a person reads.
    expect(budgetFor({ ...WHOLE, weighedTokens: 480_001, writtenTokens: 100, toolTurns: 1 })).toEqual({ tokensIn: 721_000, tokensOut: 1000, toolTurns: 2 });
    expect(budgetFor(NONE_LEFT)).toEqual({});
  });

  test("Carry on to the end raises each limit by what the rest should need, from what the job has used, and takes time from its own pace", () => {
    const spent = job({ state: "spent", stoppedAt: "allowance", allowance: { tokensIn: 720_000, tokensOut: 90_000, toolTurns: 195 }, usage: { ...USAGE, calls: 80, toolTurns: 70, in: 1_000_000, cachedIn: 700_000, out: 40_000 }, workedMs: 20 * 60_000 });
    const grant = carryOnGrant(spent, REST);
    // Half the tokens are still to read: half the time again, with the margin, on top of the twenty minutes worked.
    expect(grant).toEqual({ tokensIn: 1_300_000, tokensOut: 135_000, toolTurns: 285, wallMs: 35 * 60_000 });
    expect(grantWords(grant)).toBe("Its budget becomes 1,300,000 tokens read, 135,000 tokens written, 285 rounds of tool calls, 35 minutes, counting what it has used.");
    // Every limit it had is raised, never lowered: the one it ran out at is among them, whichever it was.
    for (const key of ["tokensIn", "tokensOut", "toolTurns"] as const) expect(grant[key] ?? 0).toBeGreaterThan(spent.allowance?.[key] ?? 0);
  });

  test("a limit the job had lifted stays lifted, and one it used nothing of is left as it was", () => {
    const lifted = job({ state: "spent", allowance: { tokensIn: null, tokensOut: 90_000 }, usage: { ...USAGE, in: 400_000, out: 90_100, toolTurns: 12 }, workedMs: 0 });
    const grant = carryOnGrant(lifted, REST);
    expect(Object.hasOwn(grant, "tokensIn")).toBe(false);
    expect(Object.hasOwn(grant, "wallMs")).toBe(false);
    expect(grant.tokensOut).toBe(136_000);
    expect(grant.toolTurns).toBe(102);
  });

  test("where the estimate says nothing is left, one press still gives it room to finish: a tenth of what it used", () => {
    const nearly = job({ state: "spent", allowance: { tokensIn: 720_000 }, usage: { ...USAGE, in: 900_000, out: 50_000, toolTurns: 100 }, workedMs: 30 * 60_000 });
    const grant = carryOnGrant(nearly, NONE_LEFT);
    expect(grant).toEqual({ tokensIn: 990_000, tokensOut: 55_000, toolTurns: 110, wallMs: 33 * 60_000 });
  });
});

describe("what Learn this story starts", () => {
  test("the form opens with what was suggested and a budget sized to the story, which starts untouched", () => {
    const draft = learnDraft(story({}));
    expect(draft.task).toBe("Learn this story from its start.");
    expect(draft.agent).toBe("archivist");
    expect(learnBlock(draft)).toBeNull();
    expect(learnBody("chat-brann", draft)).toEqual({ chatId: "chat-brann", agent: "archivist", task: "Learn this story from its start.", when: "now", allowance: { tokensIn: 720_000, tokensOut: 90_000, toolTurns: 195 }, story: true });
  });

  test("what the user changed is what is sent, the time in minutes as typed", () => {
    const draft = learnDraft(story({}));
    const changed = { ...draft, task: "  Learn the winter only.  ", agent: "reader", allowance: { ...draft.allowance, tokensIn: { mode: "set" as const, value: 150_000 }, tokensOut: { mode: "none" as const, value: 40_000 }, toolTurns: { mode: "settings" as const, value: 40 }, wallMs: { mode: "set" as const, value: 10 } } };
    expect(learnBody("chat-brann", changed)).toEqual({ chatId: "chat-brann", agent: "reader", task: "Learn the winter only.", when: "now", allowance: { tokensIn: 150_000, tokensOut: null, wallMs: 10 * 60_000 }, story: true });
  });

  test("with nothing left to learn no budget is sent, so Settings' limits stand", () => {
    const draft = learnDraft({ suggested: { task: "Learn it.", agent: "main" }, estimate: { ...WHOLE, messages: 0 } });
    expect(learnBody("chat-mara", draft)).toEqual({ chatId: "chat-mara", agent: "main", task: "Learn it.", when: "now", story: true });
    expect(allowanceWords(draft.allowance)).toBe("Its budget: what Settings allow each job.");
  });

  test("its budget is said in a sentence before it is started: the figures it holds, and Settings' limits for the rest", () => {
    const draft = learnDraft(story({}));
    expect(allowanceWords(draft.allowance)).toBe("Its budget: at most 720,000 tokens read, 90,000 tokens written, 195 rounds of tool calls. Settings' limits stand for the rest.");
    expect(allowanceWords({ ...draft.allowance, tokensOut: { mode: "none", value: 0 }, toolTurns: { mode: "set", value: 1 }, wallMs: { mode: "set", value: 30 } })).toBe("Its budget: at most 720,000 tokens read, any number of tokens written, 1 round of tool calls, 30 minutes.");
  });

  test("an objective emptied out can't be started, and says what to do", () => {
    const draft = { ...learnDraft(story({})), task: "  \n " };
    expect(learnBlock(draft)).toContain("What it is asked");
  });

  test("the agent the form holds leads the choice, named even where the list hasn't it", () => {
    const agents = [{ id: "writer", name: "Writer" }, { id: "archivist", name: "Archivist" }, { id: "main", name: "Main agent" }];
    const name = (id: string): string => agents.find((a) => a.id === id)?.name ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
    expect(agentChoices("archivist", agents, name)).toEqual([{ value: "archivist", label: "Archivist" }, { value: "main", label: "Main agent" }, { value: "writer", label: "Writer" }]);
    expect(agentChoices("chronicler", [], name)).toEqual([{ value: "chronicler", label: "Chronicler" }]);
  });
});

describe("a story LumiAH's own agents don't keep", () => {
  test("nothing can be started or carried on, and the card says why in the core's words", () => {
    const refused = "Tide keeper gives this chat an agent of its own in place of LumiAH's chronicler, so LumiAH keeps no chronicle for it and doesn't learn its story.";
    expect(card({ refused })).toMatchObject({ state: "refused", text: refused, learn: false, actions: { again: false, carryOn: false, grant: false, resume: false } });
    // A learning that ended before: not carried on or started again here either.
    expect(card({ refused, job: job({ state: "done" }) })).toMatchObject({ state: "refused", learn: false });
    expect(card({ refused, job: job({ state: "spent" }) })).toMatchObject({ state: "refused", learn: false, actions: { carryOn: false, grant: false } });
  });
});
