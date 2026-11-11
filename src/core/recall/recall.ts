// Lore and history as a harness keeps them between runs (DESIGN §24.6), and as one run reads them.
//
// `Recall` is kept for a host: the indexes of the chats worked on last (each chat's lore and its
// messages, brought up to date at each run and rebuilt only for what changed), the vectors of
// search by meaning, and how each chat's lore stood at its last turn. Nothing of it is a store of
// its own: the entries and the messages are Lumiverse's, read through the host.
//
// `RecallRun` is one run's view of it: the lore as it stood when the run first asked, the chat as
// the run's own path has it, what the prompt of the generation it answers holds, and what
// `write_reply` decided the writer sees. Every tool of §24 reads through it (`recallOf(env)`), so
// the agents of one run read one state, and a run that never asks reads nothing.

import type { Book } from "../book";
import { textHash } from "../hash";
import { wholeCut } from "../lexical";
import { docKey } from "../paths";
import type { HarnessHost, JsonValue, TurnRequest } from "../ports";
import { isRecord } from "../ports";
import type { Settings } from "../settings";
import type { StorySource } from "../story";
import { TEXT, type Texts } from "../texts";
import type { ChatView, RunInfo } from "../tools";
import { errorText } from "../util";
import { ChatCorpus, type ChatRun } from "./chat";
import { keysOf, LoreCorpus, type LoreDoc } from "./lore";
import { Meaning, type MeaningFound, type MeaningGroup, type MeaningText } from "./meaning";
import type { ActivatedEntry, MemoryArc } from "./ports";
import { type HeldDetail, type HeldLore, heldLore } from "./prompt";
import type { HeldWhy, LoreChange } from "./shapes";

/** What a run's view is made from: the host, the run, the generation it answers (none for a job's run and a side session's turn), the user's settings and texts, the run's own path of the chat, what counts as the chat's story, and the chat's book. A `ToolEnv` is one. */
export interface RunEnv {
  host: HarnessHost;
  run: RunInfo;
  turn?: TurnRequest;
  settings: Readonly<Settings>;
  texts: Texts;
  chat: Pick<ChatView, "path">;
  story: StorySource;
  book?: Book;
}

/** What `write_reply` named for the writer's request (§24.3), resolved against the lore and the prompt: the entries to add, in the order named, and the entries to take out, each as the prompt holds it. */
export interface WriterPlan {
  add: LoreDoc[];
  drop: HeldDetail[];
}

/** How a chat's lore stood at its last turn: the generation, when, each entry the prompt held with how it got there, and the entries `write_reply` added to and dropped from what the writer saw. A stored format. */
export interface LastTurn {
  v: 1;
  generationId: string;
  at: number;
  held: Record<string, HeldWhy>;
  added: string[];
  dropped: string[];
}

/** Where a chat's last turn is kept in the host's store. A stored path, so fixed. */
const lastPath = (chatId: string): string => `chats/${docKey(chatId)}/recall.json`;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** A stored last turn, read: outside data, so anything that isn't one reads as none. */
function lastOf(raw: JsonValue | null): LastTurn | null {
  if (!isRecord(raw) || raw.v !== 1 || typeof raw.generationId !== "string" || typeof raw.at !== "number" || !isRecord(raw.held)) return null;
  const held: Record<string, HeldWhy> = {};
  for (const [id, why] of Object.entries(raw.held)) {
    if (!isRecord(why)) continue;
    if (why.by === "key") held[id] = { by: "key", key: typeof why.key === "string" ? why.key : null };
    else if (why.by === "vector") held[id] = { by: "vector", score: typeof why.score === "number" ? why.score : null };
    else held[id] = why.by === "constant" ? { by: "constant" } : { by: "unknown" };
  }
  return { v: 1, generationId: raw.generationId, at: raw.at, held, added: strings(raw.added), dropped: strings(raw.dropped) };
}

interface Corpora {
  lore: LoreCorpus;
  chat: ChatCorpus;
}

export class Recall {
  /** One for each host, kept as long as the host is: whoever holds the host (a harness, a tool built for one of its runs) reaches the same indexes. */
  private static readonly hosts = new WeakMap<object, Recall>();

  static of(host: HarnessHost): Recall {
    let recall = Recall.hosts.get(host);
    if (!recall) Recall.hosts.set(host, (recall = new Recall(host)));
    return recall;
  }

  readonly meaning: Meaning;
  /** The chats whose indexes are kept, the one worked on last at the end. */
  private readonly kept = new Map<string, Corpora>();
  /** Each run's view, held as long as the run's own record is. */
  private readonly runs = new WeakMap<object, RecallRun>();
  private readonly lasts = new Map<string, LastTurn | null>();

  private constructor(readonly host: HarnessHost) {
    this.meaning = new Meaning(host);
  }

  /** A chat's indexes, made on first ask. As many chats' are kept as Settings say; the one unused longest goes first, and is indexed again when it is next read. */
  corpora(chatId: string, settings: Readonly<Settings>): Corpora {
    let held = this.kept.get(chatId);
    if (held) this.kept.delete(chatId);
    else held = { lore: new LoreCorpus(this.host, chatId, settings.tools.pieceChars), chat: new ChatCorpus(this.host, chatId, settings.tools.pieceChars) };
    this.kept.set(chatId, held);
    const most = Math.max(1, settings.recall.chat.kept);
    for (const id of this.kept.keys()) {
      if (this.kept.size <= most) break;
      this.kept.delete(id);
    }
    return held;
  }

  /** The view of the run `env` is of: the same one for every agent of the run. */
  run(env: RunEnv): RecallRun {
    let run = this.runs.get(env.run);
    if (!run) this.runs.set(env.run, (run = new RecallRun(this, env)));
    return run;
  }

  /** A run's view where the run has asked for one; undefined where none of its agents read the lore or the chat. */
  existing(info: RunInfo): RecallRun | undefined {
    return this.runs.get(info);
  }

  /** How the chat's lore stood at its last turn; null where no turn of it has been answered, or what was kept can't be read. */
  async last(chatId: string): Promise<LastTurn | null> {
    const known = this.lasts.get(chatId);
    if (known !== undefined) return known;
    let read: LastTurn | null = null;
    try {
      read = lastOf(await this.host.store.read(lastPath(chatId)));
    } catch (error) {
      this.host.log("warn", `[LumiAH] how the lore of chat ${chatId} stood at its last turn couldn't be read (${errorText(error)})`);
    }
    // A turn that began meanwhile is the newer word.
    const now = this.lasts.get(chatId);
    if (now !== undefined) return now;
    this.lasts.set(chatId, read);
    return read;
  }

  /** Keeps how a chat's lore stands at a turn, in memory and in the store. The store is written behind the turn: nothing waits for it, and a write that fails is logged. */
  keepLast(chatId: string, last: LastTurn): void {
    this.lasts.set(chatId, last);
    this.host.store.write(lastPath(chatId), last as unknown as JsonValue).catch((error: unknown) => this.host.log("warn", `[LumiAH] how the lore of chat ${chatId} stood at this turn couldn't be kept (${errorText(error)})`));
  }
}

/** The view of the run a tool is built for (or a turn is run as). */
export function recallOf(env: RunEnv): RecallRun {
  return Recall.of(env.host).run(env);
}

/** How an entry stands, as the lore tools mark it after its title: in the prompt, always sent, switched off. `held` is null for a run that answers no generation: nothing is in a prompt there. */
export function flagsOf(doc: LoreDoc, held: HeldLore | null, texts: Texts): string {
  return `${held?.byId.has(doc.entry.id) ? texts.render(TEXT.recall.state.held) : ""}${doc.entry.constant ? texts.render(TEXT.recall.state.always) : ""}${doc.entry.enabled ? "" : texts.render(TEXT.recall.state.off)}`;
}

/** An entry as it is embedded for search by meaning: its title, its keys and its text, as long as Settings embed. */
function entryText(doc: LoreDoc, most: number): string {
  const text = [doc.entry.title, keysOf(doc.entry).join(", "), doc.entry.content].filter((part) => part.trim() !== "").join("\n");
  return text.length <= most ? text : text.slice(0, wholeCut(text, most));
}

export class RecallRun {
  readonly chatId: string;
  readonly host: HarnessHost;
  /** What `write_reply` planned for the writer's request (§24.3); null until it names an entry. */
  writer: WriterPlan | null = null;
  /** A search of this run has said that it is by word only: it is said once. */
  saidWordOnly = false;
  /**
   * What the user has set up, read once when the run is equipped (`ready`): whether the Memory Cortex
   * is on for the chat, whether a databank applies to it, whether a web search provider is set up.
   * Null until then: a tool that rests on one is then offered wherever the host has its port, and
   * says so itself where the user has it off.
   */
  available: { memory: boolean; databanks: boolean; web: boolean } | null = null;
  private readied: Promise<void> | null = null;
  private readonly corpora: Corpora;
  private heldRead: Promise<HeldLore | null> | null = null;
  private arcsRead: Promise<readonly MemoryArc[]> | null = null;
  /** Each entry's text as embedded, and its hash, by the entry as the corpus holds it: an entry that changed is another object, and is hashed again. */
  private readonly embedded = new WeakMap<LoreDoc, MeaningText>();

  constructor(
    readonly recall: Recall,
    readonly env: RunEnv,
  ) {
    this.chatId = env.run.chatId;
    this.host = env.host;
    this.corpora = recall.corpora(this.chatId, env.settings);
  }

  /**
   * Reads what the user has set up of what the tools rest on (`available`), once for the run. A
   * port that fails counts as not set up, and the log says why. Never rejects.
   */
  ready(): Promise<void> {
    this.readied ??= (async (): Promise<void> => {
      const ports = this.host.recall;
      const ask = async (what: string, has: (() => Promise<boolean>) | undefined): Promise<boolean> => {
        if (!has) return false;
        try {
          return (await has()) === true;
        } catch (error) {
          this.host.log("warn", `[LumiAH] whether ${what} is set up couldn't be read (${errorText(error)}): its tools aren't offered this run`);
          return false;
        }
      };
      const { memory, databanks, web } = ports ?? {};
      const chat = this.chatId !== "";
      const [hasMemory, hasDatabanks, hasWeb] = await Promise.all([
        ask("Lumiverse's memory", memory && chat ? () => memory.enabled(this.chatId) : undefined),
        ask("a databank", databanks && chat ? async () => ((await databanks.list(this.chatId)) as unknown[]).length > 0 : undefined),
        ask("a web search provider", web ? () => web.enabled() : undefined),
      ]);
      this.available = { memory: hasMemory, databanks: hasDatabanks, web: hasWeb };
    })();
    return this.readied;
  }

  /** The lore that applies to the run's chat, as it stood when the run first asked: every entry of every book, indexed. Rejects when the books can't be read; the next ask reads again. */
  async lore(): Promise<LoreCorpus> {
    await this.corpora.lore.sync(this.env.run.id, this.env.settings.tools.pieceChars);
    return this.corpora.lore;
  }

  /** The chat as the run's own path has it: the messages that count as the story with their text, the index a search of them uses, and the numbers of those it leaves out. */
  async chat(): Promise<ChatRun> {
    const { pieceChars, chatBatch } = this.env.settings.tools;
    return this.corpora.chat.sync(this.env.run.id, await this.env.chat.path(), { pieceChars, chatBatch }, this.env.story);
  }

  /** How Lumiverse activated what it put in the generation's prompt: from the recall port where the host has one, else what `LorePort` says, which is the entries alone. */
  private async activated(turn: TurnRequest): Promise<ActivatedEntry[]> {
    const port = this.host.recall?.lore;
    const read: unknown = port ? await port.activated(turn.chatId, turn.generationId) : await this.host.lore.activated(turn.chatId, turn.generationId);
    return (Array.isArray(read) ? read : []).flatMap((raw: unknown): ActivatedEntry[] => {
      if (!isRecord(raw) || typeof raw.entryId !== "string") return [];
      return [
        {
          entryId: raw.entryId,
          bookId: typeof raw.bookId === "string" ? raw.bookId : null,
          title: typeof raw.title === "string" ? raw.title : "",
          how: raw.how === "key" || raw.how === "vector" ? raw.how : null,
          ...(typeof raw.key === "string" && raw.key.trim() !== "" ? { key: raw.key.trim() } : {}),
          ...(typeof raw.score === "number" && Number.isFinite(raw.score) ? { score: raw.score } : {}),
          ...(typeof raw.content === "string" ? { content: raw.content } : {}),
        },
      ];
    });
  }

  /**
   * Which lore the prompt of the generation this run answers holds; null for a run that answers
   * none (a job's, a side session's). Worked out once for the run. Where what Lumiverse activated
   * can't be read, the request's own flags still say which messages are lore, and the log says why
   * the rest is missing.
   */
  held(): Promise<HeldLore | null> {
    const { turn } = this.env;
    if (!turn) return Promise.resolve(null);
    this.heldRead ??= (async (): Promise<HeldLore> => {
      const corpus = await this.lore();
      const activated = await this.activated(turn).catch((error: unknown): ActivatedEntry[] => {
        this.host.log("warn", `[LumiAH] what Lumiverse activated for this reply couldn't be read (${errorText(error)}): the lore in the prompt is told from the request's messages alone`);
        return [];
      });
      return heldLore({ messages: turn.messages, activated, corpus, charsPerToken: this.env.settings.loop.charsPerToken });
    })();
    // A read of the books that failed is tried again by the next ask.
    this.heldRead.catch(() => (this.heldRead = null));
    return this.heldRead;
  }

  /** The arcs Lumiverse's Memory Cortex has made of the chat; none where the host has no memory port, the user has the Cortex off, or it can't be read (the log says why). Read once for the run. */
  arcs(): Promise<readonly MemoryArc[]> {
    this.arcsRead ??= (async (): Promise<readonly MemoryArc[]> => {
      const port = this.host.recall?.memory;
      if (!port || this.chatId === "") return [];
      try {
        if (!(await port.enabled(this.chatId))) return [];
        const read: unknown = await port.arcs(this.chatId);
        return (Array.isArray(read) ? read : []).flatMap((raw: unknown): MemoryArc[] => {
          if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.summary !== "string") return [];
          const span = Array.isArray(raw.span) && Number.isSafeInteger(raw.span[0]) && Number.isSafeInteger(raw.span[1]) ? ([Math.min(raw.span[0] as number, raw.span[1] as number), Math.max(raw.span[0] as number, raw.span[1] as number)] as [number, number]) : null;
          return [{ id: raw.id, tier: typeof raw.tier === "number" && Number.isInteger(raw.tier) && raw.tier >= 1 ? raw.tier : 1, title: typeof raw.title === "string" && raw.title.trim() !== "" ? raw.title : null, summary: raw.summary, span, at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0 }];
        });
      } catch (error) {
        this.host.log("warn", `[LumiAH] the arcs of Lumiverse's memory couldn't be read for chat ${this.chatId} (${errorText(error)}): the run goes on without them`);
        return [];
      }
    })();
    return this.arcsRead;
  }

  /** The lore's entries as search by meaning takes them, each world book's apart. */
  async loreGroups(): Promise<MeaningGroup[]> {
    const corpus = await this.lore();
    const most = this.env.settings.recall.meaning.textChars;
    const groups = new Map<string, MeaningText[]>();
    for (const doc of corpus.docs) {
      let known = this.embedded.get(doc);
      if (!known) {
        const text = entryText(doc, most);
        known = { key: doc.entry.id, hash: await textHash(text), text };
        this.embedded.set(doc, known);
      }
      const list = groups.get(doc.book.id);
      if (list) list.push(known);
      else groups.set(doc.book.id, [known]);
    }
    return [...groups].map(([id, texts]) => ({ owner: { kind: "book", id }, texts }));
  }

  /** The chat's messages as search by meaning takes them: each under the hash of its text, with as much of it as Settings embed. */
  async chatGroup(): Promise<MeaningGroup> {
    const most = this.env.settings.recall.meaning.textChars;
    const texts = (await this.chat()).messages.map((m): MeaningText => ({ key: m.id, hash: m.hash, text: m.text.length <= most ? m.text : m.text.slice(0, wholeCut(m.text, most)) }));
    return { owner: { kind: "chat", id: this.chatId }, texts };
  }

  /**
   * The lore entries (by entry id) or the chat messages (by message id) closest in meaning to each
   * query, for a search to merge with what it found by word (`mergeRanked`). `state` says whether
   * meaning was searched at all: `off` by Settings, `none` without an embedding connection. Never
   * rejects.
   */
  async meaning(what: "lore" | "chat", queries: readonly string[], keep?: (key: string) => boolean, signal?: AbortSignal): Promise<MeaningFound> {
    const { settings } = this.env;
    const nothing = (state: MeaningFound["state"]): MeaningFound => ({ state, matches: queries.map(() => []) });
    if (!settings.recall.meaning.enabled) return nothing("off");
    if (!this.host.recall?.embeddings) return nothing("none");
    try {
      const groups = what === "lore" ? await this.loreGroups() : [await this.chatGroup()];
      return await this.recall.meaning.search({ groups, queries, ...(keep ? { keep } : {}), settings, ...(signal ? { signal } : {}) });
    } catch (error) {
      this.host.log("warn", `[LumiAH] search by meaning failed (${errorText(error)}): this search is by word`);
      return nothing("on");
    }
  }

  /** What a search answer ends with the first time a run searches without an embedding connection: that search is by word. Empty every time after, and where meaning was searched or Settings switch it off. */
  wordOnlyNote(state: MeaningFound["state"]): string {
    if (state !== "none" || this.saidWordOnly) return "";
    this.saidWordOnly = true;
    return this.env.texts.render(TEXT.recall.answer.wordOnly);
  }

  /** The prompt of the generation this run answers was read: how its lore stands is kept for the chat (the lore tools of a later job and the Lore page read it). */
  told(held: HeldLore, at: number): void {
    const { turn } = this.env;
    if (!turn) return;
    const entries: Record<string, HeldWhy> = {};
    for (const [id, entry] of held.byId) entries[id] = entry.why;
    this.recall.keepLast(this.chatId, { v: 1, generationId: turn.generationId, at, held: entries, added: [], dropped: [] });
  }

  /** `write_reply` changed what the writer sees: the entries added and dropped are kept with how the chat's lore stood at this turn. */
  async wrote(change: LoreChange): Promise<void> {
    const { turn } = this.env;
    if (!turn) return;
    const last = await this.recall.last(this.chatId);
    const base: LastTurn = last?.generationId === turn.generationId ? last : { v: 1, generationId: turn.generationId, at: this.host.clock.now(), held: {}, added: [], dropped: [] };
    this.recall.keepLast(this.chatId, { ...base, added: change.added.map((e) => e.entryId), dropped: change.dropped.map((e) => e.entryId) });
  }
}
