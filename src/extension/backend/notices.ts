// What the user should hear of when no page of theirs was looking (DESIGN §15): a job that
// finished, failed, was interrupted by a runtime restart, or needs them. A notice is kept with the
// user's documents until they dismiss it, so it is there on the next page they open; when more are
// kept than Settings allow, the oldest go first.

import { isRecord } from "../../link/json";
import type { Notice } from "../../shared/ui";
import { UserDocs } from "./docs";
import type { BackendHost } from "./spindle";

const FILE = "notices.json";

interface NoticesDoc {
  v: 1;
  /** The oldest first. */
  notices: Notice[];
}

const KINDS: Readonly<Record<string, true>> = { job_done: true, job_failed: true, job_interrupted: true, job_needs_user: true };

function noticeOf(raw: unknown): Notice | null {
  if (!isRecord(raw)) return null;
  const { id, at, kind, chatId, jobId, text } = raw;
  if (typeof id !== "string" || typeof at !== "number" || typeof kind !== "string" || !Object.hasOwn(KINDS, kind) || typeof chatId !== "string" || typeof jobId !== "string" || typeof text !== "string") return null;
  return { id, at, kind: kind as Notice["kind"], chatId, jobId, text };
}

function docOf(raw: unknown): NoticesDoc | null {
  if (!isRecord(raw) || raw.v !== 1 || !Array.isArray(raw.notices)) return null;
  const notices: Notice[] = [];
  for (const one of raw.notices) {
    const notice = noticeOf(one);
    if (notice !== null) notices.push(notice);
  }
  return { v: 1, notices };
}

export interface NoticesEnv {
  now(): number;
  /** An id no other notice of the user has. */
  id(): string;
  /** How many notices Settings keep for a user. */
  kept(userId: string): Promise<number>;
}

export class Notices {
  private readonly docs: UserDocs<NoticesDoc>;
  private readonly changed: ((userId: string) => void)[] = [];

  constructor(
    host: Pick<BackendHost, "storage" | "log">,
    private readonly env: NoticesEnv,
  ) {
    this.docs = new UserDocs<NoticesDoc>(host, FILE, docOf, () => ({ v: 1, notices: [] }));
  }

  /** A user's notices changed. */
  onChange(listener: (userId: string) => void): void {
    this.changed.push(listener);
  }

  private tell(userId: string): void {
    for (const listener of this.changed) listener(userId);
  }

  /** The user's notices, the newest first. */
  async list(userId: string): Promise<Notice[]> {
    return [...(await this.docs.get(userId)).notices].reverse();
  }

  /** Keeps a notice. One job is told of once per kind: a second of the same kind takes the first's place. */
  async add(userId: string, notice: Omit<Notice, "id" | "at">): Promise<Notice> {
    const kept = Math.max(1, await this.env.kept(userId));
    const made: Notice = { id: this.env.id(), at: this.env.now(), ...notice };
    await this.docs.change(userId, (doc) => {
      doc.notices = doc.notices.filter((n) => !(n.jobId === made.jobId && n.kind === made.kind));
      doc.notices.push(made);
      if (doc.notices.length > kept) doc.notices.splice(0, doc.notices.length - kept);
    });
    this.tell(userId);
    return made;
  }

  /** A job no longer waits on the user: the notice that said it did is taken away. */
  async settle(userId: string, jobId: string, kind: Notice["kind"]): Promise<void> {
    if (!(await this.docs.get(userId)).notices.some((n) => n.jobId === jobId && n.kind === kind)) return;
    await this.docs.change(userId, (doc) => {
      doc.notices = doc.notices.filter((n) => !(n.jobId === jobId && n.kind === kind));
    });
    this.tell(userId);
  }

  /** `lah.notice.dismiss`: one notice, or (null) every one. What is left, the newest first. */
  async dismiss(userId: string, id: string | null): Promise<Notice[]> {
    const before = (await this.docs.get(userId)).notices;
    if (id === null ? before.length > 0 : before.some((n) => n.id === id)) {
      await this.docs.change(userId, (doc) => {
        doc.notices = id === null ? [] : doc.notices.filter((n) => n.id !== id);
      });
      this.tell(userId);
    }
    return this.list(userId);
  }

  /** Resolves once every write is done (tests). */
  settled(): Promise<void> {
    return this.docs.settle();
  }
}
