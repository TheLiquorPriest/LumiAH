// What lore and history add to the definitions the core ships (DESIGN §24.7, §13): the chronicler,
// a built-in agent that keeps the chronicle as a job; the story reader, which reads one stretch of
// the chat for it; and two built-in skills, the chronicler's two procedures: bringing the chronicle
// up to date from a message on, and learning the story of a chat that already has a long history
// (§22).
//
// The chronicler reads no message of the chat. A session that read a whole chat carried all of it
// in every later call, so what a job sent grew with the square of the chat's length, and nothing
// ran side by side. Readers read instead, a stretch each in a session of its own, and the
// chronicler's session holds its plan and the lines they return. Nothing in code decides when a
// skill applies or starts a reader: the chronicler loads a skill and delegates, as any agent does.
// The user replaces a skill by defining one with its id, and either agent by a definition with its
// id.

import type { AgentDefinition } from "../agents";
import type { Definitions } from "../definitions";
import { AGENT, type AgentSettings, defaultSettings } from "../settings";
import type { Skill } from "../skills";
import { renderDefault, TEXT, TOOL } from "../texts";

/** The chronicler's id: what `job_start` names it by, and what its settings are kept under. */
export const CHRONICLER = "chronicler";

/** The reader's id: what the chronicler's `delegate` names it by, and what its settings are kept under. */
export const READER = "story-reader";

/**
 * Why LumiAH's own agents don't keep a chat's chronicle in a run: the chronicler or the story reader
 * is switched off, or the extension that answers the chat gives an agent of its own under that id
 * (one that does other work would be started in its place). Null where both are LumiAH's own, as
 * shipped or as the user replaced them. Where they aren't, no upkeep is offered and the story isn't
 * learned. `extension`: its name, as the reason says it.
 */
export function chronicleRefusal(definitions: Pick<Definitions, "sourced">, extension: string | null): string | null {
  for (const [id, name] of [
    [CHRONICLER, "chronicler"],
    [READER, "story reader"],
  ] as const) {
    const sourced = definitions.sourced(id);
    if (sourced === undefined) return `LumiAH's ${name} is switched off, so it keeps no chronicle for this chat and doesn't learn its story. Switch it on on the Agents page.`;
    if (sourced.source === "extension" || sourced.over === "extension") return `${extension ?? "The extension that answers this chat"} gives this chat an agent of its own in place of LumiAH's ${name}, so LumiAH keeps no chronicle for it and doesn't learn its story.`;
  }
  return null;
}

/** The ids of the two skills, as `skill_load` takes them and the texts name them. */
export const RECALL_SKILL = { keep: "chronicle-keep", learn: "story-learn" } as const;

/**
 * What the chronicler is given: the chat cut into stretches and no tool that reads a message, the
 * book and the lore to check a name against, its workspace to read and write the chronicle's files,
 * the check, the skills, and `delegate`, by which it hands each stretch to a reader. Nothing that
 * writes a reply or deletes a file.
 */
const CHRONICLER_TOOLS: readonly string[] = [
  TOOL.chatOutline,
  TOOL.bookOutline,
  TOOL.bookRead,
  TOOL.loreSearch,
  TOOL.loreRead,
  TOOL.loreAbout,
  TOOL.workspaceList,
  TOOL.workspaceRead,
  TOOL.workspaceGrep,
  TOOL.workspaceWrite,
  TOOL.workspaceEdit,
  TOOL.chronicleCheck,
  TOOL.skillLoad,
  TOOL.delegate,
];

/**
 * What a reader is given: the messages of its stretch, the chat around a message and by word for
 * the rare thing its stretch leaves unclear, and the book and the lore to check a name against.
 * Nothing that writes: what it found is its answer.
 */
const READER_TOOLS: readonly string[] = [TOOL.chatRead, TOOL.chatAround, TOOL.chatGrep, TOOL.chatSearch, TOOL.bookOutline, TOOL.bookRead, TOOL.loreSearch, TOOL.loreRead, TOOL.loreAbout];

/**
 * The chronicler's rounds of tool calls unless the user says otherwise: the skill, the measuring
 * and the plan, then two rounds for each round of readers (handing the stretches out, and the
 * merge after it), the check and the end. That is more rounds than a summary takes, and enough for
 * a history of about a hundred stretches. A default of a definition, which the user changes under
 * the agent's settings.
 */
const CHRONICLER_ROUNDS = 40;

/**
 * A reader's rounds of tool calls unless the user says otherwise: a stretch of the size Settings
 * give by default is eleven pages of `chat_read` where it is read a page an answer, which is the
 * most rounds a stretch takes; the rest are for a name looked up and for the warning that comes
 * before the last. A default of a definition, which the user changes under the agent's settings.
 */
const READER_ROUNDS = 16;

/**
 * The agent definitions lore and history ship: the chronicler and the story reader. Each runs where
 * the main agent does unless it is given a connection of its own, and each holds the tools of its
 * own definition whoever starts it: they are its trade, and the agent that starts it has no use
 * for them.
 */
export function recallAgents(): AgentDefinition[] {
  const summarizer = defaultSettings().agents[AGENT.summarizer] as AgentSettings;
  return [
    {
      id: CHRONICLER,
      name: "Chronicler",
      description:
        "Keeps the chronicle in learned/chronicle/ (outline, facts, open threads, cast): what the chat has established, every line with the citation of the messages it rests on. It reads no message itself: it hands the chat to story readers a stretch at a time and merges what they return. Give it the message number to bring the chronicle up to date from, and anything it must not miss.",
      instructions: renderDefault(TEXT.recall.chronicler),
      text: TEXT.recall.chronicler,
      given: "task",
      follows: AGENT.main,
      // The main agent that starts its job may hold neither the check nor a way to write the chronicle's files.
      grant: "definition",
      connectionId: null,
      model: null,
      effort: "inherit",
      tools: [...CHRONICLER_TOOLS],
      toolCalls: "auto",
      budget: { ...summarizer.budget, toolTurns: CHRONICLER_ROUNDS },
    },
    {
      id: READER,
      name: "Story reader",
      description:
        "Reads one stretch of the chat and answers with what it established, as lines for the chronicle with their citations: the outline, facts, open threads, the cast. Give it the stretch by its first and its last message (#120 to #179) and anything to watch for. It reads that stretch and changes nothing.",
      instructions: renderDefault(TEXT.recall.reader),
      text: TEXT.recall.reader,
      given: "task",
      follows: AGENT.main,
      // The chronicler that starts it holds no tool that reads a message: a reader given only what its starter holds could read nothing.
      grant: "definition",
      connectionId: null,
      model: null,
      effort: "inherit",
      tools: [...READER_TOOLS],
      toolCalls: "auto",
      budget: { ...summarizer.budget, toolTurns: READER_ROUNDS },
    },
  ];
}

/** What both skills say of the files before their steps: the rule the check holds every line to, and the two files it leaves alone. */
const FILES = `No heading, no note: \`chronicle_check\` fails every line that cites nothing, and a line that fails is left out of what the main agent is given. \`plan.md\` and \`unverified.md\` are working files, neither checked nor given to anyone.`;

/** How a round's lines go into the four files: the same in both skills. */
const MERGE = `- \`workspace_write\` with base \`new\` for a file that isn't there yet, \`workspace_edit\` for one that is.
- Copy the readers' lines as they stand, citations and all. Never write a citation no reader gave you, and never change one.
- \`outline.md\`: every outline line, in the story's order.
- \`facts.md\`: the new facts. A fact that was overturned is rewritten or removed, never left beside its opposite.
- \`threads.md\`: what is open now. A thread that closed is deleted and, where it matters, becomes a fact.
- \`cast.md\`: one line a person. A newer line for someone already there takes the old one's place.
- The weightiest and the newest go to the top of \`facts.md\`, \`threads.md\` and \`cast.md\`, since only the top of each file is given to the main agent each turn.`;

const KEEP = `# Keep the chronicle

For the chronicler, running as a job: bring the chronicle in \`learned/chronicle/\` up to date from the message your task names to the end of the chat. You read no message yourself. A story reader reads each stretch in a session of its own, and you merge what the readers return.

The four files (\`outline.md\`, \`facts.md\`, \`threads.md\`, \`cast.md\`) hold nothing but markdown bullets, each ending with the citation of every message it rests on (\`[#412 a3f9c27e]\`). ${FILES}

## 1. Check
\`chronicle_check\` first, and in the same answer \`workspace_read\` of each of the four files: you merge into them, and one that isn't there yet says so.
- The check corrects a citation's number itself where the cited text stands at exactly one other message.
- A line it still fails rests on a message that is gone or says something else now. Delete the line, and keep what it said as something for a reader to watch for.
- It lists the runs of messages no outline line covers. Where your task names no message to start from, start at the first message of the last run it lists.

## 2. Cut
\`chat_outline\` with \`stretches: true\` and \`from\` (the message to start from). The answer is the cut, one line a stretch:
\`- #120 to #179 · 60 messages, 34,200 characters\`
The size of a stretch is the user's setting and the cut is made for you: take each line's numbers as they stand, and never split or join stretches.

## 3. One reader a stretch
One \`delegate\` call for every line of the cut, all of them in one answer:
- \`agent\`: \`${READER}\`
- \`task\`: the stretch as its line gives it, then what to watch for: what your task says must not be missed, a thread this stretch may close, a line the check failed. The reader knows nothing you don't write there. For example: "Read #120 to #179. Watch for: whether Ilse forgave Brann's debt; where Okoro is at the end."

The readers work side by side, as many at once as Settings allow, and the rest wait their turn. Each answers with lines under \`outline:\`, \`facts:\`, \`threads:\` and \`cast:\`, and a last line that says how far it read (\`read: #120 to #179\`).

## 4. Merge
In the order of the stretches, with the changes to all four files in one answer:
${MERGE}
- A reader that \`delegate\` says stopped before it answered left its whole stretch unread. One whose last line stops short of its stretch's end (\`read: #120 to #141\` of \`#120 to #179\`) left the rest unread: merge its lines, and write nothing about the rest. Start no second reader for either.

## 5. Check again
\`chronicle_check\` once more. Fix or delete every line it fails, and check again if you changed anything. What it still lists as not covered, from the message you started at on, is what the readers left unread.

## 6. Report
Answer with your report: the stretches read; what you added, changed and removed; and the messages still unread, as the check lists them.
`;

const LEARN = `# Learn an existing story

For the chronicler, running as a job the user starts on a chat that already has a long history: build the chronicle in \`learned/chronicle/\` from it. You read no message yourself. A story reader reads each stretch in a session of its own, and you merge what the readers return. Your first message states the job's allowance and names a plan file. What the readers spend counts against that allowance too.

The four files hold nothing but markdown bullets, each ending with the citation of every message it rests on (\`[#412 a3f9c27e]\`):
- \`outline.md\`: the story's parts in order, one line each, opening with the messages the part spans: \`- #120–#159 · The crossing: what happened, in a sentence. [#120 a3f9c27e] [#159 77b0d41c]\`
- \`facts.md\`: what is established and still true, one fact a line.
- \`threads.md\`: what is open: promises, debts, questions, plans, dangers.
- \`cast.md\`: who is in the story, one line each: where they are now, in what state, what they want, what they know.

${FILES}

## 1. Measure
In one answer:
- \`workspace_list\` of \`learned/chronicle/\`. Where \`plan.md\` is there, this job carries an earlier one on: \`workspace_read\` it and the four files, and go on with its stretches that are still to read (step 3).
- \`chat_outline\` with \`stretches: true\`: the chat cut into the stretches readers are given, one line each: \`- #120 to #179 · 60 messages, 34,200 characters\`. A long cut comes a page at a time: follow its cursor to the end. The size of a stretch is the user's setting and the cut is made for you: take each line's numbers as they stand, and never split or join stretches.
- \`book_outline\`, where the chat has a book: its chapters sum up spans of the chat.

## 2. Plan
Write \`learned/chronicle/plan.md\`, one line a stretch, in the chat's order:
- \`[ ] #120 to #179\`: to read;
- \`[x]\`: read to its end and merged;
- \`[!]\`: a reader was started for it and it is unread, wholly or from one message on (say from which);
- \`[~]\`: taken from a book summary, because this plan says the summary is enough.

A stretch a summary covers is still read by a reader unless the plan says the summary is enough for it. Say so only where the job's objective asks for it, or where the allowance can't cover every stretch: then the oldest stretches are the ones to take from summaries.

Reckon before you plan: a reader takes about one round of tool calls for every 4,000 characters of its stretch, and sends its stretch's characters several times over in tokens, since each of its calls carries what it has read so far. Where the allowance can't cover everything, the newest stretch is read first and the plan works backwards from it: the latest matters most to the next reply.

Then put one line in the plan file your first message names: that the plan is in \`learned/chronicle/plan.md\`.

## 3. Delegate in rounds
A round is several stretches, about six, in the plan's order: one \`delegate\` call each, all of them in one answer.
- \`agent\`: \`${READER}\`
- \`task\`: the stretch as the plan gives it, then what to watch for: the people and the threads that earlier stretches left open. The reader knows nothing you don't write there. For example: "Read #120 to #179. Watch for: where Okoro went after the flood; whether the ledger was opened." For a stretch the plan takes from a summary: "Take #120 to #179 from the book's summary."

The readers of a round work side by side, as many at once as Settings allow, and the rest wait their turn. Each answers with lines under \`outline:\`, \`facts:\`, \`threads:\` and \`cast:\`, and a last line that says how far it read (\`read: #120 to #179\`).

After each round, in one answer, merge and mark the plan, so that a job stopped at its allowance leaves a plan that is true:
${MERGE}
- Mark each stretch of the round in \`plan.md\`: \`[x]\` where its reader read to its end, \`[~]\` where it was taken from a summary.
- A reader that fails (\`delegate\` says it stopped before it answered), or whose last line stops short of its stretch's end (\`read: #120 to #141\` of \`#120 to #179\`), leaves that stretch \`[!]\`: merge the lines it did return, write nothing about the rest, and note in the plan from which message it is unread. Start no second reader for it.

Then the next round. Stop delegating when \`delegate\` answers that no more sub-agents may be started, when it says the job's allowance stopped a reader, and when what is left of the allowance is less than a round costs. The stretches no reader was started for stay \`[ ]\`: merge what you have, and go to the end.

## 4. End
1. \`chronicle_check\`. It corrects a citation's number itself where the cited text stands at exactly one other message: fix or delete every line it still fails. It lists the runs of messages no outline line covers: they are the plan's \`[ ]\` and \`[!]\` stretches, and nothing else.
2. Write \`learned/chronicle/unverified.md\`: a plain list of what was taken from a summary and of what is unread, each by its messages (\`#a to #b\`).
3. Bring \`plan.md\` up to date one last time.
4. Answer with your report: the stretches readers read, those taken from summaries, those unread (\`[!]\`), how many are left to read (\`[ ]\`), and where the files are.
`;

/** The skills lore and history ship: the chronicler's two procedures. Each body is written for a model, short and exact; each description is what a listing shows, and every agent that holds `skill_load` reads it each turn. */
export const RECALL_SKILLS: Skill[] = [
  {
    id: RECALL_SKILL.keep,
    name: "Keep the chronicle",
    description: "For the chronicler: how to bring the chronicle up to date from a message on. The main agent doesn't load it: upkeep never costs the reply a round. When the turn's note says a job is worth it, job_start goes in the same answer as write_reply, with the task the note gives.",
    body: KEEP,
  },
  {
    id: RECALL_SKILL.learn,
    name: "Learn an existing story",
    description: "For the chronicler, as a job the user starts on a chat that already has a long history: plan within the job's allowance, have story readers read the chat a stretch each, and build the chronicle (learned/chronicle/) with a citation on every line.",
    body: LEARN,
  },
];
