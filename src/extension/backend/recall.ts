// What the lore and history tools read of Lumiverse beyond the lore and the chat ports (DESIGN §24),
// and a chat's LumiBooks book (§23): the core's `RecallPorts` and `BookPort`, for one user at a time.
// The core that runs here takes them as they are (`ports`, `book`); a runtime's core asks each
// member over the link (`serve`).
//
// A backend serves every user, so every read is for the user who asks. A chat is read only when it
// is theirs (refused `not_found` otherwise, another's in the same words as one that isn't there),
// and everything else is asked of Lumiverse under their id, which keeps one user's from another.
//
// Each port rests on a permission the user may not have granted. The host answers then that there
// is nothing (spindle.ts), which is how the core reads a port that isn't set up: no embedding
// connection, the Cortex off, no databank, no web search. Nothing here keeps a copy of what
// Lumiverse keeps.

import { textHash } from "../../core/hash";
import type { BookEntry, BookMessageHash, BookPort, ChatBook, JsonObject } from "../../core/ports";
import type { ActivatedEntry, Databank, LoreBookRead, LoreBookSource, MemoryArc, MemoryEntity, MemoryEntityBrief, MemoryHit, RecallPorts, TimedMessage, WebResult } from "../../core/recall/ports";
import { EMBED_BATCH_MAX, EMBED_TEXT_MAX } from "../../core/recall/ports";
import type { LinkRequestType, LinkRequests } from "../../link/contract";
import { isRecord } from "../../link/json";
import type { Chats } from "./chat";
import { LinkRefused } from "./errors";
import type { Lore } from "./reads";
import type { ActivatedInfo, BackendHost, HostChat, HostEntryRecord } from "./spindle";

export interface RecallDeps {
  chats: Chats;
  /** Which world books apply to a chat. */
  lore: Lore;
  /** The entries Lumiverse activated for a generation of the user's, as its prompt's context named them; none for a generation LumiAH had no turn in. */
  activated(userId: string, chatId: string, generationId: string): ActivatedInfo[];
  now(): number;
}

/** The link requests served here: the recall ports' and the book's. */
export type RecallRequest = Extract<LinkRequestType, `recall.${string}` | "book.read">;

/** What an embed call gives: one vector per text, and the model and length they are of. */
type Embedded = { vectors: number[][]; model: string; dimensions: number };

/** A message LumiBooks kept a hash of: its place in the chat, and the hash. */
type KeptHash = { index: number; hash: string };

const SAME_BUILD = "update the runtime and LumiAH to the same build";

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((s): s is string => typeof s === "string" && s !== "") : []);

/** A link request's field that names something: text, and not empty. */
function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new LinkRefused("bad_request", `The request names no ${what}: ${SAME_BUILD}.`);
  return value;
}

/** A link request's field that counts something: a whole number, zero or more. */
function whole(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new LinkRefused("bad_request", `The request's ${what} isn't a whole number: ${SAME_BUILD}.`);
  return value;
}

/**
 * A read the host can't be told to stop, given up when its signal ends: the caller is let go at
 * once, and what the host answers afterwards is dropped. A signal that ended while the read was
 * being set up lets the caller go just the same.
 */
function givenUp<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const ended = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error("The call was cancelled."));
  work.then(resolve, reject).finally(() => signal.removeEventListener("abort", ended));
  if (signal.aborted) ended();
  else signal.addEventListener("abort", ended, { once: true });
  return promise;
}

/** An entry as the core reads a book's: of what LumiBooks keeps on it, the members the core reads, each only where it is of its type. */
function bookEntryOf(e: HostEntryRecord): BookEntry {
  const own = e.extensions.lumibooks;
  const kept = e.extensions.lumibooks_summary;
  const extensions: BookEntry["extensions"] = {};
  if (isRecord(own)) {
    extensions.lumibooks = {
      ...(typeof own.chatId === "string" ? { chatId: own.chatId } : {}),
      ...(typeof own.tier === "number" ? { tier: own.tier } : {}),
      ...(Array.isArray(own.msgIds) ? { msgIds: strings(own.msgIds) } : {}),
      ...(typeof own.firstMsgIdx === "number" ? { firstMsgIdx: own.firstMsgIdx } : {}),
      ...(typeof own.lastMsgIdx === "number" ? { lastMsgIdx: own.lastMsgIdx } : {}),
      ...(typeof own.title === "string" ? { title: own.title } : {}),
      ...(own.isRoot === true ? { isRoot: true } : {}),
    };
  }
  if (isRecord(kept)) {
    extensions.lumibooks_summary = {
      ...(typeof kept.tier === "number" ? { tier: kept.tier } : {}),
      ...(Array.isArray(kept.messageIndices) ? { messageIndices: kept.messageIndices.filter((n): n is number => typeof n === "number") } : {}),
    };
  }
  return { id: e.id, comment: e.title, content: e.content, extensions };
}

/** LumiBooks' marks on the books it keeps itself: a chat's own book, and a chat's codex. Neither is ever a summaries lorebook. */
const LUMIBOOKS_MARKS = ["lumibooks_chat_id", "lumibooks_codex_chat_id"] as const;

/** A hash as LumiBooks writes one: SHA-256, in lower-case hex. A format, not a limit. */
const KEPT_HASH = /^[0-9a-f]{64}$/;

/**
 * The message hashes a summaries lorebook keeps, as LumiBooks writes them on the lorebook's file
 * (its `lumibooks_summary`, with the file's other extension data); null for a book that carries
 * none. A world book has no place of its own for a file's extension data, so they are looked for
 * in its metadata, under that key or among `extensions` there, wherever whatever made the book
 * put them. Lumiverse's own import of a file keeps only what stands on its entries.
 */
function keptHashesOf(metadata: JsonObject): KeptHash[] | null {
  const filed = isRecord(metadata.extensions) ? metadata.extensions.lumibooks_summary : undefined;
  const mark = isRecord(metadata.lumibooks_summary) ? metadata.lumibooks_summary : filed;
  if (!isRecord(mark) || !Array.isArray(mark.messages)) return null;
  const out = new Map<number, string>();
  for (const m of mark.messages) if (isRecord(m) && typeof m.index === "number" && Number.isSafeInteger(m.index) && m.index >= 0 && typeof m.hash === "string" && KEPT_HASH.test(m.hash)) out.set(m.index, m.hash);
  return [...out].map(([index, hash]) => ({ index, hash }));
}

export class Recall {
  constructor(
    private readonly host: Pick<BackendHost, "chats" | "lore" | "embeddings" | "memory" | "databanks" | "web">,
    private readonly deps: RecallDeps,
  ) {}

  /** What the lore and history tools read for one user's runs (`HarnessHost.recall`). */
  ports(userId: string): RecallPorts {
    const { embeddings, databanks, web } = this.host;
    return {
      lore: { read: (chatId, known) => this.lore(userId, chatId, known), activated: (chatId, generationId) => this.activated(userId, chatId, generationId) },
      chat: { messages: (chatId, from, to) => this.messages(userId, chatId, from, to) },
      embeddings: { connection: () => embeddings.connection(userId), embed: (texts, kind, signal) => this.embed(userId, texts, kind, signal) },
      memory: {
        enabled: (chatId) => this.memoryOn(userId, chatId),
        search: (chatId, query, options, signal) => this.memorySearch(userId, chatId, query, options, signal),
        entity: (chatId, name) => this.memoryEntity(userId, chatId, name),
        entities: (chatId, limit) => this.memoryEntities(userId, chatId, limit),
        arcs: (chatId) => this.memoryArcs(userId, chatId),
      },
      // A databank's documents and a document's text are asked for by id alone: Lumiverse gives a user none but their own.
      databanks: { list: (chatId) => this.databanks(userId, chatId), documents: (databankId) => databanks.documents(databankId, userId), content: (documentId) => databanks.content(documentId, userId) },
      web: { enabled: () => web.enabled(userId), search: (query, options, signal) => this.webSearch(userId, query, options, signal) },
    };
  }

  /** A chat's LumiBooks book for one user's runs (`HarnessHost.book`). */
  book(userId: string): BookPort {
    return { read: (chatId) => this.chatBook(userId, chatId) };
  }

  /**
   * One of the ports' reads as a runtime asks it over the link, for the user its relay is of. The
   * request's fields are checked here; nothing a runtime sends can stop a read under way, so none
   * takes a signal.
   */
  async serve(userId: string, type: RecallRequest, r: Readonly<Record<string, unknown>>): Promise<LinkRequests[RecallRequest]["result"]> {
    const { embeddings, databanks, web } = this.host;
    switch (type) {
      case "recall.lore.read": {
        const known: Record<string, number> = {};
        if (isRecord(r.known)) for (const [id, at] of Object.entries(r.known)) if (typeof at === "number" && Number.isFinite(at)) known[id] = at;
        return { books: await this.lore(userId, text(r.chat, "chat"), known) };
      }
      case "recall.lore.activated":
        return { entries: await this.activated(userId, text(r.chat, "chat"), text(r.generation, "generation")) };
      case "recall.chat.messages":
        return { messages: await this.messages(userId, text(r.chat, "chat"), whole(r.from, "range"), whole(r.to, "range")) };
      case "recall.embedder":
        return { connection: await embeddings.connection(userId) };
      case "recall.embed": {
        if (!Array.isArray(r.texts) || !r.texts.every((t): t is string => typeof t === "string") || (r.kind !== "query" && r.kind !== "stored")) throw new LinkRefused("bad_request", `The request to embed is malformed: ${SAME_BUILD}.`);
        return this.embed(userId, r.texts, r.kind);
      }
      case "recall.memory.enabled":
        return { enabled: await this.memoryOn(userId, text(r.chat, "chat")) };
      case "recall.memory.search":
        return { hits: await this.memorySearch(userId, text(r.chat, "chat"), typeof r.query === "string" ? r.query : "", { limit: whole(r.limit, "limit"), entities: strings(r.entities) }) };
      case "recall.memory.entity":
        return { entity: await this.memoryEntity(userId, text(r.chat, "chat"), text(r.name, "entity")) };
      case "recall.memory.entities":
        return { entities: await this.memoryEntities(userId, text(r.chat, "chat"), whole(r.limit, "limit")) };
      case "recall.memory.arcs":
        return { arcs: await this.memoryArcs(userId, text(r.chat, "chat")) };
      case "recall.databanks.list":
        return { databanks: await this.databanks(userId, text(r.chat, "chat")) };
      case "recall.databanks.documents":
        return { documents: await databanks.documents(text(r.databank, "databank"), userId) };
      case "recall.databanks.content":
        return { text: await databanks.content(text(r.document, "document"), userId) };
      case "recall.web.enabled":
        return { enabled: await web.enabled(userId) };
      case "recall.web.search":
        return { results: await this.webSearch(userId, typeof r.query === "string" ? r.query : "", { count: whole(r.count, "count"), pages: r.pages === true }) };
      case "book.read":
        return { book: await this.chatBook(userId, text(r.chat, "chat")) };
    }
  }

  // ---------------------------------------------------------------- lore

  /**
   * `RecallLorePort.read`: every book that applies to the chat (`Lore.books` says which, and in what
   * order), each with every entry of it. A book whose stamp is the one the caller holds for it
   * comes with `entries` null.
   *
   * Lumiverse stamps a book when it or any entry of it changes, to the second. So a stamp says that
   * nothing changed since only once its second is over: a change later in the same second carries
   * the same one. Until then a book is given whole with no stamp (0), which a caller never holds
   * against a later read.
   */
  private async lore(userId: string, chatId: string, known: Readonly<Record<string, number>> = {}): Promise<LoreBookRead[]> {
    const chat = await this.deps.chats.own(userId, chatId);
    const [books, sources] = await Promise.all([this.deps.lore.books(userId, chat), this.sources(userId, chat)]);
    const read = await Promise.all(
      books.map(async (book): Promise<LoreBookRead | null> => {
        // The stamp is read before the entries: a change between the two reads moves the book's stamp past the one given here, so the entries are read again next time.
        const record = await this.host.lore.record(book.id, userId);
        if (record === null) return null;
        const over = record.updatedAt > 0 && this.deps.now() >= (Math.floor(record.updatedAt / 1000) + 1) * 1000;
        const stamp = over ? record.updatedAt : 0;
        // What extensions keep on an entry is no part of what the lore tools read of it.
        const entries = stamp > 0 && known[book.id] === stamp ? null : (await this.host.lore.records(book.id, userId)).map(({ extensions: _kept, ...entry }) => entry);
        return { id: record.id, name: record.name, description: record.description, source: sources.get(record.id) ?? null, updatedAt: stamp, entries };
      }),
    );
    return read.filter((book): book is LoreBookRead => book !== null);
  }

  /**
   * Where each book attached somewhere the chat reads from applies from. A book attached at several
   * places is said as Lumiverse says it, by the narrowest: a character's before a persona's before
   * the chat's own before one switched on for every chat. The persona is the user's active one:
   * which persona the chat's last turn was assembled for isn't known here. So a book that applies
   * through another persona, or only because Lumiverse activated an entry of it, has no source.
   */
  private async sources(userId: string, chat: HostChat): Promise<Map<string, LoreBookSource>> {
    const { lore } = this.host;
    const [ofCharacter, ofPersona, global] = await Promise.all([
      chat.characterId !== null ? lore.ofCharacter(chat.characterId, userId).catch((): string[] => []) : [],
      lore.ofPersona(null, userId).catch(() => null),
      lore.global(userId).catch((): string[] => []),
    ]);
    const out = new Map<string, LoreBookSource>();
    // The widest first, so a narrower one stands over it.
    for (const id of global) out.set(id, "global");
    for (const id of strings(chat.metadata.chat_world_book_ids)) out.set(id, "chat");
    if (ofPersona !== null) out.set(ofPersona, "persona");
    for (const id of ofCharacter) out.set(id, "character");
    return out;
  }

  /**
   * `RecallLorePort.activated`: how Lumiverse activated each entry it put in a generation's prompt,
   * each with its text as stored where it can still be read. Lumiverse says which entries and how,
   * and not the text it made of each, so an entry's macros stand unfilled here.
   */
  private async activated(userId: string, chatId: string, generationId: string): Promise<ActivatedEntry[]> {
    return Promise.all(
      this.deps.activated(userId, chatId, generationId).map(async (a): Promise<ActivatedEntry> => {
        const entry = await this.host.lore.entry(a.entryId, userId).catch(() => null);
        return { entryId: a.entryId, bookId: a.bookId ?? entry?.bookId ?? null, title: a.title !== "" ? a.title : (entry?.title ?? ""), how: a.how ?? null, ...(a.score !== undefined ? { score: a.score } : {}), ...(entry !== null ? { content: entry.content } : {}) };
      }),
    );
  }

  // ---------------------------------------------------------------- the chat

  /** `RecallChatPort.messages`: as `Chats.messages`, each message with when it was sent. */
  private async messages(userId: string, chatId: string, from: number, to: number): Promise<TimedMessage[]> {
    await this.deps.chats.own(userId, chatId);
    return (await this.deps.chats.range(chatId, from, to)).map((m) => ({ id: m.id, index: m.index, role: m.role, name: m.name, swipeId: m.swipeId, content: m.content, at: m.at }));
  }

  // ---------------------------------------------------------------- embeddings

  /**
   * `EmbeddingsPort.embed`: one vector per text, in order, on the user's main embedding connection.
   * A call outside Lumiverse's bounds (`EMBED_BATCH_MAX`, `EMBED_TEXT_MAX`) is refused here, in
   * words that name the bound, before Lumiverse refuses it in its own.
   */
  private async embed(userId: string, texts: readonly string[], kind: "query" | "stored", signal?: AbortSignal): Promise<Embedded> {
    if (texts.length === 0 || texts.length > EMBED_BATCH_MAX) throw new LinkRefused("bad_request", `One call embeds from 1 to ${EMBED_BATCH_MAX} texts, and this one has ${texts.length}.`);
    const wrong = texts.findIndex((t) => t.trim() === "" || t.length > EMBED_TEXT_MAX);
    if (wrong >= 0) throw new LinkRefused("bad_request", `A text to embed is not blank and has ${EMBED_TEXT_MAX} characters at most: text ${wrong + 1} of this call isn't so.`);
    const out = await this.host.embeddings.embed(texts, kind, userId, signal);
    // A caller places each vector by its text's place: fewer or more than were asked for can't be placed.
    if (out.vectors.length !== texts.length) throw new Error(`The embedding connection answered ${out.vectors.length} vectors for ${texts.length} texts.`);
    return out;
  }

  // ---------------------------------------------------------------- Lumiverse's Memory Cortex

  /**
   * `MemoryPort.enabled`: whether the Cortex is on for the chat, as Lumiverse itself decides it: on
   * for the user, the chat not a temporary one, and not switched off in the chat's own Cortex
   * settings.
   */
  private async memoryOn(userId: string, chatId: string): Promise<boolean> {
    const chat = await this.deps.chats.own(userId, chatId);
    const own = chat.metadata.cortex_settings;
    if (chat.metadata.temporary === true || (isRecord(own) && own.enabled === false)) return false;
    return this.host.memory.enabled(userId);
  }

  /** `MemoryPort.search`: the Cortex's own answer to a query over the chat's memory, `limit` at most. */
  private async memorySearch(userId: string, chatId: string, query: string, options: { limit: number; entities?: readonly string[] }, signal?: AbortSignal): Promise<MemoryHit[]> {
    signal?.throwIfAborted();
    await this.deps.chats.own(userId, chatId);
    return givenUp(this.host.memory.search(chatId, query, options, userId), signal);
  }

  /** `MemoryPort.entity`: what the Cortex has of a person, a place or a thing of the chat's, by its name or an alias. */
  private async memoryEntity(userId: string, chatId: string, name: string): Promise<MemoryEntity | null> {
    await this.deps.chats.own(userId, chatId);
    return this.host.memory.entity(chatId, name, userId);
  }

  /** `MemoryPort.entities`: the chat's entities, the most salient first, `limit` at most. */
  private async memoryEntities(userId: string, chatId: string, limit: number): Promise<MemoryEntityBrief[]> {
    await this.deps.chats.own(userId, chatId);
    return this.host.memory.entities(chatId, limit, userId);
  }

  /** `MemoryPort.arcs`: the chat's arcs, of every tier. */
  private async memoryArcs(userId: string, chatId: string): Promise<MemoryArc[]> {
    await this.deps.chats.own(userId, chatId);
    return this.host.memory.arcs(chatId, userId);
  }

  // ---------------------------------------------------------------- databanks

  /**
   * `DatabanksPort.list`: the databanks that apply to the chat, as Lumiverse picks them for a
   * prompt: those switched on that are global, scoped to the chat or to its character, or named by
   * the chat's metadata or by the character's card. A chat that keeps its memory to itself (its
   * `memory_isolation`) takes none through its character. A databank switched on for every chat in
   * Lumiverse's own settings without being global itself isn't seen here: an extension is shown no
   * setting.
   */
  private async databanks(userId: string, chatId: string): Promise<Databank[]> {
    const chat = await this.deps.chats.own(userId, chatId);
    const on = (await this.host.databanks.list(userId)).filter((bank) => bank.enabled);
    if (on.length === 0) return [];
    const character = chat.metadata.memory_isolation === true ? null : chat.characterId;
    const named = new Set([...strings(chat.metadata.chat_databank_ids), ...(character !== null ? await this.host.databanks.ofCharacter(character, userId).catch((): string[] => []) : [])]);
    return on
      .filter((bank) => bank.scope === "global" || (bank.scope === "chat" && bank.scopeId === chat.id) || (bank.scope === "character" && character !== null && bank.scopeId === character) || named.has(bank.id))
      .map((bank) => ({ id: bank.id, name: bank.name, description: bank.description, scope: bank.scope, documents: bank.documents }));
  }

  // ---------------------------------------------------------------- web search

  /** `WebSearchPort.search`: the user's provider's results for a query, `count` at most. Lumiverse gives one result at least, so a call for none is answered here. */
  private async webSearch(userId: string, query: string, options: { count: number; pages: boolean }, signal?: AbortSignal): Promise<WebResult[]> {
    signal?.throwIfAborted();
    if (options.count < 1) return [];
    return givenUp(this.host.web.search(query, { count: options.count, pages: options.pages }, userId), signal);
  }

  // ---------------------------------------------------------------- a story's book

  /**
   * `BookPort.read`: the chat's LumiBooks book (DESIGN §23); null when it has none.
   *
   * LumiBooks' own book for a chat is the one the chat's metadata names (`lumibooks_book_id`), when
   * that book's metadata names the chat back (`lumibooks_chat_id`): a branch carries its source's
   * claim, and the book stays the source's. Where the chat has none, a summaries lorebook LumiBooks
   * exported, kept as a world book of this chat, is the book: one with an entry LumiBooks marked as
   * a summary (`lumibooks_summary`), or that keeps its message hashes. Only a book attached to the
   * chat itself is taken for one. Its entries name the chat's messages by their places, which mean
   * nothing in another chat, so a lorebook that reaches the chat through its character, a persona
   * or every chat is lore and no book.
   *
   * `hashes` are a summaries lorebook's own, whichever book the entries are of.
   */
  private async chatBook(userId: string, chatId: string): Promise<ChatBook | null> {
    const chat = await this.deps.chats.own(userId, chatId);
    const { lore } = this.host;
    const claimed = chat.metadata.lumibooks_book_id;
    const named = typeof claimed === "string" && claimed !== "" ? await lore.record(claimed, userId) : null;
    const own = named !== null && named.metadata.lumibooks_chat_id === chat.id ? await lore.records(named.id, userId) : [];
    // A book LumiBooks made for the chat and has written nothing in yet is no book: a summaries lorebook the user keeps stands until it has.
    let entries = own.length > 0 ? own : null;
    let kept: KeptHash[] | null = null;
    // The chat's own books, in the chat's order: the first that is a summaries lorebook gives what the chat's own book doesn't.
    for (const id of strings(chat.metadata.chat_world_book_ids)) {
      if (kept !== null && entries !== null) break;
      const record = await lore.record(id, userId);
      if (record === null || LUMIBOOKS_MARKS.some((mark) => record.metadata[mark] !== undefined)) continue;
      const hashes = keptHashesOf(record.metadata);
      // With the chat's own book in hand only the hashes are wanted, which the book's metadata holds: no lorebook's entries are read for them.
      if (entries !== null) {
        kept ??= hashes;
        continue;
      }
      const summaries = await lore.records(id, userId);
      if (hashes === null && !summaries.some((e) => isRecord(e.extensions.lumibooks_summary))) continue;
      entries = summaries;
      kept = hashes ?? [];
    }
    return entries === null ? null : { entries: entries.map(bookEntryOf), hashes: await this.hashes(chat.id, kept ?? []) };
  }

  /**
   * Each hash a summaries lorebook kept, beside LumiBooks' hash of the message that stands at the
   * same place now: the SHA-256 of the message's role and its text as JSON, as Lumiverse gives
   * them (LumiBooks' `sha256-role-content-v1`).
   */
  private async hashes(chatId: string, kept: readonly KeptHash[]): Promise<BookMessageHash[]> {
    if (kept.length === 0) return [];
    const first = kept.reduce((least, k) => Math.min(least, k.index), Number.POSITIVE_INFINITY);
    const last = kept.reduce((most, k) => Math.max(most, k.index), 0);
    const now = new Map((await this.deps.chats.range(chatId, first, last + 1)).map((m) => [m.index, m]));
    const out: BookMessageHash[] = [];
    for (const k of kept) {
      const m = now.get(k.index);
      out.push({ index: k.index, kept: k.hash, now: m === undefined ? null : await textHash(JSON.stringify([m.role, m.content])) });
    }
    return out.sort((a, b) => a.index - b.index);
  }
}
