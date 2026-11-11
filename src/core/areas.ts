// Who holds which area of the workspace (DESIGN §11), on top of `workspace.ts`.
//
// - `~/` is one area for the user, whatever the chat.
// - `learned/` is one area for each chat. A chat that was branched from another starts with that
//   chat's, copied when the branch is first used.
// - The chat's area (`/`) follows the story path as the session does. Each turn has its own head,
//   seeded from the area as the turn it follows left it, so a swipe or a regenerate starts from the
//   same files the reply it replaces started from, and a turn that is swiped away takes its writes
//   with it. A turn's record holds the index as it stood when the turn ended.
// - Whoever writes to the chat's area without being a turn (a job, the user on the page, a side
//   session) writes to the latest turn on the active path: "the index of the latest record on the
//   active path, plus what jobs on that path wrote since". While a turn is under way in the chat they
//   write to that turn's area, so its agents see the change, and to the area it started from as
//   well, so the change stays on the path if that turn's reply is swiped away.

import { DOC, ROOT_AREA } from "./paths";
import type { FileAuthor, FileChange, HarnessHost, JsonObject, TurnRecord } from "./ports";
import { type PathTurn, pathTurns } from "./sessions";
import { errorText } from "./util";
import { type Area, type AreaAccess, type AreaDoc, type AreaIndex, type AreaResult, changesBetween, type MoveInput, type PinInput, type RemoveInput, type Workspace, type WriteInput } from "./workspace";

/**
 * The chat's area as the turn under way in a chat holds it: the turn, its own area, and the area it
 * started from. `closedAt`: the turn has ended and left a record that Lumiverse hasn't saved yet;
 * until it has, the path's latest record is still the one before, and a write from outside must not
 * land there alone.
 */
export interface OpenTurn {
  generationId: string;
  area: Area;
  under: Area;
  closedAt?: number;
}

/** Whoever writes to the chat's area without being a turn. */
export interface Outsider {
  /** For a job: the turn it belongs to. A job of the turn under way writes to that turn's area alone, as the turn's own agents do. */
  basis?: string | null;
  /** Asked before every change: why it may not be made (in words for whoever asked), or null. A job's is whether its turn still stands on the path. */
  gate?: () => Promise<string | null>;
}

/**
 * Where everything kept for one chat is in the store: the folder its documents are under, closed
 * with a slash, so one chat's id is never the start of another's. Read from where `DOC` puts a
 * chat's `learned/`, so it follows the stored paths wherever they are.
 */
export function chatFolder(chatId: string): string {
  const learned = DOC.learned(chatId);
  return learned.slice(0, learned.lastIndexOf("/") + 1);
}

export class Areas {
  private readonly open = new Map<string, OpenTurn>();
  /** The chats whose `learned/` was looked at for a branch's copy since the process started: once is enough, since a chat's origin never changes. */
  private readonly adopted = new Set<string>();

  /** `wait`: how long a turn that ended is still taken as the chat's latest while its record isn't on the path yet (Settings' wait for a turn to be saved). */
  constructor(
    private readonly host: Pick<HarnessHost, "chat" | "store" | "clock" | "log">,
    private readonly workspace: Workspace,
    private readonly wait: () => number,
  ) {}

  user(): Area {
    return this.workspace.area("user", DOC.userArea);
  }

  /**
   * A chat's `learned/`. A branch's is its origin's, copied the first time the branch is used: until
   * then nothing of the branch exists to copy to, and from then on the two go their own ways.
   */
  async learned(chatId: string): Promise<Area> {
    await this.adopt(chatId, new Set());
    return this.workspace.area("learned", DOC.learned(chatId));
  }

  private async adopt(chatId: string, seen: Set<string>): Promise<void> {
    if (this.adopted.has(chatId) || seen.has(chatId)) return;
    seen.add(chatId);
    try {
      if ((await this.host.store.read(DOC.learned(chatId))) === null) {
        const from = (await this.host.chat.info?.(chatId))?.branchedFrom ?? null;
        if (from !== null) {
          await this.adopt(from, seen);
          const head = await this.workspace.area("learned", DOC.learned(from)).headHash();
          const doc: AreaDoc = { v: 1, kind: "area", head, at: this.host.clock.now() };
          if (head !== null) await this.host.store.write(DOC.learned(chatId), doc as unknown as JsonObject);
        }
      }
      this.adopted.add(chatId);
    } catch (error) {
      // The branch then starts with what its own document holds (nothing, the first time), and the copy is tried again at its next use.
      this.host.log("warn", `[LumiAH] the files learned in the chat this one was branched from couldn't be copied (${errorText(error)})`);
    }
  }

  /** The chat's area as a turn left it (`record`), with what was written to it since; before any turn, for none. */
  at(chatId: string, record: TurnRecord | null): Area {
    if (record === null) return this.workspace.area("chat", DOC.chatArea(chatId, ROOT_AREA));
    return this.workspace.area("chat", DOC.chatArea(chatId, record.generationId), async () => record.workspace ?? null);
  }

  /**
   * Opens the chat's area for a turn that follows `basis` (the latest record on the path before its
   * reply; for a continue, the continued reply's own): its own head, which reads as the area it
   * follows until the turn first writes. One turn is under way in a chat at a time.
   */
  openTurn(chatId: string, generationId: string, basis: TurnRecord | null): Area {
    const under = this.at(chatId, basis);
    const area = this.workspace.area("chat", DOC.chatArea(chatId, generationId), () => under.headHash());
    this.open.set(chatId, { generationId, area, under });
    return area;
  }

  /**
   * The turn ended. One that left no record is forgotten at once: writes from outside go to the
   * path's latest record again. One that left a record stays the chat's latest until that record is
   * on the path, or Settings' wait has passed.
   */
  closeTurn(chatId: string, generationId: string, record: boolean): void {
    const turn = this.open.get(chatId);
    if (turn?.generationId !== generationId) return;
    if (record) turn.closedAt = this.host.clock.now();
    else this.open.delete(chatId);
  }

  /** The turn outsiders' writes go with in a chat: the one under way, or the one that just ended and whose record isn't on the path yet. `turns`: the path's records, read only where they are needed. */
  async current(chatId: string, turns: () => Promise<readonly PathTurn[]>): Promise<OpenTurn | null> {
    const turn = this.open.get(chatId);
    if (!turn) return null;
    if (turn.closedAt === undefined) return turn;
    if (this.host.clock.now() - turn.closedAt < this.wait() && !(await turns()).some((t) => t.onPath && t.record.generationId === turn.generationId)) return turn;
    if (this.open.get(chatId) === turn) this.open.delete(chatId);
    return null;
  }

  /** The records that stand on the chat's active path, oldest first. */
  async standing(chatId: string): Promise<PathTurn[]> {
    return (await pathTurns(await this.host.chat.path(chatId))).filter((turn) => turn.onPath);
  }

  /** The latest record that stands on the chat's active path, with where its reply is; null when there is none. */
  async latest(chatId: string): Promise<PathTurn | null> {
    return (await this.standing(chatId)).at(-1) ?? null;
  }

  /**
   * Forgets a chat whose documents are leaving the store: no turn of it is open, its areas are let
   * go so nothing of them is answered from memory or written back, and should its id ever be used
   * again, the chat it was branched from is looked for anew.
   */
  forget(chatId: string): void {
    this.open.delete(chatId);
    this.adopted.delete(chatId);
    this.workspace.forget(chatFolder(chatId));
  }

  /** The chat's area as it stands now, for whoever isn't a turn. */
  now(chatId: string, who: Outsider = {}): AreaAccess {
    return new LiveArea(this, chatId, who);
  }

  /**
   * A turn's change set (§11): what differs between the chat's area as the turn before it on the
   * path left it and as this turn's stands now, with what its jobs wrote after its reply. `turns`:
   * the path's records (`pathTurns`), `turn` among them.
   */
  async changes(chatId: string, turns: readonly PathTurn[], turn: PathTurn): Promise<(FileChange & { by: FileAuthor })[]> {
    const before = turns.findLast((t) => t.onPath && t.at < turn.at)?.record.workspace ?? null;
    return changesBetween("chat", await this.workspace.index(before), await this.at(chatId, turn.record).index());
  }
}

/** An area whose every change first asks `gate` why it may not be made (null: it may): a job's areas, which it may write only while its turn stands on the path (§15). */
export function gated(area: AreaAccess, gate: () => Promise<string | null>): AreaAccess {
  const ask = async (make: () => Promise<AreaResult>): Promise<AreaResult> => {
    const reason = await gate();
    return reason === null ? make() : { ok: false, why: { code: "refused", reason } };
  };
  return {
    kind: area.kind,
    index: () => area.index(),
    text: (hash) => area.text(hash),
    write: (input) => ask(() => area.write(input)),
    move: (input) => ask(() => area.move(input)),
    remove: (input) => ask(() => area.remove(input)),
    pin: (input) => ask(() => area.pin(input)),
  };
}

/** The chat's area for an outsider: each call finds where the area stands at that moment. */
class LiveArea implements AreaAccess {
  readonly kind = "chat" as const;

  constructor(
    private readonly areas: Areas,
    private readonly chatId: string,
    private readonly who: Outsider,
  ) {}

  /** Where a call goes: the area it reads and writes, and the one a write is repeated on. */
  private async target(): Promise<{ area: Area; also: Area | null }> {
    let standing: Promise<PathTurn[]> | null = null;
    const turns = (): Promise<PathTurn[]> => (standing ??= this.areas.standing(this.chatId));
    const turn = await this.areas.current(this.chatId, turns);
    if (turn) return { area: turn.area, also: this.who.basis === turn.generationId ? null : turn.under };
    return { area: this.areas.at(this.chatId, (await turns()).at(-1)?.record ?? null), also: null };
  }

  private async change(make: (area: Area, force: boolean) => Promise<AreaResult>): Promise<AreaResult> {
    const reason = (await this.who.gate?.()) ?? null;
    if (reason !== null) return { ok: false, why: { code: "refused", reason } };
    const { area, also } = await this.target();
    const result = await make(area, false);
    // Already checked against the version there was: the second area takes it as it is. One it can't take there (the file went another way on that path) is left as that path has it.
    if (result.ok && result.changes.length > 0 && also) await make(also, true);
    return result;
  }

  async index(): Promise<AreaIndex> {
    return (await this.target()).area.index();
  }

  async text(hash: string): Promise<string | null> {
    return (await this.target()).area.text(hash);
  }

  write(input: WriteInput): Promise<AreaResult> {
    return this.change((area, force) => area.write(force ? { ...input, force: true } : input));
  }

  move(input: MoveInput): Promise<AreaResult> {
    return this.change((area, force) => area.move(force ? { ...input, force: true } : input));
  }

  remove(input: RemoveInput): Promise<AreaResult> {
    return this.change((area, force) => area.remove(force ? { ...input, force: true } : input));
  }

  async pin(input: PinInput): Promise<AreaResult> {
    const reason = (await this.who.gate?.()) ?? null;
    if (reason !== null) return { ok: false, why: { code: "refused", reason } };
    const { area, also } = await this.target();
    const result = await area.pin(input);
    if (result.ok && also) await also.pin(input);
    return result;
  }
}
