// An in-memory host for the core's tests: every port of `HarnessHost` kept in maps, a scripted model,
// and a chat that can be swiped, edited, regenerated and branched the way Lumiverse does it. Nothing
// here is the core's: it stands where the runtime and the extension stand.

import { textHash } from "../../../src/core/hash";
import type { ActivatedLore, AgentUsage, ApprovalsPort, BlobInfo, BookEntry, BookPort, ChatInfo, ChatMessage, ChatRole, ConnectionInfo, ConnectionProfile, HarnessHost, JobsPort, JobView, JsonObject, JsonValue, LogLevel, LoreBook, LoreEntry, ModelDelta, ModelRequest, ModelResult, ModelToolCall, PathMessage, PresetBlock, ReplySink, RequestMessage, StoredAnchor, ToolsPort, TraceDelta, TracePort, TraceRecord, TurnKind, TurnRequest, TurnResult } from "../../../src/core/ports";

// ---------------------------------------------------------------- the clock

interface Sleeper {
  at: number;
  wake: () => void;
}

/** A clock the tests move by hand: a sleep ends when `advance` reaches it, or at once while `auto` is on (it then moves the clock on by what it slept). */
export class TestClock {
  t = 1_000_000;
  auto = false;
  /** How long each sleep asked to wait. */
  readonly slept: number[] = [];
  private sleepers: Sleeper[] = [];

  now = (): number => this.t;

  sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    this.slept.push(ms);
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.auto) {
      this.t += ms;
      return Promise.resolve();
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const sleeper: Sleeper = { at: this.t + ms, wake: resolve };
    this.sleepers.push(sleeper);
    signal.addEventListener(
      "abort",
      () => {
        this.sleepers = this.sleepers.filter((s) => s !== sleeper);
        reject(signal.reason);
      },
      { once: true },
    );
    return promise;
  };

  /** Moves the clock on, waking every sleep that ends by then. */
  advance(ms: number): void {
    this.t += ms;
    const due = this.sleepers.filter((s) => s.at <= this.t);
    this.sleepers = this.sleepers.filter((s) => s.at > this.t);
    for (const s of due) s.wake();
  }
}

// ---------------------------------------------------------------- the scripted model

/** One scripted answer: its text alone, or its parts; `error` fails the call with those words; `hang` never answers until the call's signal ends it (`"after"`: once it has streamed its pieces, so part of the answer is out when it is stopped); `pace` moves the clock on that many milliseconds before each piece it streams after the first. */
export type Answer = string | { content?: string; toolCalls?: ModelToolCall[]; reasoning?: string; finishReason?: string; usage?: JsonObject; model?: string; error?: string; hang?: true | "after"; deltas?: string[]; pace?: number };

/** A script: the answers in the order the calls are made, or what answers each call. */
export type Script = Answer[] | ((request: ModelRequest, n: number) => Answer | Promise<Answer>);

export const call = (name: string, args: JsonObject = {}, callId = `call_${name}_${Math.random().toString(36).slice(2, 8)}`): ModelToolCall => ({ name, args, callId });

// ---------------------------------------------------------------- the chat

export interface StoredMessage {
  id: string;
  role: ChatRole;
  name: string;
  swipes: string[];
  swipeId: number;
  anchors: Record<number, JsonValue>;
  /** Hidden from the prompt by the user, as Lumiverse lets them hide a message. */
  hidden?: boolean;
}

/** A chat's LumiBooks book as a test gives it: its entries, and the message hashes it kept (none unless the test says: LumiBooks' own book for a chat keeps none). */
export interface StoredBook {
  entries: BookEntry[];
  kept: { index: number; hash: string }[];
}

/** LumiBooks' hash of a message (its `sha256-role-content-v1`): the SHA-256 of its role and its text as JSON, in hex. */
export function lumibooksHash(role: ChatRole, text: string): Promise<string> {
  return textHash(JSON.stringify([role, text]));
}

export const MAIN = "conn-main";
export const WRITER = "conn-writer";
export const LOOPBACK = "conn-loopback";

/** The in-memory host. */
export class MemoryHost implements HarnessHost {
  readonly clock = new TestClock();
  /** Every model call made, in order. */
  readonly calls: ModelRequest[] = [];
  script: Script = [];
  readonly profiles: ConnectionProfile[] = [
    { id: MAIN, name: "Main", provider: "openai", model: "model-main", parallelTools: true },
    { id: WRITER, name: "Writer", provider: "openai", model: "model-writer", parallelTools: true },
    { id: LOOPBACK, name: "LumiAH", provider: "custom", model: "lumiah", parallelTools: true },
  ];
  /** The user's default connection. */
  defaultConnection: string | null = MAIN;
  readonly blobStore = new Map<string, string>();
  readonly documents = new Map<string, JsonValue>();
  readonly chats = new Map<string, StoredMessage[]>();
  readonly books: LoreBook[] = [];
  readonly entries: LoreEntry[] = [];
  activatedLore: ActivatedLore[] = [];
  readonly presets = new Map<string, PresetBlock[]>();
  readonly traced: TraceRecord[] = [];
  /** Everything the trace port was handed, in the order it came: each numbered event, and each piece of a streaming answer for the live view. */
  readonly feed: ({ record: TraceRecord } | { delta: TraceDelta })[] = [];
  readonly logs: { level: LogLevel; message: string }[] = [];
  /** How many times the chat's text was read from the host. */
  messageReads = 0;
  /** When each blob was first stored, by the host's clock. */
  readonly blobTimes = new Map<string, number>();
  /** What the host knows of a chat besides its messages: its name, its character, the chat it was branched from. */
  readonly infos = new Map<string, Partial<ChatInfo>>();
  /** The tools that run in the extension, when a test mounts some; absent: the host has none. */
  tools?: ToolsPort;
  /** How the user answers a held tool call, when a test says; absent: the host has no way to ask. */
  approvals?: ApprovalsPort;
  /** Every job the host was told waits to run, and every change of a job it heard, in order. */
  readonly queued: JobView[] = [];
  readonly jobChanges: JobView[] = [];
  /** The host's side of jobs: it only notes what it is told, so a test decides when a job runs. Set undefined for a host that can't run jobs. */
  jobs?: JobsPort = { queued: (job) => void this.queued.push(structuredClone(job)), changed: (job) => void this.jobChanges.push(structuredClone(job)) };
  /** A chat's LumiBooks book, when a test gives it one; a chat without one has no book. */
  readonly storyBooks = new Map<string, StoredBook>();
  /** The host's side of a story's book (DESIGN §23): the chat's book as the test set it, each hash it kept beside the same hash of the message at that place now. Set undefined for a host without the port. */
  book?: BookPort = {
    read: async (chatId) => {
      const stored = this.storyBooks.get(chatId);
      if (!stored) return null;
      const messages = this.chats.get(chatId) ?? [];
      const hashes = await Promise.all(
        stored.kept.map(async ({ index, hash }) => {
          const m = messages[index];
          return { index, kept: hash, now: m ? await lumibooksHash(m.role, this.shown(m)) : null };
        }),
      );
      return { entries: structuredClone(stored.entries), hashes };
    },
  };
  /**
   * How this host keeps LumiAH's record on a message: as it is, or, when a test sets a codec (an
   * extension that keeps its own record per message, DESIGN §5), folded into that record. The core
   * sees LumiAH's record alone either way.
   */
  anchorCodec?: { read(stored: JsonValue): JsonValue | null; write(record: JsonValue, stored: JsonValue | null): JsonValue };
  /** How many blobs and anchors one page of a listing holds: small, so a test of a few holds several pages. */
  listPage = 3;
  private nextId = 1;

  readonly models = {
    call: async (request: ModelRequest, signal: AbortSignal, onDelta?: (delta: ModelDelta) => void): Promise<ModelResult> => {
      const n = this.calls.length;
      this.calls.push(structuredClone(request));
      signal.throwIfAborted();
      const scripted = typeof this.script === "function" ? await this.script(request, n) : this.script[n];
      if (scripted === undefined) throw new Error(`no answer scripted for call ${n + 1}`);
      const answer = typeof scripted === "string" ? { content: scripted } : scripted;
      const hangs = (): Promise<never> => {
        const { promise, reject } = Promise.withResolvers<never>();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        return promise;
      };
      if (answer.hang === true) return hangs();
      const content = answer.content ?? "";
      if (request.stream && onDelta) {
        const pieces: ModelDelta[] = [...(answer.reasoning ? [{ reasoning: answer.reasoning }] : []), ...(answer.deltas ?? (content === "" ? [] : (content.match(/\S+\s*/g) ?? [content]))).map((piece) => ({ content: piece }))];
        for (const [i, piece] of pieces.entries()) {
          if (i > 0 && answer.pace !== undefined) this.clock.advance(answer.pace);
          onDelta(piece);
        }
      }
      if (answer.hang === "after") return hangs();
      // A call that fails after it streamed part of its answer: the pieces above went out first.
      if (answer.error !== undefined) throw new Error(answer.error);
      return { content, finishReason: answer.finishReason ?? (answer.toolCalls?.length ? "tool_calls" : "stop"), model: answer.model ?? "scripted", ...(answer.toolCalls?.length ? { toolCalls: answer.toolCalls } : {}), ...(answer.reasoning !== undefined ? { reasoning: answer.reasoning } : {}), ...(answer.usage ? { usage: answer.usage } : {}) };
    },
  };

  readonly connections = {
    list: async (): Promise<ConnectionInfo[]> => this.profiles.map(({ parallelTools: _parallel, ...info }) => info),
    get: async (connectionId: string | null): Promise<ConnectionProfile | null> => this.profiles.find((p) => p.id === (connectionId ?? this.defaultConnection)) ?? null,
  };

  readonly blobs = {
    put: async (hash: string, text: string): Promise<void> => {
      if (!this.blobStore.has(hash)) this.blobTimes.set(hash, this.clock.now());
      this.blobStore.set(hash, text);
    },
    get: async (hash: string): Promise<string | null> => this.blobStore.get(hash) ?? null,
    list: async (cursor?: string): Promise<{ blobs: BlobInfo[]; next: string | null }> => {
      const all = [...this.blobStore.entries()];
      const from = Number(cursor ?? 0);
      const blobs = all.slice(from, from + this.listPage).map(([hash, text]) => ({ hash, bytes: new TextEncoder().encode(text).length, at: this.blobTimes.get(hash) ?? 0 }));
      return { blobs, next: from + this.listPage < all.length ? String(from + this.listPage) : null };
    },
    remove: async (hashes: readonly string[]): Promise<void> => {
      for (const hash of hashes) {
        this.blobStore.delete(hash);
        this.blobTimes.delete(hash);
      }
    },
  };

  readonly store = {
    read: async (path: string): Promise<JsonValue | null> => structuredClone(this.documents.get(path) ?? null),
    write: async (path: string, value: JsonValue): Promise<void> => void this.documents.set(path, structuredClone(value)),
    remove: async (path: string): Promise<void> => void this.documents.delete(path),
    list: async (prefix: string): Promise<string[]> => [...this.documents.keys()].filter((path) => path.startsWith(prefix)),
  };

  /** LumiAH's record as stored on one swipe of a message, read back as the core is given it. */
  private anchorOf(m: StoredMessage, swipeId: number): JsonValue | null {
    const stored = m.anchors[swipeId] ?? null;
    return stored === null || !this.anchorCodec ? stored : this.anchorCodec.read(stored);
  }

  /** Stores LumiAH's record on one swipe of a message, as the extension does when Lumiverse saves a reply. */
  anchorOn(m: StoredMessage, swipeId: number, record: JsonValue): void {
    m.anchors[swipeId] = this.anchorCodec ? this.anchorCodec.write(structuredClone(record), m.anchors[swipeId] ?? null) : structuredClone(record);
  }

  readonly chat = {
    path: async (chatId: string): Promise<PathMessage[]> => Promise.all((this.chats.get(chatId) ?? []).map(async (m, index) => ({ id: m.id, index, role: m.role, name: m.name, swipeId: m.swipeId, chars: this.shown(m).length, hash: await textHash(this.shown(m)), anchor: this.anchorOf(m, m.swipeId), ...(m.hidden ? { hidden: true } : {}) }))),
    messages: async (chatId: string, from: number, to: number): Promise<ChatMessage[]> => {
      this.messageReads++;
      return (this.chats.get(chatId) ?? []).flatMap((m, index) => (index >= from && index < to ? [{ id: m.id, index, role: m.role, name: m.name, swipeId: m.swipeId, content: this.shown(m) }] : []));
    },
    anchor: async (chatId: string, messageId: string, swipeId: number, record: JsonValue): Promise<boolean> => {
      const m = this.chats.get(chatId)?.find((x) => x.id === messageId);
      if (!m || m.swipes[swipeId] === undefined) return false;
      this.anchorOn(m, swipeId, record);
      return true;
    },
    info: async (chatId: string): Promise<ChatInfo | null> => {
      const known = this.infos.get(chatId);
      if (!known && !this.chats.has(chatId)) return null;
      return { id: chatId, name: known?.name ?? chatId, characterId: known?.characterId ?? null, characterName: known?.characterName ?? null, branchedFrom: known?.branchedFrom ?? null, ...(known?.story !== undefined ? { story: known.story } : {}), ...(known?.sovereignHand !== undefined ? { sovereignHand: known.sovereignHand } : {}) };
    },
    anchors: async (cursor?: string): Promise<{ anchors: StoredAnchor[]; next: string | null }> => {
      const all: StoredAnchor[] = [];
      for (const [chatId, messages] of this.chats) {
        for (const m of messages) {
          for (const swipe of Object.keys(m.anchors)) {
            const anchor = this.anchorOf(m, Number(swipe));
            if (anchor !== null) all.push({ chatId, messageId: m.id, swipeId: Number(swipe), anchor });
          }
        }
      }
      const from = Number(cursor ?? 0);
      return { anchors: all.slice(from, from + this.listPage), next: from + this.listPage < all.length ? String(from + this.listPage) : null };
    },
  };

  readonly lore = {
    books: async (): Promise<LoreBook[]> => [...this.books],
    entries: async (bookId: string): Promise<LoreEntry[]> => this.entries.filter((e) => e.bookId === bookId),
    activated: async (): Promise<ActivatedLore[]> => [...this.activatedLore],
  };

  readonly preset = {
    blocks: async (presetId: string): Promise<PresetBlock[]> => this.presets.get(presetId) ?? [],
  };

  readonly trace: TracePort = {
    event: (record: TraceRecord): void => {
      const kept = structuredClone(record);
      this.traced.push(kept);
      this.feed.push({ record: kept });
    },
    delta: (delta: TraceDelta): void => void this.feed.push({ delta: structuredClone(delta) }),
  };

  readonly log = (level: LogLevel, message: string): void => void this.logs.push({ level, message });

  private shown(m: StoredMessage): string {
    return m.swipes[m.swipeId] ?? "";
  }

  // ---------------------------------------------------------------- what Lumiverse and the user do to a chat

  private messagesOf(chatId: string): StoredMessage[] {
    let list = this.chats.get(chatId);
    if (!list) this.chats.set(chatId, (list = []));
    return list;
  }

  /** Adds a message to the end of a chat; its id. */
  say(chatId: string, role: ChatRole, text: string, name = role === "user" ? "Mara" : "Joss"): string {
    const id = `m${this.nextId++}`;
    this.messagesOf(chatId).push({ id, role, name, swipes: [text], swipeId: 0, anchors: {} });
    return id;
  }

  message(chatId: string, messageId: string): StoredMessage {
    const m = this.chats.get(chatId)?.find((x) => x.id === messageId);
    if (!m) throw new Error(`no message ${messageId} in ${chatId}`);
    return m;
  }

  /** The last message of a chat. */
  last(chatId: string): StoredMessage {
    const m = this.chats.get(chatId)?.at(-1);
    if (!m) throw new Error(`${chatId} is empty`);
    return m;
  }

  /** The user edits a message's text in place. */
  edit(chatId: string, messageId: string, text: string): void {
    const m = this.message(chatId, messageId);
    m.swipes[m.swipeId] = text;
  }

  /** The user deletes a message. */
  remove(chatId: string, messageId: string): void {
    this.chats.set(chatId, this.messagesOf(chatId).filter((m) => m.id !== messageId));
  }

  /** The user switches the swipe a message shows. */
  show(chatId: string, messageId: string, swipeId: number): void {
    this.message(chatId, messageId).swipeId = swipeId;
  }

  /** A branch: a new chat holding copies of the first `count` messages, their records with them, as Lumiverse copies a chat, and noted as branched from the first. */
  branch(chatId: string, count: number, into: string): void {
    this.chats.set(into, structuredClone(this.messagesOf(chatId).slice(0, count)).map((m) => ({ ...m, id: `m${this.nextId++}` })));
    this.infos.set(into, { ...this.infos.get(chatId), branchedFrom: chatId });
  }

  // ---------------------------------------------------------------- a turn, as the runtime drives one

  /**
   * The request Lumiverse would assemble for a reply in `chatId`: the preset's blocks as system
   * messages (those of `presetId`), then the chat's messages up to the reply, each tagged with where
   * it came from.
   */
  requestOf(chatId: string, upTo: number, presetId: string | null): RequestMessage[] {
    const blocks = (presetId === null ? [] : (this.presets.get(presetId) ?? [])).filter((b) => b.enabled && b.kind === "instruction");
    return [
      ...blocks.map((b): RequestMessage => ({ role: "system", content: b.content, source: { kind: "block", blockId: b.id } })),
      ...this.messagesOf(chatId)
        .slice(0, upTo)
        .map((m, index): RequestMessage => ({ role: m.role, content: this.shown(m), source: { kind: "history", messageId: m.id, index } })),
    ];
  }
}

/** What a sink was given. */
export class Sink implements ReplySink {
  readonly progressLines: string[] = [];
  thinking = "";
  text = "";
  ended: { finish: string; usage: AgentUsage } | null = null;
  failed: { message: string; code?: string } | null = null;
  /** Everything it was given, in order, by kind. */
  readonly order: string[] = [];

  progress(text: string): void {
    this.order.push("progress");
    this.progressLines.push(text);
  }
  reasoning(text: string): void {
    this.order.push("reasoning");
    this.thinking += text;
  }
  content(text: string): void {
    this.order.push("content");
    this.text += text;
  }
  done(finish: string, usage: AgentUsage): void {
    this.order.push("done");
    this.ended = { finish, usage };
  }
  error(message: string, code?: string): void {
    this.order.push("error");
    this.failed = code !== undefined ? { message, code } : { message };
  }
}

export interface Answered {
  result: TurnResult;
  sink: Sink;
  request: TurnRequest;
}

let generation = 1;

/**
 * One turn as the runtime and the extension drive it: the request assembled for the reply, `answer`
 * called, and, as Lumiverse saves the reply, the reply's message written with the turn's record on
 * its swipe. `kind`:
 * - `new`: the reply is a new message after the chat's last;
 * - `regenerate`: the chat's last message is the reply, and it gets one more swipe, which the chat
 *   then shows: Lumiverse keeps the reply it replaces as an earlier swipe;
 * - `swipe`: the chat's last message gets one more swipe, which the chat then shows;
 * - `continue`: the chat's last message is carried on.
 */
export async function runTurn(host: MemoryHost, harness: { answer(turn: TurnRequest, sink: ReplySink, signal: AbortSignal): Promise<TurnResult> }, chatId: string, options: { kind?: TurnKind; presetId?: string | null; signal?: AbortSignal; maxTokens?: number | null; params?: TurnRequest["params"]; save?: boolean } = {}): Promise<Answered> {
  const kind = options.kind ?? "new";
  const messages = host.chats.get(chatId) ?? [];
  const target = kind === "new" ? null : host.last(chatId);
  const upTo = kind === "new" || kind === "continue" ? messages.length : messages.length - 1;
  const swipeId = target === null ? 0 : kind === "swipe" || kind === "regenerate" ? target.swipes.length : target.swipeId;
  const request: TurnRequest = {
    userId: "user-1",
    chatId,
    generationId: `gen-${generation++}`,
    kind,
    target: { messageId: target?.id ?? null, swipeId },
    presetId: options.presetId ?? null,
    messages: host.requestOf(chatId, upTo, options.presetId ?? null),
    params: options.params ?? { temperature: 0.9 },
    maxTokens: options.maxTokens === undefined ? 700 : options.maxTokens,
  };
  const sink = new Sink();
  const result = await harness.answer(request, sink, options.signal ?? new AbortController().signal);
  if (options.save !== false && result.reply !== "") {
    const saved = target ?? host.message(chatId, host.say(chatId, "assistant", ""));
    if (kind === "continue") saved.swipes[swipeId] = `${saved.swipes[swipeId] ?? ""}${result.reply}`;
    else saved.swipes[swipeId] = result.reply;
    saved.swipeId = swipeId;
    if (result.record) host.anchorOn(saved, swipeId, result.record as unknown as JsonValue);
    else delete saved.anchors[swipeId];
  }
  return { result, sink, request };
}

/** The messages of a model call as text: each message's role and content, for a test to look in. */
export function promptText(request: ModelRequest | undefined): string {
  return (request?.messages ?? []).map((m) => `${m.role}: ${m.content}`).join("\n---\n");
}

/** Lets everything queued so far run: the promises a call under way is waiting on. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Waits until `holds` does: for work that passes through real asynchrony (a hash) before it gets where a test wants it. */
export async function until(holds: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !holds(); i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 1);
    await promise;
  }
  if (!holds()) throw new Error("what the test waited for never happened");
}

/** Lets real time pass, a few turns of the timer queue: long enough for work that is free to go to have gone, so a test can say what did not happen. */
export async function idle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 1);
    await promise;
  }
}
