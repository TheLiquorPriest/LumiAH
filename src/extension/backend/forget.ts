// The chats Lumiverse deleted, until the runtime has forgotten them (DESIGN §7). What the core kept
// of a chat (its learned files, its jobs and their reports, its side sessions, what the user
// approved for it, its search vectors) is the core's to remove, and the core runs in the user's
// runtime: so the runtime does the forgetting, asked with the `chats.forget` op of the `ask` push.
//
// A chat deleted while no runtime is linked, or whose forgetting the runtime couldn't finish, is
// kept in the user's storage and handed over again: whenever a runtime of the user's links, whenever
// another chat of theirs is deleted, and, where the runtime refused because a reply or a side
// session's answer was still being worked on in the chat, at its next ping. So nothing of a deleted
// chat stays behind for good, and nothing is lost to a restart of this worker meanwhile.

import { isRecord } from "../../link/json";
import type { Asks } from "./asks";
import { UserDocs } from "./docs";
import { UiRefused, wordsOf } from "./errors";
import type { BackendHost } from "./spindle";

interface Stored {
  v: 1;
  /** Each chat still to forget, by its id: when Lumiverse said it was deleted. */
  chats: Record<string, number>;
}

function storedOf(raw: unknown): Stored | null {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.chats)) return null;
  const chats: Record<string, number> = {};
  for (const [chatId, at] of Object.entries(raw.chats)) if (typeof at === "number") chats[chatId] = at;
  return { v: 1, chats };
}

export interface ForgottenDeps {
  /** Asks the user's runtime: an op about no chat goes to the runtime linked now. */
  asks: Pick<Asks, "ask">;
  /** Whether a runtime of the user's is linked now. */
  isLinked(userId: string): Promise<boolean>;
  now(): number;
}

export class Forgotten {
  private readonly docs: UserDocs<Stored>;
  /** Each user's hand-over under way: one at a time, each reading the list as it stands when it begins. */
  private readonly handing = new Map<string, Promise<void>>();
  /** The users with a hand-over waiting to begin behind the one under way: it will read whatever was added meanwhile. */
  private readonly queued = new Set<string>();
  /** The users whose runtime refused a chat because a run in it was still under way: handed over again at its next ping. */
  private readonly owed = new Set<string>();

  constructor(
    private readonly host: Pick<BackendHost, "storage" | "log">,
    private readonly deps: ForgottenDeps,
  ) {
    this.docs = new UserDocs<Stored>(host, "forget.json", storedOf, () => ({ v: 1, chats: {} }));
  }

  /** Lumiverse deleted a chat of the user's: it is kept until the runtime has forgotten it, and handed over now. */
  deleted(userId: string, chatId: string): void {
    void this.docs
      .change(userId, (doc) => {
        doc.chats[chatId] = this.deps.now();
      })
      .then(() => this.handOver(userId))
      .catch((error: unknown) => this.host.log("warn", `[LumiAH] the deleted chat ${chatId} couldn't be kept for the runtime to forget (${wordsOf(error)})`));
  }

  /** Every chat of the user's still to forget goes to their runtime, where one is linked; nothing is asked of a runtime that isn't. */
  handOver(userId: string): void {
    if (this.queued.has(userId)) return;
    this.queued.add(userId);
    const next = (this.handing.get(userId) ?? Promise.resolve())
      .then(() => {
        this.queued.delete(userId);
        return this.run(userId);
      })
      .catch((error: unknown) => this.host.log("warn", `[LumiAH] the chats deleted while the runtime was away couldn't be handed to it (${wordsOf(error)})`));
    this.handing.set(userId, next);
    void next.finally(() => {
      if (this.handing.get(userId) === next) this.handing.delete(userId);
    });
  }

  /** A runtime of the user's pinged: where it refused a chat for a run still under way there, that chat is handed over again. */
  pinged(userId: string): void {
    if (this.owed.delete(userId)) this.handOver(userId);
  }

  private async run(userId: string): Promise<void> {
    const chats = Object.keys((await this.docs.get(userId)).chats);
    if (chats.length === 0 || !(await this.deps.isLinked(userId))) return;
    for (const chatId of chats) {
      try {
        // It takes as long as the chat's documents are many: waited for while the runtime stays linked.
        await this.deps.asks.ask(userId, "chats.forget", { chatId }, { patient: true });
      } catch (error) {
        if (!(error instanceof UiRefused)) throw error;
        // The runtime went away: the rest waits for the next one to link.
        if (error.code === "unavailable") return;
        // A reply or a side session's answer is still worked on there: asked again once that has had time to end.
        if (error.code === "conflict") {
          this.owed.add(userId);
          continue;
        }
        // Anything else the runtime refused is said, and asked again when a runtime next links.
        this.host.log("warn", `[LumiAH] the runtime couldn't forget the deleted chat ${chatId} (${error.message}); it is asked again when it next links`);
        continue;
      }
      await this.docs.change(userId, (doc) => {
        delete doc.chats[chatId];
      });
    }
  }

  /** Resolves once every write is done (tests). */
  settle(): Promise<void> {
    return this.docs.settle();
  }
}
