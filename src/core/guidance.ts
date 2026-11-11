// Guidance (DESIGN §12): markdown an agent is given as part of its instructions, every run.
//
// Three levels, given in this order, each named so an agent knows whose words they are: the user's
// (`~/GUIDANCE.md`), a middle level (for a plain chat the character's, kept in the user's area; an
// extension that claims the chat names its own in its place), and the chat's (`learned/GUIDANCE.md`).
// Each is a workspace file, so the user edits it on the page like any other, with versions and a
// history. An agent may write the chat's level when Settings allow, and never the other two.

import type { ChatClaim } from "./extension";
import { docKey } from "./paths";
import type { ChatInfo, FileAuthor, HarnessHost, WorkspaceArea } from "./ports";
import type { Settings } from "./settings";
import { TEXT, type Texts } from "./texts";
import { cutAt, errorText } from "./util";
import { type AreaAccess, resolvePath, showPath } from "./workspace";

/** The name a guidance file bears in its folder. A stored path, so fixed. */
export const GUIDANCE_FILE = "GUIDANCE.md";

/** The folder of the user's area the characters' guidance is kept under, one folder for each. A stored path, so fixed. */
const CHARACTERS = "characters";

/** Where a character's guidance is kept in the user's area. */
export function characterGuidance(characterId: string): string {
  return `${CHARACTERS}/${docKey(characterId)}/${GUIDANCE_FILE}`;
}

export type GuidanceId = "user" | "middle" | "chat";

/** A level of guidance as a run reads it. */
export interface GuidanceRead {
  id: GuidanceId;
  /** Whose words they are, as agents are told. */
  whose: string;
  /** The workspace file it is; null for a level an extension keeps as its own text. */
  file: { area: WorkspaceArea; path: string } | null;
  /** Its text; empty while nothing is written. */
  text: string;
  /** The file's version (its body's hash), and when and by whom it was written; null while there is none. */
  version: string | null;
  at: number | null;
  by: FileAuthor | null;
}

type Areas = Readonly<Record<WorkspaceArea, AreaAccess | null>>;

async function fileLevel(id: GuidanceId, whose: string, area: AreaAccess, path: string): Promise<GuidanceRead> {
  const entry = (await area.index()).files[path];
  const text = entry ? ((await area.text(entry.hash)) ?? "") : "";
  return { id, whose, file: { area: area.kind, path }, text, version: entry?.hash ?? null, at: entry?.at ?? null, by: entry?.by ?? null };
}

/**
 * The levels a run's agents are given, in the order they are given. A level whose file can't be
 * read is left out with a line in the log: guidance adds to a run, and never stops one.
 */
export async function readGuidance(input: { areas: Areas; chat: ChatInfo | null; claim: ChatClaim | null; texts: Texts; pathChars: number; log: HarnessHost["log"] }): Promise<GuidanceRead[]> {
  const { areas, chat, claim, texts } = input;
  const levels: (() => Promise<GuidanceRead | null>)[] = [];
  const user = areas.user;
  if (user) levels.push(() => fileLevel("user", texts.render(TEXT.agents.guidanceUser), user, GUIDANCE_FILE));
  const named = claim?.guidance;
  if (named && "text" in named) levels.push(async () => ({ id: "middle", whose: named.name, file: null, text: named.text, version: null, at: null, by: null }));
  else if (named && user) {
    levels.push(async () => {
      const at = resolvePath(named.path, input.pathChars);
      if ("refused" in at || at.area !== "user" || at.path === "") {
        input.log("warn", `[LumiAH] the extension's guidance "${named.name}" names ${named.path}, which is no file of the user's area (~/): it isn't given`);
        return null;
      }
      return fileLevel("middle", named.name, user, at.path);
    });
  } else if (chat?.characterId != null && user) {
    const { characterId, characterName } = chat;
    levels.push(() => fileLevel("middle", texts.render(TEXT.agents.guidanceCharacter, { character: characterName ?? characterId }), user, characterGuidance(characterId)));
  }
  const learned = areas.learned;
  if (learned) levels.push(() => fileLevel("chat", texts.render(TEXT.agents.guidanceChat), learned, GUIDANCE_FILE));
  const read = await Promise.all(
    levels.map(async (level) => {
      try {
        return await level();
      } catch (error) {
        input.log("warn", `[LumiAH] a level of guidance couldn't be read (${errorText(error)}): it isn't given this run`);
        return null;
      }
    }),
  );
  return read.flatMap((level) => level ?? []);
}

/** The levels as the head of an agent's instructions: one part for each that holds anything, a level longer than Settings allow cut with where the whole is. */
export function guidancePrefix(levels: readonly GuidanceRead[], settings: Readonly<Pick<Settings, "guidance">>, texts: Texts): string[] {
  const { chars } = settings.guidance;
  return levels.flatMap((level) => {
    if (level.text.trim() === "") return [];
    if (level.text.length <= chars) return [texts.render(TEXT.agents.guidance, { whose: level.whose, text: level.text })];
    const shown = cutAt(level.text, chars);
    const cut = { text: level.text.slice(0, shown), shown: String(shown), chars: String(level.text.length) };
    // A level an extension keeps as a text of its own is in no workspace file: its cut names none to read the rest from.
    const text = level.file ? texts.render(TEXT.agents.guidanceCut, { ...cut, path: showPath(level.file.area, level.file.path) }) : texts.render(TEXT.agents.guidanceCutOwn, cut);
    return [texts.render(TEXT.agents.guidance, { whose: level.whose, text })];
  });
}

/**
 * What an agent may not write of the workspace (`WorkspaceView.guard`): the user's guidance, every
 * character's and the level an extension named are the user's alone; the chat's is an agent's to
 * write only while Settings allow.
 */
export function guidanceGuard(levels: readonly GuidanceRead[], settings: Readonly<Pick<Settings, "guidance">>, texts: Texts): (area: WorkspaceArea, path: string) => string | null {
  const named = levels.find((level) => level.id === "middle")?.file ?? null;
  return (area, path) => {
    if (area === "learned") return path === GUIDANCE_FILE && !settings.guidance.agentsEdit ? texts.render(TEXT.agents.guardChat, { path: showPath(area, path) }) : null;
    if (area !== "user") return null;
    const parts = path.split("/");
    const character = parts.length === 3 && parts[0] === CHARACTERS && parts[2] === GUIDANCE_FILE;
    return path === GUIDANCE_FILE || character || (named?.area === "user" && named.path === path) ? texts.render(TEXT.agents.guardUser, { path: showPath(area, path) }) : null;
  };
}
