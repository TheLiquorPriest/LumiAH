// What a turn tells its main agent of the lore and the chat with the request itself (DESIGN §24.1,
// §24.7), so the common turn needs no lookup call to know what exists: which lore the prompt holds
// and how it got there, the lore it doesn't hold, which of the chat's messages it holds word for
// word, and the top of the chat's chronicle, without the lines whose messages are gone or changed.
// What the prompt held is traced as plain data (`prompt_held`), and kept as how the chat's lore
// stood at this turn. All of it is worked out by code from the request's flags, the books, the
// chat's path and the chronicle's files.

import type { HarnessHost, JobView, PathMessage, PresetBlock, TraceEvent } from "../ports";
import { errorText } from "../util";
import type { AreaAccess } from "../workspace";
import { type ChroniclerJob, chroniclerJob, pinnedChronicle, storyHashes } from "./chronicle";
import { promptNotes } from "./prompt";
import type { RecallRun } from "./recall";

/** What `requestDocument` is handed: the notes that follow the request's messages, and what names each world-info message of the request (by its place, from 0). */
export interface RequestRecall {
  notes: string;
  fromLore: ReadonlyMap<number, string>;
}

export interface ToldInput {
  /** The chat as the turn reads it: the messages before the reply. */
  path: readonly PathMessage[];
  /** The active preset's blocks. */
  blocks: readonly PresetBlock[];
  /** The main agent writes the reply itself, so it is told nothing of `write_reply`. */
  writes: boolean;
  /** The chat's `learned/` area, where its chronicle is kept. */
  learned: AreaAccess | null;
  /** The chat's jobs that haven't ended, read when the note is made, so it says whether the chronicler is at work already; null: jobs can't run, or LumiAH's own agents don't keep this chat's chronicle, and the note says nothing of upkeep. */
  jobs: (() => Promise<readonly Pick<JobView, "agent" | "state">[]>) | null;
  emit(event: TraceEvent): void;
  log: HarnessHost["log"];
  now: number;
}

/**
 * The notes of one turn. Never rejects: a turn is not lost to its notes. Where the books or the
 * chronicle can't be read, the request goes without that part, and the log says why.
 */
export async function recallTold(run: RecallRun, input: ToldInput): Promise<RequestRecall> {
  const { turn, settings, texts } = run.env;
  if (!turn) return { notes: "", fromLore: new Map() };
  const { prompt } = settings.recall;
  const parts: string[] = [];
  let fromLore: ReadonlyMap<number, string> = new Map();
  try {
    const held = await run.held();
    if (held) {
      const told = promptNotes({ messages: turn.messages, lore: held, corpus: await run.lore(), path: input.path, blocks: input.blocks, book: run.env.book ?? null, settings, texts, briefs: !input.writes });
      run.told(held, input.now);
      input.emit({ kind: "prompt_held", ...told.held, at: input.now });
      // With every note switched off the request reads as it did before them: no message is named as lore either.
      if (prompt.lore || prompt.index || prompt.history) {
        if (told.text !== "") parts.push(told.text);
        fromLore = told.fromLore;
      }
    }
  } catch (error) {
    input.log("warn", `[LumiAH] what the prompt holds of the lore and the chat couldn't be worked out (${errorText(error)}): the main agent is given the request without it`);
  }
  try {
    // Whether the chronicler is at work for this chat. Where the jobs can't be read the note says nothing of upkeep: a job started on a guess could be a second one.
    let keeper: ChroniclerJob | null = null;
    if (input.jobs && settings.recall.chronicle.pin && settings.recall.chronicle.remind) {
      try {
        keeper = chroniclerJob(await input.jobs());
      } catch (error) {
        input.log("warn", `[LumiAH] the chat's jobs couldn't be read (${errorText(error)}): the main agent is told nothing of the chronicle's upkeep this turn`);
      }
    }
    // The check needs each message's hash and nothing of its text: the path has them, and says which messages count as the story.
    const pinned = await pinnedChronicle({ learned: input.learned, chat: storyHashes(input.path, run.env.story), settings, texts, jobs: keeper, writes: input.writes });
    if (pinned !== "") parts.push(pinned);
  } catch (error) {
    input.log("warn", `[LumiAH] the chat's chronicle couldn't be read (${errorText(error)}): the main agent is given the request without it`);
  }
  return { notes: parts.join("\n\n"), fromLore };
}
