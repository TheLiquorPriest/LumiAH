// A chat's messages as §24 reads them (DESIGN §24.4, §24.6): every message of the active path with
// its text, when it was sent and the hash a citation of it carries, indexed for search. One corpus
// is kept for a chat between turns. A run brings it up to date from the chat's path, which names
// every message's hash without its text: only a message that is new, or whose text changed, is read
// from the host and indexed again, so a turn in a chat of thousands of messages reads a handful.
//
// Each run reads the chat as its own path has it (`ChatRun`): the messages before the reply for a
// turn, all of them for a job. The index is shared; a run's searches keep to its own messages. A
// message is kept under the hash of the text that was read, not the one the path promised: where
// the chat changed between the two, the run reads the message as it stands now, and no citation
// ever names words other than the ones it is printed with.

import { textHash } from "../hash";
import { LexicalIndex } from "../lexical";
import type { ChatRole, HarnessHost, PathMessage } from "../ports";
import { isRecord } from "../ports";
import { citeOf } from "./cite";

/** A chat message as the history tools read it. */
export interface ChatDoc {
  id: string;
  /** Its number in the chat (`index_in_chat`), as the request and the tools name it. */
  index: number;
  role: ChatRole;
  name: string;
  text: string;
  /** The hash of its text, as `PathMessage.hash` is made: a citation carries its start. */
  hash: string;
  /** When it was sent, in milliseconds since 1970; null where the host has none. */
  at: number | null;
  /** Its text in lower case, made the first time a name is looked for in it and kept with the message. */
  lower?: string;
}

/** Who wrote a message, as the answers say it: its name, else whose it is. */
export function whoOf(doc: Pick<ChatDoc, "name" | "role">): string {
  return doc.name.trim() !== "" ? doc.name : doc.role;
}

/** A message's citation as the tools print it: `[#412 a3f9c27e]`. */
export function citeDoc(doc: Pick<ChatDoc, "index" | "hash">): string {
  return `[${citeOf(doc.index, doc.hash)}]`;
}

/** Who speaks in `docs`, each with how many of the messages are theirs: whoever speaks most first, and of two who speak as much, the one who spoke first. */
export function speakersOf(docs: readonly ChatDoc[]): [who: string, messages: number][] {
  const counts = new Map<string, number>();
  for (const doc of docs) counts.set(whoOf(doc), (counts.get(whoOf(doc)) ?? 0) + 1);
  // A map keeps the order names were first set in, and the sort is stable.
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/** The chat as one run reads it: its messages, oldest first, and the index its searches use. */
export class ChatRun {
  private readonly byNumber: Map<number, ChatDoc>;
  private readonly docs: Map<string, ChatDoc>;

  constructor(
    readonly messages: readonly ChatDoc[],
    /** The chat's index, by message id: it may hold messages that aren't this run's, so a search passes `has` as what to keep. */
    readonly index: LexicalIndex<string>,
  ) {
    this.byNumber = new Map(messages.map((m) => [m.index, m]));
    this.docs = new Map(messages.map((m) => [m.id, m]));
  }

  /** The message with a number; undefined where the run's chat has none there. */
  at(index: number): ChatDoc | undefined {
    return this.byNumber.get(index);
  }

  /**
   * Where a number stands among the run's messages: the place in `messages` of the first whose number
   * is `index` or more (their count where none is). A range of numbers is the places from `place(from)`
   * up to `place(to + 1)`.
   */
  place(index: number): number {
    let low = 0;
    let high = this.messages.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.messages[mid] as ChatDoc).index < index) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  readonly has = (id: string): boolean => this.docs.has(id);

  /** A message of the run by its id. */
  byId(id: string): ChatDoc | undefined {
    return this.docs.get(id);
  }

  /** The run's first and last message; undefined for a chat with none. */
  get first(): ChatDoc | undefined {
    return this.messages[0];
  }

  get last(): ChatDoc | undefined {
    return this.messages.at(-1);
  }

  /** Each message's hash by its number: what a citation is checked against. */
  hashes(): Map<number, string> {
    return new Map(this.messages.map((m) => [m.index, m.hash]));
  }
}

/** The runs of consecutive numbers among `indices` (sorted), none longer than `most`: what is read from the host in one request each. */
function runsOf(indices: readonly number[], most: number): [from: number, to: number][] {
  const runs: [number, number][] = [];
  for (const index of indices) {
    const last = runs.at(-1);
    if (last && index === last[1] && index - last[0] < most) last[1] = index + 1;
    else runs.push([index, index + 1]);
  }
  return runs;
}

export class ChatCorpus {
  private index: LexicalIndex<string>;
  private docs = new Map<string, ChatDoc>();
  private last: { run: string; done: Promise<ChatRun> } | null = null;
  /** How many messages were read from the host and indexed, since the corpus was made: what a test of "only what changed" counts. */
  indexed = 0;

  constructor(
    private readonly host: Pick<HarnessHost, "chat" | "recall">,
    private readonly chatId: string,
    private pieceChars: number,
  ) {
    this.index = new LexicalIndex<string>(pieceChars);
  }

  /**
   * The chat as a run reads it, brought up to date once for each run. `path` is the run's own: the
   * messages it may read, each with its hash. A read that fails is tried again by the next call.
   */
  sync(run: string, path: readonly PathMessage[], sizes: { pieceChars: number; chatBatch: number }): Promise<ChatRun> {
    if (this.last?.run === run) return this.last.done;
    const before = this.last?.done.then(
      () => undefined,
      () => undefined,
    );
    const done = (before ?? Promise.resolve()).then(() => this.read(path, sizes));
    const held = { run, done };
    this.last = held;
    done.catch(() => {
      if (this.last === held) this.last = null;
    });
    return done;
  }

  private async texts(from: number, to: number): Promise<unknown> {
    const port = this.host.recall?.chat;
    return port ? port.messages(this.chatId, from, to) : this.host.chat.messages(this.chatId, from, to);
  }

  private async read(path: readonly PathMessage[], sizes: { pieceChars: number; chatBatch: number }): Promise<ChatRun> {
    if (sizes.pieceChars !== this.pieceChars) {
      // Search piece changed: every message is cut anew.
      this.pieceChars = sizes.pieceChars;
      this.index = new LexicalIndex<string>(sizes.pieceChars);
      this.docs = new Map();
    }
    const wanted = new Map(path.map((m) => [m.id, m]));
    const stale = path.filter((m) => this.docs.get(m.id)?.hash !== m.hash).map((m) => m.index);
    for (const [from, to] of runsOf(stale, Math.max(1, sizes.chatBatch))) {
      const read = await this.texts(from, to);
      const given: { m: PathMessage; text: string; at: number | null }[] = [];
      for (const raw of Array.isArray(read) ? read : []) {
        if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.content !== "string") continue;
        // A message that isn't the path's is another run's, or joined the chat since: it isn't read here.
        const m = wanted.get(raw.id);
        if (m) given.push({ m, text: raw.content, at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : null });
      }
      // The text is the chat's as it stands now, which may be newer than the path: each message is kept under the hash of the text read.
      const hashes = await Promise.all(given.map((one) => textHash(one.text)));
      given.forEach(({ m, text, at }, i) => {
        const hash = hashes[i] as string;
        // Already indexed with these words (numbers moved, so the host gave a message that wasn't asked for; or a run with an older path asked): it stands.
        if (this.docs.get(m.id)?.hash === hash) return;
        this.docs.set(m.id, { id: m.id, index: m.index, role: m.role, name: m.name, text, hash, at });
        this.index.add(m.id, text);
        this.indexed++;
      });
    }
    // A message that left the chat leaves the index. One past this path's end may be another run's (the reply a turn is writing, which a job reads): it stays.
    const end = path.at(-1)?.index ?? -1;
    for (const [id, doc] of this.docs) {
      if (wanted.has(id) || doc.index > end) continue;
      this.docs.delete(id);
      this.index.remove(id);
    }
    const messages: ChatDoc[] = [];
    for (const m of path) {
      const doc = this.docs.get(m.id);
      // One whose text the host didn't give isn't the run's to read. One that changed since the path was read is read as it stands, under the hash of its own words.
      if (!doc) continue;
      // A message's number moves when one before it is removed: its text, and so its place in the index, stand.
      const placed = doc.index === m.index && doc.name === m.name && doc.role === m.role ? doc : { ...doc, index: m.index, name: m.name, role: m.role };
      if (placed !== doc) this.docs.set(m.id, placed);
      messages.push(placed);
    }
    return new ChatRun(messages, this.index);
  }
}
