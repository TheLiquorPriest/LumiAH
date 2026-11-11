// The learning of a chat's story as the pages follow it (DESIGN §22, §24.7). It is a job like any
// other, and the core marks no job as it: what makes a job the story's is that a page started it
// as such (`lah.job.start` with `story`). So which job that was is remembered here, the latest for
// each chat, in the user's storage, where it outlives a restart of the extension. Only the job's id
// is kept: how it stands and what it spent is the core's to say each time it is asked.

import { isRecord } from "../../link/json";
import { UserDocs } from "./docs";
import type { BackendHost } from "./spindle";

interface Stored {
  v: 1;
  /** Each chat's latest story job: the job's id, by the chat's. */
  jobs: Record<string, string>;
}

function storedOf(raw: unknown): Stored | null {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.jobs)) return null;
  const jobs: Record<string, string> = {};
  for (const [chatId, job] of Object.entries(raw.jobs)) if (typeof job === "string" && job !== "") jobs[chatId] = job;
  return { v: 1, jobs };
}

export class StoryJobs {
  private readonly docs: UserDocs<Stored>;

  constructor(host: Pick<BackendHost, "storage" | "log">) {
    this.docs = new UserDocs<Stored>(host, "story.json", storedOf, () => ({ v: 1, jobs: {} }));
  }

  /** The job remembered as the learning of a chat's story, by its id; null when none was started. */
  async of(userId: string, chatId: string): Promise<string | null> {
    const { jobs } = await this.docs.get(userId);
    return Object.hasOwn(jobs, chatId) ? (jobs[chatId] ?? null) : null;
  }

  /** A page started a job as the learning of a chat's story: it is that chat's from now on, in place of any before it. */
  async started(userId: string, chatId: string, job: string): Promise<void> {
    await this.docs.change(userId, (doc) => {
      doc.jobs[chatId] = job;
    });
  }

  /** A job was started again as a new one (`lah.job.again`): where the old one was its chat's story job, the new one is now, since it carries the same learning on. */
  async again(userId: string, chatId: string, from: string, job: string): Promise<void> {
    if ((await this.of(userId, chatId)) === from) await this.started(userId, chatId, job);
  }

  /** The core keeps a chat's story job no more: it is forgotten, unless another was started for the chat meanwhile. So an entry lasts as long as its job does. */
  async gone(userId: string, chatId: string, job: string): Promise<void> {
    if ((await this.of(userId, chatId)) !== job) return;
    await this.docs.change(userId, (doc) => {
      if (doc.jobs[chatId] === job) delete doc.jobs[chatId];
    });
  }

  /** Resolves once every write is done (tests). */
  settle(): Promise<void> {
    return this.docs.settle();
  }
}
