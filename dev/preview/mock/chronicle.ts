// The Chronicle page's part of the stand-in backend (DESIGN §24.7, §22). Two made-up chats have a
// story here: the harbour chat has a chronicle of some thirty lines over its 48 messages, with one
// line whose message was swiped since, one whose message is gone, and one whose message stands at
// another number now; the long chat has none yet, so its story can be learned. The check is worked
// out by code each time it is read, with core's own reading of a citation, from the files as they
// stand and the messages as they stand. A job started as the learning of a story plays a run of its
// own (`storyRun`, which the jobs' part plays): it writes its plan first, then the chronicle a part
// of the chat at a time, and stops at its allowance half-way through the long chat; granted more,
// it carries on and finishes. The files are read as any workspace file is (`read`, `list`).

import { checkCitation, citationsIn, citeOf, namedMessage, placesOf } from "../../../src/core/recall/cite";
import type { ChronicleView, CitedView, FileAuthor, FileChange, JobAllowance, JobView, JsonObject, StoryEstimate, StoryView, ToolCallView, UiRequestOf, UiRequests, WorkspaceFile, WorkspaceView } from "../../../src/shared/ui";
import type { PlayStep, Trace } from "../fixtures";
import { type Handlers, hashOf, type MockCtx, Refusal, type StoryCtx } from "./ctx";

type Requests = "lah.chronicle.get" | "lah.chronicle.cited" | "lah.story.get";

const MIN = 60_000;

/** The folder of the chronicle within `learned/`, and as the agents write it. */
const DIR = "chronicle/";
const AGENTS_DIR = `learned/${DIR}`;

/** The chronicle's own four files, which the check reads, and what stands at the head of each. */
const OWN = ["outline.md", "facts.md", "threads.md", "cast.md"] as const;
const PLAN = "plan.md";
const UNVERIFIED = "unverified.md";
const TITLES: Readonly<Record<string, string>> = { "outline.md": "Outline", "facts.md": "Established", "threads.md": "Open threads", "cast.md": "Cast", [UNVERIFIED]: "Not verified" };

/** A message of a made-up chat: who wrote it (the user, or the character) and what it says. */
type Said = readonly [who: "user" | "character", text: string];

/**
 * A line of a made-up file. `{38}` in its words cites message 38 as it read when the line was
 * written. `from` and `until` are the parts of the learning it stands for: there once part `from`
 * has been written (left out: there before any learning), gone once part `until` has.
 */
interface Row {
  file: string;
  text: string;
  from?: number;
  until?: number;
}

/** A part of the learning: what the agent reads for it (a tool call, the messages that come back, and what it makes of them), before it writes the files as they stand after the part. */
interface Part {
  thinks: string;
  reads: { name: string; args: JsonObject; lead: string; shows: readonly number[] };
}

/** A made-up chat with a story to keep a chronicle of. */
interface Tale {
  messages: number;
  user: string;
  character: string;
  /** The messages the chronicle cites, by number, as they stand now. The rest have no words of their own. */
  said: Readonly<Record<number, Said>>;
  /** What a message read when the chronicle cited it, where that is no longer what stands at its number. */
  then: Readonly<Record<number, string>>;
  rows: readonly Row[];
  /** The learning's parts, the plan first. */
  parts: readonly Part[];
  /** The plan as it stands once part `done` is written, for a job told `allowance`. */
  plan(done: number, allowance: string): string;
  /** The part after which a run that has an allowance stops at it; null: the story is short enough to learn in one run. */
  pause: number | null;
  /** What a run reports: stopped at its allowance, or done. */
  report: { spent: string; done: string };
}

const row = (file: string, text: string, from?: number, until?: number): Row => ({ file, text, ...(from !== undefined ? { from } : {}), ...(until !== undefined ? { until } : {}) });

const reportOf = (opening: string, did: readonly string[], left: readonly string[]): string => `${opening}\n\n## What I did\n${did.map((line) => `- ${line}`).join("\n")}\n\n## What is left\n${left.map((line) => `- ${line}`).join("\n")}`;

/** A plan's part with how it stands: done, next, or still to come. */
const planned = (done: number, part: number, words: string): string => `${part}. ${words}${part <= done ? " Done." : part === done + 1 ? " Next." : ""}`;

// ---------------------------------------------------------------- the harbour chat

const MARA: Tale = {
  messages: 48,
  user: "Mara",
  character: "Joss",
  said: {
    2: ["character", 'The packet boat rode low past the breakwater. A deckhand nodded at the grey roofs. "Harbour town. If it is the pilot you are after, ask at the Gull. He drank there, when he drank."'],
    5: ["user", 'I unfold the letter again. "Come before the first. The ledger will not wait." No name under it.'],
    9: ["character", '"The pilot?" The deckhand spat over the rail. "Not seen since the autumn storms. His tab is still chalked up at the Gull."'],
    17: ["character", "Dusk had come down by the time the gangway was run out. The Gull stood over the quay with one lamp lit, and Joss, behind the counter, gave her the room over the taproom without asking how long she meant to stay."],
    19: ["character", 'Joss turned a glass in the cloth. "The pilot\'s ledger? The harbour office keeps it. Every ship he brought in, and what was owed for it."'],
    21: ["character", 'Ilse did not look up from the net. "I mend nets. I don\'t talk about the pilot." The needle went on.'],
    23: ["character", 'Brann filled the office door. "Closed for the count," he said. "Come back when the count is done."'],
    25: ["user", 'I put the coins on the counter. "The pilot\'s tab. All of it." I don\'t say why.'],
    27: ["character", "Okoro came down the coast road a day early with a satchel of ledgers under his arm, and asked Joss for the room at the back, away from the taproom."],
    29: ["character", '"Who signs it?" Okoro said. "I do. On the first of the month, the last page I have read. No one else puts a name in that book."'],
    31: ["character", '"Ask Okoro," Ilse said. "He reads everything twice."'],
    33: ["character", "Past six, with the office shut and barred, a lamp burned in its back room. It moved once along the wall, and went out."],
    35: ["character", 'Joss set the slate down. The pilot\'s tab had been wiped clean. "You paid it," he said. "Why would a stranger pay a missing man\'s tab?"'],
    38: ["character", '"Okoro signed it on the first," Joss said. "I watched him do it. Same as every month."'],
    40: ["character", 'Brann looked at the door, not at her. "The lock was changed after the storms. There are two keys now. Ask Ilse about the other."'],
    41: ["character", 'Joss wiped the counter down. "The office shuts at six. If the ledger is anywhere, it is in the back room cabinet."'],
    43: ["user", "Okoro lets me look. I turn the pages. One has been cut out, close to the spine."],
    44: ["character", 'Joss was already reaching for the lamp. "Brann, by day," he said, "but it is past five. Ilse has the night key."'],
    45: ["character", "Joss lit the lamp and walked her down the quay to the office before it shut. The door was already barred."],
    47: ["user", "I knock at Ilse's door. Twice."],
    48: ["character", 'The door opened a hand\'s width. Ilse stood behind it with the night key already in her fist. "Joss sent you," she said. "What does he think is in that office?"'],
  },
  then: {
    // Swiped since: Brann's answer was another when the chronicle cited it.
    40: 'Brann shrugged. "The lock? Changed after the storms. I have the only key."',
    // Cited when it stood at #45: a message before it was removed since, and it is #44 now.
    45: 'Joss was already reaching for the lamp. "Brann, by day," he said, "but it is past five. Ilse has the night key."',
    // Deleted since: the chat ends at #48 now.
    49: 'Ilse turned the key over in her hand. "Midnight," she said. "I will open it at midnight, and not a minute before."',
  },
  rows: [
    row("outline.md", "- #1 to #16: Mara crosses on the packet boat with a letter no one signed, and hears that the pilot has not been seen since the autumn storms {2} {5} {9}"),
    row("outline.md", "- #17 to #31: She takes a room over the Gull. The harbour office turns her away, she pays the pilot's tab, and Okoro arrives a day early for the audit {17} {23} {25} {27}"),
    row("outline.md", "- #32 to #41: A lamp burns in the office's back room after six. Okoro signs the ledger on the first, and Joss says where it is kept {33} {38} {41}"),
    row("outline.md", "- #42 to #47: A page of the ledger has been cut out. Brann has the key by day and Ilse by night, so Mara goes to Ilse's door {43} {44} {47}", undefined, 1),
    row("outline.md", "- #42 to #48: A page of the ledger has been cut out. Brann has the key by day and Ilse by night. Mara goes to Ilse's door, and Ilse opens it with the night key in her hand {43} {44} {47} {48}", 1),
    row("facts.md", "## The ledger"),
    row("facts.md", "- The pilot's ledger lists every ship he brought in and what was owed for it {19}"),
    row("facts.md", "- It is kept in the harbour office, in the back room cabinet {41}"),
    row("facts.md", "- Okoro signs it on the first of each month, on the last page he has read, and no one else signs it {29} {38}"),
    row("facts.md", "- A page has been cut out of it, close to the spine {43}"),
    row("facts.md", ""),
    row("facts.md", "## The harbour office"),
    row("facts.md", "- It shuts at six {41}"),
    row("facts.md", "- Brann holds the only key to it {23} {40}", undefined, 1),
    row("facts.md", "- Two keys open it since the lock was changed after the storms: Brann's, and the night key {40}", 1),
    row("facts.md", "- A lamp burned in its back room after six, when it was shut {33}"),
    row("facts.md", ""),
    row("facts.md", "## The town"),
    row("facts.md", "- The pilot has not been seen since the autumn storms {9}"),
    row("facts.md", "- Joss never lies to Mara, though he leaves things out"),
    row("threads.md", "- Who wrote the letter that brought Mara here? No one signed it {5}"),
    row("threads.md", "- Why did Mara pay the pilot's tab? Joss has asked, and she has not said {25} {35}"),
    row("threads.md", "- Who cut the page out of the ledger, and what was on it? {43}"),
    row("threads.md", "- Who lit the lamp in the back room after six? {33}"),
    row("threads.md", "- Ilse has agreed to open the office at midnight {49}", undefined, 1),
    row("threads.md", "- What does Joss think is in the harbour office? Ilse has asked, and no one has answered {48}", 1),
    row("threads.md", "- Okoro is owed an answer by the first of the month"),
    row("threads.md", "- Where is the pilot?"),
    row("cast.md", "- Mara: a stranger off the packet boat, with a room over the Gull. She is looking for the pilot's ledger, and stands at Ilse's door {17} {47}"),
    row("cast.md", "- Joss: keeps the Gull. He helps Mara, and wants to know why she paid the tab {19} {35}"),
    row("cast.md", "- Brann: the harbourmaster's clerk. He turned Mara away from the office {23}"),
    row("cast.md", "- Ilse: mends nets on the quay, and holds the night key to the office {21} {45}", undefined, 1),
    row("cast.md", "- Ilse: mends nets on the quay, and holds the night key to the office. She has opened her door to Mara {21} {44} {48}", 1),
    row("cast.md", "- Okoro: audits the ledgers. He came a day early, and reads everything twice {27} {31}"),
    row("cast.md", "- The pilot: missing since the autumn storms. His tab at the Gull is paid {9} {25}"),
    row(UNVERIFIED, "- Whether the lamp in the back room was Ilse's: she holds the night key {44}, and no message says she was there", 1),
    row(UNVERIFIED, "- When the lock was changed: Brann says after the storms {40}, and no one else speaks of it", 1),
  ],
  parts: [
    { thinks: "A chronicle is there already. What it lacks and what no longer holds comes first, then a plan for no more than that.", reads: { name: "chronicle_check", args: {}, lead: "4 files. The outline spans #1 to #47 of 48 messages. 2 lines fail: one in facts.md cites #40, whose text has changed; one in threads.md cites #49, which is gone. 1 line in cast.md cites #45 for a message that stands at #44 now.", shows: [] } },
    { thinks: "The end of the chat, closely: what #48 establishes, and what stands now where the two failing lines pointed.", reads: { name: "chat_read", args: { from: 40, to: 48 }, lead: "9 messages, showing the 5 the chronicle's lines rest on.", shows: [40, 44, 45, 47, 48] } },
  ],
  plan: (done, allowance) =>
    [
      "# Plan",
      "",
      `Allowance: ${allowance}.`,
      "",
      "The chronicle covers #1 to #47 of 48 messages, so little is left to learn.",
      "",
      planned(done, 1, "#40 to #48, the walk to Ilse's door: read closely. Add what #48 establishes, and write again the two lines whose messages have changed or gone."),
      "",
      "Left out: #1 to #39. The chronicle has them, and their lines hold.",
    ].join("\n"),
  pause: null,
  report: {
    spent: "",
    done: reportOf(
      "Brought the chronicle up to #48, the chat's latest message, and wrote again the two lines whose messages had changed or gone.",
      ["Wrote learned/chronicle/plan.md first: only #40 to #48 needed reading.", "Outline: its last part now spans #42 to #48.", "Established: two keys open the harbour office, not one (#40 as it reads now).", "Open threads: dropped the midnight promise, whose message is gone, and added Ilse's question from #48.", "Cast: Ilse's line cites #44 where it cited #45."],
      ["Not verified: two things, listed in learned/chronicle/unverified.md."],
    ),
  },
};

// ---------------------------------------------------------------- the long chat

const BRANN: Tale = {
  messages: 2412,
  user: "Ilse",
  character: "Brann",
  said: {
    3: ["character", 'The pilot\'s oilskin still hung by the door of the light. Brann took the watch book down from its nail. "Someone has to sit the nights," he said. "Until he is back."'],
    58: ["user", 'I set the night key and a can of soup on the sill. "Lock up behind you at dawn. And eat it while it is hot."'],
    212: ["character", "Brann ruled a line under the date and wrote the hour beside it. Every ship past the breakwater went into the watch book: her name, her lights, the hour."],
    455: ["character", "The first frost came with a brig off the north shoal, standing in without a pilot. Brann logged her at two and watched her anchor short of the bar."],
    731: ["character", "Out past the breakwater a light showed low on the water, where no ship lay. It held for a count of sixty and went out. Brann wrote: a lantern, in a small boat. The pilot's lantern."],
    990: ["character", 'He turned back a page. The hour of the third ship had run in the damp; the ink was a grey thumbprint. "Three, or five," he said. "I wrote it. I cannot read it."'],
    1204: ["user", '"You have not slept in a bed since the storms," I say. "Joss will sit one night. Let him."'],
    1340: ["character", 'Okoro came up the stair of the light with the watch book under his arm. "There is an hour gone from the night of the frost," he said. "Between two and three, the book says nothing at all."'],
    1777: ["character", '"They never found his boat," Joss said from the door. "Not a plank. A man who drowns leaves a boat."'],
    2050: ["character", 'Brann set the pen down. "When the light shows again I will not write it," he said. "I will go out to it."'],
    2110: ["character", "It showed on the first of the month, low on the water past the breakwater, and held."],
    2301: ["user", 'I push the skiff off the shingle. "Keep the lamp lit until I am back. Promise me."'],
    2399: ["character", '"Until you are back," Brann said. He had not promised anyone anything since the storms.'],
    2412: ["character", "The skiff's lantern grew small. Out past the breakwater the other light waited, and did not go out."],
  },
  then: {},
  rows: [
    row("outline.md", "- #1 to #400: The watch begins. After the autumn storms take the pilot, Brann sits the nights at the harbour light and writes every ship into the watch book. Ilse brings him the night key {3} {58} {212}", 1),
    row("outline.md", "- #401 to #1300: The winter. A brig comes in without a pilot, the hour of one ship is lost to the damp, and Brann sees a light on the water where no ship lies {455} {731} {990}", 2),
    row("outline.md", "- #1301 to #2100: The spring tides. Okoro audits the watch book and finds an hour gone from it. Joss says the pilot's boat was never found {1340} {1777}", 3),
    row("outline.md", "- #2101 to #2412: The light shows again on the first. Ilse rows out to it, and Brann has promised to keep the lamp lit until she is back {2110} {2301} {2412}", 4),
    row("facts.md", "- The pilot has been gone since the autumn storms, and Brann has kept the night watch at the harbour light since {3}", 1),
    row("facts.md", "- Every ship past the breakwater goes into the watch book: her name, her lights and the hour {212}", 1),
    row("facts.md", "- Ilse holds the night key, and leaves it with Brann for the watch {58}", 1),
    row("facts.md", "- A brig came in without a pilot on the night of the first frost. Brann logged her at two {455}", 2),
    row("facts.md", "- The hour of the third ship can't be read: the ink ran in the damp {990}", 2),
    row("facts.md", "- An hour is gone from the watch book on the night of the frost, between two and three {1340}", 3),
    row("facts.md", "- The pilot's boat was never found {1777}", 3),
    row("facts.md", "- The light on the water showed again on the first of the month, and held {2110}", 4),
    row("threads.md", "- What is the light past the breakwater? Brann took it for the pilot's lantern {731}", 2),
    row("threads.md", "- Brann has not slept in a bed since the storms. Ilse wants Joss to sit one night {1204}", 2),
    row("threads.md", "- What happened in the hour the watch book says nothing of? {1340}", 3),
    row("threads.md", "- Brann has said he will go out to the light when it shows again {2050}", 3, 4),
    row("threads.md", "- Brann promised to keep the lamp lit until Ilse is back {2301} {2399}", 4),
    row("threads.md", "- Ilse has rowed out to the light. What does she find? {2412}", 4),
    row("cast.md", "- Brann: the harbourmaster's clerk. He sits the night watch at the harbour light {3}", 1),
    row("cast.md", "- Ilse: holds the night key, and brings Brann his supper {58}", 1, 4),
    row("cast.md", "- Ilse: out in the skiff past the breakwater, rowing for the light {2301} {2412}", 4),
    row("cast.md", "- The pilot: gone since the storms. Brann believes the light is his lantern {731}", 2),
    row("cast.md", "- Okoro: audits the watch book, and found the hour that is gone {1340}", 3),
    row("cast.md", "- Joss: keeps the Gull. He does not think the pilot drowned {1777}", 3),
    row(UNVERIFIED, "- The hour the third ship came in: Brann wrote it, and it can't be read {990}", 2),
    row(UNVERIFIED, "- Whether the light was a lantern in a boat: only Brann saw it {731}", 2),
    row(UNVERIFIED, "- Whether the pilot is alive: no message says so", 4),
    row(UNVERIFIED, "- #401 to #2100 were read by their outline, not line by line: a detail there may be missing", 4),
  ],
  parts: [
    { thinks: "Too long to read line by line on this allowance. Its outline first, then a plan: close reading where the story turns, the outline where the nights repeat.", reads: { name: "chat_outline", args: {}, lead: "2,412 messages and no book, so this is a skeleton worked out from the gaps in time: #1 to #400 (the first nights: Brann, Ilse), #401 to #1300 (the winter, with long quiet stretches), #1301 to #2100 (the spring: Okoro and Joss appear), #2101 to #2412 (the last three weeks).", shows: [] } },
    { thinks: "Part 1, closely: who keeps the watch, why, and what he writes down.", reads: { name: "chat_read", args: { from: 1, to: 400 }, lead: "400 messages, showing the 3 that open a stretch.", shows: [3, 58, 212] } },
    { thinks: "Part 2 by its outline: only where a ship, the light or the watch book is named.", reads: { name: "chat_about", args: { names: ["light", "brig", "watch book"], from: 401, to: 1300 }, lead: "41 messages name one of them, showing the 4 most telling.", shows: [455, 731, 990, 1204] } },
    { thinks: "Part 3 as part 2: Okoro, the hour that is gone, the pilot's boat.", reads: { name: "chat_about", args: { names: ["Okoro", "hour", "boat"], from: 1301, to: 2100 }, lead: "28 messages name one of them, showing the 3 most telling.", shows: [1340, 1777, 2050] } },
    { thinks: "Part 4, closely: the latest weeks are what the next reply builds on.", reads: { name: "chat_read", args: { from: 2101, to: 2412 }, lead: "312 messages, showing the 4 that open a stretch.", shows: [2110, 2301, 2399, 2412] } },
  ],
  plan: (done, allowance) =>
    [
      "# Plan",
      "",
      `Allowance: ${allowance}.`,
      "",
      "The chat has 2,412 messages and no book, so I go by its own outline: closely where the story turns, by the outline where the nights repeat.",
      "",
      planned(done, 1, "#1 to #400, the watch begins: read closely."),
      planned(done, 2, "#401 to #1300, the winter: by the outline, and closely only where a ship, the light or the watch book is named."),
      planned(done, 3, "#1301 to #2100, the spring tides: as part 2."),
      planned(done, 4, "#2101 to #2412, the latest weeks: read closely. Replies build on these."),
      "",
      "Left out: the weather, and the talk at the Gull that promises nothing.",
    ].join("\n"),
  pause: 2,
  report: {
    spent: reportOf(
      "Stopped at my allowance with #1 to #1,300 learned: the chronicle is written as far as the end of the winter.",
      ["Wrote learned/chronicle/plan.md first: #1 to #400 and #2,101 to #2,412 closely, the rest by the chat's outline.", "Wrote the outline, what is established, the open threads and the cast for parts 1 and 2, each line with the messages it rests on.", "Started learned/chronicle/unverified.md: two things only Brann saw or wrote."],
      ["#1,301 to #2,412 are not read yet: the audit of the watch book, and the weeks since the light showed again.", "Granted more, I carry on from part 3 of the plan."],
    ),
    done: reportOf(
      "Learned the story to its latest message, #2,412: the chronicle covers the whole chat.",
      ["Read #1 to #400 and #2,101 to #2,412 closely, and #401 to #2,100 by the chat's outline, as the plan says.", "Wrote the outline in four parts, eight things established, five open threads and the cast of five, each line with the messages it rests on.", "Kept learned/chronicle/plan.md true as I went."],
      ["Not verified: four things, listed in learned/chronicle/unverified.md.", "#401 to #2,100 were read by their outline: a detail there may be missing."],
    ),
  },
};

const TALES: Readonly<Record<string, Tale>> = { "chat-mara": MARA, "chat-brann": BRANN };

// ---------------------------------------------------------------- messages and citations

interface Message {
  role: "user" | "assistant";
  name: string;
  text: string;
}

/** A message of a tale as it stands now. One the made-up chronicle doesn't cite has no words of its own, and says so. */
function messageOf(tale: Tale, index: number): Message {
  const said = Object.hasOwn(tale.said, index) ? tale.said[index] : undefined;
  if (said !== undefined) return { role: said[0] === "user" ? "user" : "assistant", name: said[0] === "user" ? tale.user : tale.character, text: said[1] };
  const user = index % 2 === 0;
  return { role: user ? "user" : "assistant", name: user ? tale.user : tale.character, text: `(The preview's made-up story has no words for message #${index}: only the messages its chronicle cites are written out.)` };
}

const HASHES = new WeakMap<Tale, { hashes: Map<number, string>; places: (hash: string) => readonly number[] }>();

/** Each message's hash by its number, and where the messages with a citation's hash stand: what core's check of a citation takes. Worked out once a tale: its messages don't change while the preview is open. */
function hashesOf(tale: Tale): { hashes: Map<number, string>; places: (hash: string) => readonly number[] } {
  let held = HASHES.get(tale);
  if (!held) {
    const hashes = new Map<number, string>();
    for (let index = 1; index <= tale.messages; index += 1) hashes.set(index, hashOf(messageOf(tale, index).text));
    held = { hashes, places: placesOf(hashes) };
    HASHES.set(tale, held);
  }
  return held;
}

/** A citation of a message as a line of the chronicle carries it: its number, and the start of the hash of its text. `then`: as it read when a line written before the preview opened cited it; a line the learning writes, and a tool that prints a message, cite it as it stands. */
function cite(tale: Tale, index: number, then: boolean): string {
  const was = then && Object.hasOwn(tale.then, index) ? tale.then[index] : undefined;
  return `[${citeOf(index, hashOf(was ?? messageOf(tale, index).text))}]`;
}

// ---------------------------------------------------------------- the files as they stand

/** A file as it is kept: its text, and when and by whom it was last written. */
interface Kept {
  text: string;
  at: number;
  by: FileAuthor;
}

/** A chat's chronicle as it stands: how many parts of the learning have been written (-1: none, 0: the plan alone), and its files by name. */
interface Chat {
  tale: Tale;
  done: number;
  files: Map<string, Kept>;
}

/** The job the made-up data says kept the harbour chat's chronicle before the preview opened. */
const CHRONICLER: FileAuthor = { who: "job", id: "job-chronicle-1", role: "chronicler" };

/** A tale's files once part `done` is written, by name: each file that has a line by then, and the plan from part 0 on. */
function filesAt(tale: Tale, done: number, allowance: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of [...OWN, UNVERIFIED]) {
    const rows = tale.rows.filter((r) => r.file === name && (r.from ?? -1) <= done && done < (r.until ?? Number.POSITIVE_INFINITY));
    if (rows.length === 0) continue;
    const lines = rows.map((r) => r.text.replace(/\{(\d+)\}/g, (_, index: string) => cite(tale, Number(index), r.from === undefined)));
    files.set(name, [`# ${TITLES[name] ?? name}`, "", ...lines].join("\n"));
  }
  if (done >= 0) files.set(PLAN, tale.plan(done, allowance));
  return files;
}

/** The chats' chronicles of each stand-in backend, by the context its parts share: the part that answers the page and the run a story's job plays (which the jobs' part starts) meet here. */
const WORLDS = new WeakMap<MockCtx, Map<string, Chat>>();

/** A file's text without the list lines that cite no message: what a chronicle kept with care reads like. */
const citedOnly = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^\s*[-*+]\s/.test(line) || /\[#\d+ [0-9a-f]{8}\]/.test(line))
    .join("\n");

/** A chat's chronicle as it stands; null for a chat with no made-up story, and for every chat of a fresh install. For the README's pictures (`showcase`) it opens as it stands once the learning's last part is written: whole, every line cited, and no plan left lying. */
function chatOf(ctx: MockCtx, chatId: string | null): Chat | null {
  if (!ctx.ready || chatId === null || !Object.hasOwn(TALES, chatId)) return null;
  const tale = TALES[chatId];
  if (tale === undefined) return null;
  let world = WORLDS.get(ctx);
  if (!world) {
    world = new Map();
    WORLDS.set(ctx, world);
  }
  let chat = world.get(chatId);
  if (!chat) {
    const at = ctx.now() - 40 * MIN;
    const whole = ctx.showcase === true;
    const done = whole ? tale.parts.length - 1 : -1;
    const files = [...filesAt(tale, done, "")].filter(([name]) => !whole || name !== PLAN);
    chat = { tale, done, files: new Map(files.map(([name, text]) => [name, { text: whole ? citedOnly(text) : text, at, by: CHRONICLER }])) };
    world.set(chatId, chat);
  }
  return chat;
}

/** A part of the learning is written: the files that changed with it are the job's from now. Answers what changed, as a tool call's result says it. */
function write(ctx: MockCtx, chat: Chat, done: number, job: JobView): FileChange[] {
  const changes: FileChange[] = [];
  for (const [name, text] of filesAt(chat.tale, done, allowanceWords(job.allowance))) {
    const before = chat.files.get(name);
    if (before?.text === text) continue;
    chat.files.set(name, { text, at: ctx.now(), by: { who: "job", id: job.id, role: job.agent } });
    changes.push({ area: "learned", path: `${DIR}${name}`, before: before ? hashOf(before.text) : null, after: hashOf(text) });
  }
  chat.done = done;
  return changes;
}

/** The check, as core's `chronicle_check` works it out: each line of the four files with its citations read against the messages as they stand. */
function check(chat: Chat | null): ChronicleView {
  const view: ChronicleView = { files: [], failures: [], moved: [], uncited: [] };
  if (chat === null) return view;
  const { hashes, places } = hashesOf(chat.tale);
  for (const name of OWN) {
    const kept = chat.files.get(name);
    if (!kept) continue;
    const path = `${AGENTS_DIR}${name}`;
    const file = { path, chars: kept.text.length, lines: 0, cited: 0, failed: 0 };
    kept.text.split("\n").forEach((text, i) => {
      const line = i + 1;
      file.lines += 1;
      const cited = citationsIn(text);
      if (cited.length === 0) {
        if (/^\s*[-*+]\s/.test(text)) view.uncited.push({ path, line, text });
        return;
      }
      file.cited += 1;
      let failed = false;
      for (const c of cited) {
        const found = checkCitation(c, hashes, places);
        if (found.state === "moved") view.moved.push({ path, line, citation: c.text, index: c.index, now: found.now });
        else if (found.state !== "ok") {
          failed = true;
          view.failures.push({ path, line, text, citation: c.text, index: c.index, why: found.state });
        }
      }
      if (failed) file.failed += 1;
    });
    view.files.push(file);
  }
  return view;
}

/** How many of the chat's messages the outline spans: its lines open with the messages their part runs over, "#17 to #31". */
function covered(chat: Chat): number {
  const spans = (chat.files.get("outline.md")?.text ?? "").split("\n").flatMap((line): [number, number][] => {
    const span = /^\s*[-*+]\s+#(\d+)\s+to\s+#(\d+)/.exec(line);
    return span ? [[Math.max(1, Number(span[1])), Math.min(chat.tale.messages, Number(span[2]))]] : [];
  });
  let count = 0;
  let reached = 0;
  for (const [from, to] of spans.sort((a, b) => a[0] - b[0])) {
    if (to <= reached) continue;
    count += to - Math.max(from - 1, reached);
    reached = to;
  }
  return count;
}

// ---------------------------------------------------------------- learning a story (§22)

/**
 * What Learn this story is filled in with. The real backend suggests its chronicler; the
 * stand-in's agents have no chronicler, so the one that keeps the chat's notes stands in. The
 * budget is the page's to size, from the estimate.
 */
const SUGGESTED: StoryView["suggested"] = {
  task: "Learn this story from its start: read the chat, and its book where it has one, and write the chronicle: the outline, what is established, the open threads and the cast, each line citing the messages it rests on. Plan first to the budget you are given, and keep a plain list of what you have not verified.",
  agent: "archivist",
};

const STORY_SYSTEM = "You learn the story of a chat that is already long, as a job with a budget of its own. Say first what you will do with the budget: write your plan to learned/chronicle/plan.md and keep it true as you go. Then write the chronicle under learned/chronicle/, each line citing the messages it rests on, and keep a plain list of what you have not verified. When the budget runs out, stop and report what you did and what is left.";

const said = (n: number): string => n.toLocaleString("en-US");

/** An allowance in words, as the agent is told it and writes it into its plan. */
function allowanceWords(allowance: JobAllowance | undefined): string {
  const parts: string[] = [];
  const member = (value: number | null | undefined, words: (n: number) => string, none: string): void => {
    if (value === null) parts.push(none);
    else if (value !== undefined) parts.push(words(value));
  };
  member(allowance?.tokensIn, (n) => `${said(n)} tokens in`, "no limit on tokens in");
  member(allowance?.tokensOut, (n) => `${said(n)} tokens out`, "no limit on tokens out");
  member(allowance?.toolTurns, (n) => `${said(n)} rounds of tool calls`, "no limit on rounds of tool calls");
  member(allowance?.wallMs, (n) => `${said(Math.round(n / MIN))} minutes`, "no limit on time");
  return parts.length > 0 ? parts.join(", ") : "Settings' limits for each job";
}

/** The member of its allowance a story's run stops at: its tokens in where it has a figure for them, else its tokens out; null where neither is bounded, so nothing stops it. */
function boundOf(job: JobView): { member: "tokensIn" | "tokensOut"; limit: number; used: number } | null {
  const { tokensIn, tokensOut } = job.allowance ?? {};
  if (typeof tokensIn === "number") return { member: "tokensIn", limit: tokensIn, used: job.usage.in };
  if (typeof tokensOut === "number") return { member: "tokensOut", limit: tokensOut, used: job.usage.out };
  return null;
}

/**
 * What a part of the learning takes, and by how much the call that uses a budget up passes it. The
 * preview's own stage directions, not bounds: a run whose budget can't cover what is left stops at
 * it having spent exactly what it was given, and one that finishes spends what its parts take, so
 * the page's figures tell the story whatever budget was typed.
 */
const PART_TAKES = { in: 90_000, out: 6_000 } as const;
const PASSED_BY = { in: 840, out: 120 } as const;

/** What the stand-in's model is priced at, in US dollars a million tokens read and written: made up, so the estimate can be said in money. */
const PRICE = { in: 0.27, out: 1.1 } as const;

/** The parts of a tale still to learn, the report counted as a tenth of one (as the run spends it). */
function partsLeft(chat: Chat): number {
  return chat.tale.parts.length - 1 - chat.done + 0.1;
}

/** What learning the rest is expected to take, as the core estimates it: here, what the run below will spend on the parts still to learn. The stand-in counts every token in full, so the weighed count is the prompt's. Zeros where nothing is left. */
function estimateOf(chat: Chat | null): StoryEstimate {
  const left = chat === null ? 0 : chat.tale.messages - covered(chat);
  if (chat === null || left <= 0) return { messages: 0, chars: 0, stretches: 0, promptTokens: 0, cachedTokens: 0, writtenTokens: 0, weighedTokens: 0, toolTurns: 0, usd: 0 };
  const parts = partsLeft(chat);
  const promptTokens = Math.round(parts * PART_TAKES.in);
  const writtenTokens = Math.round(parts * PART_TAKES.out);
  return { messages: left, chars: left * 900, stretches: Math.ceil(left / 60), promptTokens, cachedTokens: 0, writtenTokens, weighedTokens: promptTokens, toolTurns: Math.ceil(parts) * 2 + 1, usd: (promptTokens * PRICE.in + writtenTokens * PRICE.out) / 1_000_000 };
}

/** How long each step of the run takes, in ms: the preview's own pace, long enough to see each state. */
const PACE = { starts: 300, reads: 2200, found: 500, writes: 2600, wrote: 400, reports: 2400, ends: 150 } as const;

/** Splits `total` over `weights` in whole numbers, the last taking what rounding left. */
function split(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => Math.floor((total * w) / sum));
  const last = shares.length - 1;
  if (last >= 0) shares[last] = (shares[last] ?? 0) + total - shares.reduce((a, b) => a + b, 0);
  return shares;
}

/** A story's run, as the jobs' part plays it: its steps, and why it stops before the story is learned (null: it reads to the chat's end, or has nothing left to read). */
export interface StoryRun {
  steps: PlayStep[];
  spent: string | null;
}

/**
 * The run of a job started as the learning of its chat's story, from where the chronicle stands:
 * the plan first, then a part of the chat at a time, each read and then written (`on.wrote` tells
 * that the files changed, `on.landed` hears the trace after each step). A run whose budget can't
 * cover what is left stops at it after the tale's `pause`; one carried on finishes, unless the
 * limit it ran out at was left where it was. Null for a chat with no made-up story: its job plays
 * an ordinary run.
 */
export function storyRun(ctx: MockCtx, job: JobView, task: string, on: { landed(t: Trace): void; wrote(): void }): StoryRun | null {
  const chat = chatOf(ctx, job.chatId);
  if (chat === null) return null;
  const { tale } = chat;
  const agentId = `${job.agent}-1`;
  const last = tale.parts.length - 1;
  const bound = boundOf(job);
  const carried = job.usage.calls > 0;
  // Granted more of something else, the limit it ran out at stands, and it is still at it.
  const out = carried && bound !== null && bound.used >= bound.limit;
  // Too small a budget for what is left: it gets as far as the tale's pause on it.
  const short = bound !== null && bound.limit - bound.used < partsLeft(chat) * PART_TAKES[bound.member === "tokensIn" ? "in" : "out"];
  const until = out ? chat.done : tale.pause !== null && short && chat.done < tale.pause ? tale.pause : last;
  const parts = tale.parts.map((part, done) => ({ part, done })).filter((p) => p.done > chat.done && p.done <= until);
  const stops = bound !== null && (out || until < last);
  const spent = stops && bound !== null ? `It reached its budget of ${said(bound.limit)} tokens ${bound.member === "tokensIn" ? "read" : "written"}. Give it more and it carries on from where it stopped.` : null;
  const report = out
    ? reportOf("Nothing more was done: the allowance I ran out at stands where it was.", ["Read where the plan stood, and stopped at once."], ["Everything the last report named. Raise the limit it names, or lift it, and I carry on."])
    : parts.length === 0
      ? reportOf("Nothing was left to learn: the chronicle already covers the whole chat.", ["Ran the check over the chronicle: its lines hold."], ["Nothing."])
      : stops
        ? tale.report.spent
        : tale.report.done;

  // What the run spends in all, over its calls: two a part (it reads, then it writes) and the report.
  const room = (member: "tokensIn" | "tokensOut", used: number, takes: number, passed: number): number => {
    const limit = job.allowance?.[member];
    if (typeof limit !== "number") return takes;
    if (stops && bound?.member === member) return Math.max(passed, limit - used + passed);
    return Math.max(0, Math.min(takes, Math.floor((limit - used) * 0.8)));
  };
  const calls = parts.length * 2 + 1;
  // A run with nothing to read still reports: a tenth of a part's worth.
  const size = parts.length > 0 ? parts.length : 0.1;
  const spendIn = split(room("tokensIn", job.usage.in, Math.round(PART_TAKES.in * size), PASSED_BY.in), [...parts.flatMap(() => [3, 2]), 1]);
  const spendOut = split(room("tokensOut", job.usage.out, Math.round(PART_TAKES.out * size), PASSED_BY.out), [...parts.flatMap(() => [1, 6]), 3]);
  const usage = (call: number): { in: number; cachedIn: number; out: number } => ({ in: spendIn[call] ?? 0, cachedIn: call === 0 && !carried ? 0 : Math.round((spendIn[call] ?? 0) * 0.7), out: spendOut[call] ?? 0 });

  const step = (after: number, run: (t: Trace) => void, says?: PlayStep["says"]): PlayStep => ({
    after,
    ...(says ? { says } : {}),
    run: (t) => {
      run(t);
      on.landed(t);
    },
  });
  const told = carried ? `You were granted more. Your allowance for this job is now: ${allowanceWords(job.allowance)}. Carry on from your plan.` : `${task}\n\nYour allowance for this job: ${allowanceWords(job.allowance)}. Say first what you will do with it.`;
  const steps: PlayStep[] = [step(0, (t) => void t.started("job", null, { job: job.id })), step(PACE.starts, (t) => void t.agent({ id: agentId, role: job.agent, system: STORY_SYSTEM, connectionId: "conn-deepseek" }).message(agentId, told))];
  parts.forEach(({ part, done }, i) => {
    const reads: ToolCallView = { id: `call_read_${done}`, name: part.reads.name, args: part.reads.args };
    const found = [part.reads.lead, ...part.reads.shows.map((index) => `${cite(tale, index, false)} ${messageOf(tale, index).name}: ${messageOf(tale, index).text}`)].join("\n\n");
    // What it will write is known only once the part before it has been written: the calls are made when their step begins.
    const writes = (): ToolCallView[] =>
      [...filesAt(tale, done, allowanceWords(job.allowance))].filter(([name, text]) => chat.files.get(name)?.text !== text).map(([name, text]) => ({ id: `call_write_${done}_${name.replace(/\W+/g, "_")}`, name: "workspace_write", args: { path: `${AGENTS_DIR}${name}`, content: text, base: chat.files.has(name) ? hashOf(chat.files.get(name)?.text ?? "").slice(0, 12) : "new" } }));
    let wrote: ToolCallView[] = [];
    steps.push(
      step(PACE.reads, (t) => void t.answer(agentId, { reasoning: part.thinks, calls: [reads], ...usage(i * 2), reasoningOut: Math.round((spendOut[i * 2] ?? 0) / 2), ms: PACE.reads }), { agentId, reasoning: part.thinks }),
      step(PACE.found, (t) => void t.result(agentId, reads, found, PACE.found)),
      step(PACE.writes, (t) => {
        wrote = writes();
        t.answer(agentId, { calls: wrote, ...usage(i * 2 + 1), ms: PACE.writes });
      }),
      step(PACE.wrote, (t) => {
        const changes = write(ctx, chat, done, job);
        for (const call of wrote) {
          const path = String(call.args.path);
          const lines = String(call.args.content).split("\n").length;
          t.result(agentId, call, `Wrote ${path} (${lines} ${lines === 1 ? "line" : "lines"}).`, 20, { files: changes.filter((c) => `learned/${c.path}` === path) });
        }
        on.wrote();
      }),
    );
  });
  if (stops) steps.push(step(PACE.wrote, (t) => void t.runtimeNotice(agentId, "Your allowance for this job is used up. Make no more tool calls: report what you did and what is left.")));
  steps.push(step(PACE.reports, (t) => void t.answer(agentId, { text: report, ...usage(calls - 1), ms: PACE.reports }).idle(agentId), { agentId, text: report }), step(PACE.ends, (t) => void t.ended("done")));
  return { steps, spent };
}

// ---------------------------------------------------------------- the part

export interface ChronicleMock {
  handlers: Handlers<Requests>;
  /** A chronicle file as the workspace's read gives one (`lah.ws.read`, area `learned`); null where the request names no file of the chronicle, so the workspace's own part answers it. */
  read(r: UiRequestOf<"lah.ws.read">): UiRequests["lah.ws.read"]["result"] | null;
  /** A listing of an area as the workspace's own part answers it, with the chat's chronicle files added where the area is `learned`: the page finds what else the chronicle's folder holds there. */
  list(r: UiRequestOf<"lah.ws.list">, view: WorkspaceView): WorkspaceView;
}

export function chronicleMock(ctx: StoryCtx): ChronicleMock {
  const listed = (name: string, kept: Kept): WorkspaceFile => ({ path: `${DIR}${name}`, hash: hashOf(kept.text), chars: kept.text.length, at: kept.at, by: kept.by, pins: [] });
  return {
    read: (r) => {
      const chat = r.area === "learned" && r.path.startsWith(DIR) ? chatOf(ctx, r.chatId) : null;
      const name = r.path.slice(DIR.length);
      const kept = chat?.files.get(name);
      if (!kept) return null;
      const file = listed(name, kept);
      // An earlier version of a chronicle file is not kept here: the workspace's part says so.
      return r.version !== undefined && r.version !== file.hash ? null : { file, text: kept.text, version: file.hash };
    },
    list: (r, view) => {
      const chat = r.area === "learned" ? chatOf(ctx, r.chatId) : null;
      if (chat === null || chat.files.size === 0) return view;
      const mine = [...chat.files].map(([name, kept]) => listed(name, kept));
      const files = [...view.files.filter((f) => !mine.some((m) => m.path === f.path)), ...mine];
      return { ...view, files, chars: files.reduce((sum, f) => sum + f.chars, 0) };
    },
    handlers: {
      "lah.chronicle.get": (r) => check(chatOf(ctx, r.chatId)),
      "lah.chronicle.cited": (r) => {
        const chat = chatOf(ctx, r.chatId);
        return {
          cited: r.citations.map((citation): CitedView => {
            const named = namedMessage(citation);
            if (named === null) throw new Refusal("invalid", `"${citation}" is no citation: one reads like [#412 a3f9c27e].`);
            const { index } = named;
            const standing = (at: number): NonNullable<CitedView["message"]> | null => (chat !== null && at >= 1 && at <= chat.tale.messages ? { index: at, ...messageOf(chat.tale, at), at: ctx.now() - (chat.tale.messages - at + 1) * 47 * MIN } : null);
            if (chat === null) return { index, ok: false, why: "gone", message: null };
            // A message named by its number alone is as it stands; one named by its citation is checked as the chronicle's lines are.
            const found = named.hash === null ? ({ state: standing(index) ? "ok" : "gone" } as const) : checkCitation({ index, hash: named.hash }, hashesOf(chat.tale).hashes, hashesOf(chat.tale).places);
            if (found.state === "ok") return { index, ok: true, message: standing(index) };
            if (found.state === "moved") return { index, ok: true, why: "moved", now: found.now, message: standing(found.now) };
            return { index, ok: false, why: found.state, message: found.state === "gone" ? null : standing(index) };
          }),
        };
      },
      "lah.story.get": (r): StoryView => {
        const chat = chatOf(ctx, r.chatId);
        return { job: ctx.storyJob(r.chatId), plan: chat?.files.has(PLAN) ? `${AGENTS_DIR}${PLAN}` : null, messages: chat?.tale.messages ?? 0, covered: chat ? covered(chat) : 0, suggested: { ...SUGGESTED }, estimate: estimateOf(chat) };
      },
    },
  };
}
