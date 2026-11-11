// What the tests of lore and history (DESIGN §24) share: the in-memory host with the recall ports
// Lumiverse's extension would give (every lore entry with its state, how each was activated, when
// each message was sent, and, where a test mounts them, an embedder, the Memory Cortex, databanks
// and a web search provider), and a rig that builds tools over it as one run builds them.

import { Blobs } from "../../src/core/blobs";
import type { Book } from "../../src/core/book";
import { DOC, ROOT_AREA } from "../../src/core/paths";
import type { ChatRole, JsonObject, RequestMessage, RunKind, TurnRequest } from "../../src/core/ports";
import type { ActivatedEntry, Databank, DatabankDocument, DatabanksPort, EmbedderInfo, EmbeddingsPort, LoreBookRead, LoreBookSource, LoreRecord, MemoryArc, MemoryEntity, MemoryEntityBrief, MemoryHit, MemoryPort, RecallPorts, TimedMessage, WebResult, WebSearchPort } from "../../src/core/recall/ports";
import { recallOf } from "../../src/core/recall/recall";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { Texts } from "../../src/core/texts";
import type { AgentTool, ToolDefinition, ToolEnv, ToolOutcome } from "../../src/core/tools";
import { chatView, loreView } from "../../src/core/views";
import { Area, storeHead, type WorkspaceDeps, type WorkspaceView } from "../../src/core/workspace";
import { MemoryHost } from "./support/host";

export const CHAT = "chat-1";

/** A day in milliseconds, and the moment the fixtures' chats begin. */
export const DAY = 86_400_000;
export const START = Date.UTC(2026, 2, 4, 9, 0);

/** An embedder for tests: each group of `concepts` is words that mean the same, and a text's vector says which groups it touches, so a paraphrase is close and a text about something else is not. Every call is kept. */
export class FakeEmbedder implements EmbeddingsPort {
  readonly calls: { texts: string[]; kind: "query" | "stored" }[] = [];
  info: EmbedderInfo | null = { id: "embed-1", name: "Embedder", model: "fake-embed", dimensions: null };
  /** Fails every call with these words while set. */
  fail: string | null = null;

  constructor(private readonly concepts: readonly (readonly string[])[]) {}

  /** How many texts were embedded as stored texts, over every call. */
  get stored(): string[] {
    return this.calls.filter((c) => c.kind === "stored").flatMap((c) => c.texts);
  }

  vector(text: string): number[] {
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const out = new Array<number>(this.concepts.length + 8).fill(0);
    for (const word of words) {
      const at = this.concepts.findIndex((group) => group.includes(word));
      if (at >= 0) out[at] = (out[at] ?? 0) + 1;
      // A little of every other word, so two texts about nothing listed still differ.
      else {
        const bucket = this.concepts.length + ([...word].reduce((n, c) => n + (c.codePointAt(0) ?? 0), 0) % 8);
        out[bucket] = (out[bucket] ?? 0) + 0.05;
      }
    }
    return out;
  }

  connection = async (): Promise<EmbedderInfo | null> => this.info;

  embed = async (texts: readonly string[], kind: "query" | "stored"): Promise<{ vectors: number[][]; model: string; dimensions: number }> => {
    this.calls.push({ texts: [...texts], kind });
    if (this.fail !== null) throw new Error(this.fail);
    return { vectors: texts.map((text) => this.vector(text)), model: this.info?.model ?? "fake-embed", dimensions: this.concepts.length + 8 };
  };
}

/** Lumiverse's Memory Cortex as a test sets it. */
export class FakeMemory implements MemoryPort {
  on = true;
  hits: MemoryHit[] = [];
  entitiesKnown: MemoryEntity[] = [];
  arcsMade: MemoryArc[] = [];
  readonly searches: { query: string; limit: number; entities?: readonly string[] }[] = [];

  enabled = async (): Promise<boolean> => this.on;
  search = async (_chatId: string, query: string, options: { limit: number; entities?: readonly string[] }): Promise<MemoryHit[]> => {
    this.searches.push({ query, ...options });
    const words = query.toLowerCase().split(/\s+/);
    return this.hits.filter((hit) => words.some((word) => hit.text.toLowerCase().includes(word))).slice(0, options.limit);
  };
  entity = async (_chatId: string, name: string): Promise<MemoryEntity | null> => this.entitiesKnown.find((e) => e.name.toLowerCase() === name.toLowerCase() || e.aliases.some((a) => a.toLowerCase() === name.toLowerCase())) ?? null;
  entities = async (_chatId: string, limit: number): Promise<MemoryEntityBrief[]> => this.entitiesKnown.slice(0, limit).map((e) => ({ name: e.name, type: e.type, mentions: e.mentions }));
  arcs = async (): Promise<MemoryArc[]> => [...this.arcsMade];
}

/** The user's databanks as a test sets them. */
export class FakeDatabanks implements DatabanksPort {
  banks: Databank[] = [];
  docs: DatabankDocument[] = [];
  readonly texts = new Map<string, string>();
  /** How many times each document's text was read. */
  readonly reads = new Map<string, number>();

  list = async (): Promise<Databank[]> => [...this.banks];
  documents = async (databankId: string): Promise<DatabankDocument[]> => this.docs.filter((d) => d.databankId === databankId);
  content = async (documentId: string): Promise<string | null> => {
    this.reads.set(documentId, (this.reads.get(documentId) ?? 0) + 1);
    return this.texts.get(documentId) ?? null;
  };

  /** Adds a document that Lumiverse has read in. */
  add(databankId: string, id: string, name: string, text: string, more: Partial<DatabankDocument> = {}): void {
    this.docs.push({ id, databankId, name, version: `v-${text.length}`, bytes: text.length, status: "ready", ...more });
    this.texts.set(id, text);
  }
}

/** The user's web search provider as a test sets it. */
export class FakeWeb implements WebSearchPort {
  on = true;
  results: WebResult[] = [];
  readonly searches: { query: string; count: number; pages: boolean }[] = [];

  enabled = async (): Promise<boolean> => this.on;
  search = async (query: string, options: { count: number; pages: boolean }): Promise<WebResult[]> => {
    this.searches.push({ query, ...options });
    return this.results.slice(0, options.count).map(({ content, ...result }) => (options.pages && content !== undefined ? { ...result, content } : result));
  };
}

/** The in-memory host with the recall ports. A test that wants a host without one deletes it (`delete host.recall.memory`), or the whole of `recall`. */
export class RecallHost extends MemoryHost {
  /** When each message was sent, by its id. */
  readonly times = new Map<string, number>();
  /** What Lumiverse keeps on an entry beside what `LorePort` gives, by the entry's id. */
  readonly entryMore = new Map<string, Partial<Pick<LoreRecord, "vectorized" | "regex" | "role" | "order" | "updatedAt">>>();
  /** Where a book applies from and when it last changed, by the book's id. */
  readonly bookMore = new Map<string, { source?: LoreBookSource | null; updatedAt?: number }>();
  /** How Lumiverse activated each entry of `activatedLore`, by the entry's id (and the key it names, where it names one); an entry not here was activated by a key Lumiverse doesn't name. */
  readonly activatedHow = new Map<string, { how: "key" | "vector" | null; score?: number; key?: string }>();
  /** How many times the books were read through the recall port, and how many of them whole. */
  loreReads = 0;
  bookReads = 0;

  recall?: RecallPorts = {
    lore: {
      read: async (_chatId: string, known?: Readonly<Record<string, number>>): Promise<LoreBookRead[]> => {
        this.loreReads++;
        return this.books.map((book): LoreBookRead => {
          const more = this.bookMore.get(book.id);
          const updatedAt = more?.updatedAt ?? 0;
          const same = updatedAt > 0 && known?.[book.id] === updatedAt;
          if (!same) this.bookReads++;
          return {
            id: book.id,
            name: book.name,
            description: book.description,
            source: more?.source ?? null,
            updatedAt,
            entries: same ? null : this.entries.filter((e) => e.bookId === book.id).map((e): LoreRecord => ({ ...structuredClone(e), vectorized: false, regex: false, role: null, order: 0, updatedAt: 0, ...this.entryMore.get(e.id) })),
          };
        });
      },
      activated: async (): Promise<ActivatedEntry[]> => this.activatedLore.map((a): ActivatedEntry => ({ entryId: a.entryId, bookId: a.bookId, title: a.title, content: a.content, how: "key", ...this.activatedHow.get(a.entryId) })),
    },
    chat: {
      messages: async (chatId: string, from: number, to: number): Promise<TimedMessage[]> => (await this.chat.messages(chatId, from, to)).map((m) => ({ ...m, at: this.times.get(m.id) ?? null })),
    },
  };

  /** Adds a message sent at `at`; its id. */
  sayAt(chatId: string, role: ChatRole, text: string, at: number, name?: string): string {
    const id = name === undefined ? this.say(chatId, role, text) : this.say(chatId, role, text, name);
    this.times.set(id, at);
    return id;
  }

  /** Adds a world book; its id. */
  addBook(id: string, name: string, description = ""): string {
    this.books.push({ id, name, description });
    return id;
  }

  /** Adds an entry to a book; its id. */
  addEntry(bookId: string, id: string, title: string, keys: string[], content: string, more: Partial<LoreRecord> = {}): string {
    const { enabled = true, constant = false, secondaryKeys = [], vectorized, regex, role, order, updatedAt } = more;
    this.entries.push({ id, bookId, title, keys, secondaryKeys, content, enabled, constant });
    const extra = { ...(vectorized !== undefined ? { vectorized } : {}), ...(regex !== undefined ? { regex } : {}), ...(role !== undefined ? { role } : {}), ...(order !== undefined ? { order } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}) };
    if (Object.keys(extra).length > 0) this.entryMore.set(id, extra);
    return id;
  }

  /** A world-info message of a request, as Lumiverse flags one: the entry's own text, and which entry where `named`. */
  loreMessage(entryId: string, named = true, role: ChatRole = "system"): RequestMessage {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`no entry ${entryId}`);
    return { role, content: entry.content, source: named ? { kind: "lore", entryId } : { kind: "lore" } };
  }
}

export interface Rig {
  host: RecallHost;
  env: ToolEnv;
  settings: Settings;
  tools: Map<string, AgentTool>;
  /** Runs a tool as an agent of the run calls it. */
  run(name: string, args?: JsonObject): Promise<ToolOutcome>;
  /** The names of the tools offered. */
  offered(): string[];
}

/**
 * The tools of `definitions` built over a host as one run builds them for an agent. `turn`: the
 * generation the run answers (its messages are the request; left out: a request of the chat's
 * messages, each flagged as history; null: a job's run, which answers none). The run reads the
 * chat's whole path. `book`: the chat's LumiBooks book, as a run reads one. `ready`: read what the
 * user has set up before the tools are built, as a run does when it is equipped
 * (`RecallRun.ready`). Each rig is a run of its own: give another `runId` for a later run of the
 * same chat (a run reads the chat and its lore once).
 */
export async function toolRig(
  host: RecallHost,
  definitions: readonly ToolDefinition[],
  options: { chatId?: string; settings?: (s: Settings) => void; texts?: Record<string, string>; turn?: Partial<TurnRequest> | null; kind?: RunKind; runId?: string; writeReply?: ToolEnv["writeReply"]; book?: Book; ready?: boolean } = {},
): Promise<Rig> {
  const chatId = options.chatId ?? CHAT;
  const settings = defaultSettings();
  options.settings?.(settings);
  const path = await host.chat.path(chatId);
  const turn: TurnRequest | undefined =
    options.turn === null
      ? undefined
      : { userId: "user-1", chatId, generationId: options.runId ?? "gen-now", kind: "new", target: { messageId: null, swipeId: 0 }, presetId: null, messages: host.requestOf(chatId, path.length, null), params: {}, maxTokens: null, ...options.turn };
  const blobs = new Blobs(host, () => settings.keep.blobChars);
  const deps: WorkspaceDeps = { host, blobs, limits: () => settings.workspace };
  const workspace: WorkspaceView = {
    author: { who: "agent", id: "agent_test", role: "main" },
    role: "main",
    areas: { chat: new Area(deps, "chat", storeHead(host, DOC.chatArea(chatId, ROOT_AREA))), learned: new Area(deps, "learned", storeHead(host, DOC.learned(chatId))), user: new Area(deps, "user", storeHead(host, DOC.userArea)) },
    guard: () => null,
  };
  const env: ToolEnv = {
    host,
    run: { id: options.runId ?? turn?.generationId ?? "job-now", kind: options.kind ?? (turn ? "new" : "job"), chatId },
    ...(turn ? { turn } : {}),
    settings,
    texts: new Texts(options.texts ?? {}),
    agent: "main",
    depth: 0,
    chat: chatView(host, chatId, path, settings.tools),
    lore: loreView(host, turn ?? { chatId, generationId: "" }, settings.tools),
    past: [],
    workspace,
    ...(options.writeReply ? { writeReply: options.writeReply } : {}),
    ...(options.book ? { book: options.book } : {}),
  };
  if (options.ready) await recallOf(env).ready();
  const tools = new Map(definitions.flatMap((d) => d.build(env) ?? []).map((t): [string, AgentTool] => [t.name, t]));
  return {
    host,
    env,
    settings,
    tools,
    run: (name, args = {}) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`no tool ${name}`);
      return tool.run(args, { signal: new AbortController().signal, agentId: "agent_test", role: "main", callId: "c1" });
    },
    offered: () => [...tools.keys()],
  };
}

/** The cursor an answer ends with, or null when it has none. */
export const cursorOf = (text: string): string | null => /cursor "([^"]+)"\.\]/.exec(text)?.[1] ?? null;

/** Every page of a tool's answer to `args`, read by following each page's cursor. */
export async function pages(rig: Pick<Rig, "run">, name: string, args: JsonObject): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const page: ToolOutcome = await rig.run(name, cursor === null ? args : { ...args, cursor });
    if (page.error) throw new Error(`${name} failed: ${page.text}`);
    out.push(page.text);
    cursor = cursorOf(page.text);
  } while (cursor !== null && out.length < 200);
  return out;
}

/** A small story for the tests: a harbour chat of a dozen messages over three sittings, and two world books. Names are the fixtures' own. */
export function harbour(host: RecallHost = new RecallHost()): RecallHost {
  const lines: [ChatRole, string, number][] = [
    ["user", "I walk down to the harbour at dusk. The brass key is heavy in my coat.", 0],
    ["assistant", "Joss looks up from the nets. \"You kept it, then. Brann swore that key went down with the Heron.\"", 2],
    ["user", "\"Brann swears a lot of things.\" I show him the brass key.", 4],
    ["assistant", "He turns it over twice. \"It opens the customs house strongbox. Okoro has the only other.\"", 6],
    ["user", "The next morning I row out to the lighthouse to find Okoro.", DAY],
    ["assistant", "Okoro is trimming the lamp. He doesn't turn around. \"Ilse sent you. She wants the ledger.\"", DAY + 3],
    ["user", "\"She wants what's owed.\" I set the oars down.", DAY + 5],
    ["assistant", "\"The ledger is in the strongbox,\" Okoro says. \"And the strongbox wants two keys turned at once.\"", DAY + 8],
    ["user", "A week later, at the mill, I ask Ilse what the ledger holds.", 8 * DAY],
    ["assistant", "Ilse wipes flour from her hands. \"Every debt on this coast. Brann's is the longest page.\"", 8 * DAY + 2],
    ["user", "\"Then we open it tonight. Joss has agreed to stand watch.\"", 8 * DAY + 4],
    ["assistant", "She nods slowly. \"Bring the brass key. I'll bring Okoro, willing or not.\"", 8 * DAY + 6],
  ];
  for (const [role, text, minutes] of lines) host.sayAt(CHAT, role, text, START + (minutes >= DAY ? minutes : minutes * 60_000));
  host.addBook("book-coast", "The Coast", "Places along the shore.");
  host.addBook("book-people", "People");
  host.addEntry("book-coast", "11111111-aaaa-4000-8000-000000000001", "The Customs House", ["customs house", "strongbox"], "The customs house stands at the head of the harbour.\nIts strongbox takes two keys turned at once: the brass key and the keeper's.\nIlse's ledger has been locked in it since the flood.");
  host.addEntry("book-coast", "11111111-bbbb-4000-8000-000000000002", "The Lighthouse", ["lighthouse", "lamp"], "The lighthouse stands on the point, an hour's row from the harbour.\nOkoro keeps it, and keeps the second key on a cord around his neck.");
  host.addEntry("book-coast", "11111111-cccc-4000-8000-000000000003", "The Mill", ["mill", "millrace"], "The mill stands where the river meets the sea.\nIts wheel has not turned since the flood.", { enabled: false });
  host.addEntry("book-people", "22222222-aaaa-4000-8000-000000000004", "Okoro", ["okoro", "keeper"], "Okoro keeps the lighthouse and owes the mill a debt.\nHe was Brann's mate on the Heron before she sank.", { constant: true });
  host.addEntry("book-people", "22222222-bbbb-4000-8000-000000000005", "Brann", ["brann"], "Brann was master of the Heron. He says the brass key went down with her.\nHis debt is the longest page in Ilse's ledger.");
  host.addEntry("book-people", "22222222-cccc-4000-8000-000000000006", "Ilse", ["ilse", "miller"], "Ilse runs the mill and keeps the coast's ledger of debts.");
  return host;
}
