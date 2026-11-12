// The extension's end of the link (DESIGN §6): every frame a runtime sends is read here, put
// together when it came in parts, checked to be a request of the contract, authenticated by its
// relay secret, handed to what serves it, and answered by its id with exactly one result or one
// error. Frames that aren't the link's are left for the pages' messages (ui.ts).

import type { ApprovalAsk, JobView, JsonObject, JsonValue, RemoteToolCall } from "../../core/ports";
import type { LinkErrorCode, LinkErrorFrame, LinkFrame, LinkRequestType, LinkRequests, LinkResultFrame, OpenStream } from "../../link/contract";
import { LINK, LINK_VERSION, STREAM_ID, loopbackModel } from "../../link/contract";
import { isLinkFrame, noticeOf, requestOf } from "../../link/frames";
import { isRecord } from "../../link/json";
import { type Joined, PartJoiner, needsParts, partOf, splitFrame } from "../../link/parts";
import { CEILINGS, TRANSPORT_DEFAULTS, type TransportSettings } from "../../link/settings";
import { type Approvals, holdCall } from "./approvals";
import type { Asks } from "./asks";
import type { ProxyRoad } from "./proxy";
import type { Chats } from "./chat";
import type { CopyFeed } from "./copy";
import type { Connections } from "./connections";
import { randomHex } from "./docs";
import { LinkRefused, wordsOf, wrongKey } from "./errors";
import { type BackendExtension, callExtension, offerOf, type RemoteTools } from "./extension";
import { type BackendIdentity, linkedBackend } from "./identity";
import type { JobsBoard } from "./jobs";
import type { LiveBuffer } from "./live";
import type { Mirrors } from "./mirror";
import type { Lore, Presets, Storage } from "./reads";
import type { Recall } from "./recall";
import type { RegistryStore } from "./registry";
import type { Caller, Relays } from "./relays";
import type { SettingsStore } from "./settings";
import type { BackendHost } from "./spindle";
import type { StreamRegistry } from "./streams";
import type { ChatSwitch } from "./switch";
import type { Turns } from "./turns";

export interface ServerDeps {
  relays: Relays;
  registry: RegistryStore;
  settings: SettingsStore;
  streams: StreamRegistry;
  turns: Turns;
  chats: Chats;
  /** A chat as the core reads it, with what decides its story (§24.4), and what a claim on it is asked with. */
  chatSwitch: Pick<ChatSwitch, "info" | "claimAsk">;
  /** The built-in agents this backend leaves out (`BackendOptions.withoutAgents`): handed to a runtime's core with the user's definitions. */
  without: readonly string[];
  storage: Storage;
  /** Which runtime holds the user's mirror: told of each hello, and each write to the storage goes through it (mirror.ts). */
  mirror: Mirrors;
  lore: Lore;
  presets: Presets;
  /** What the lore and history tools read of Lumiverse, and a chat's book (DESIGN §23, §24). */
  recall: Recall;
  /** What the runtime's copy of chat and lore is told and asks (copy.ts). */
  copy: CopyFeed;
  connections: Connections;
  live: LiveBuffer;
  tools: RemoteTools;
  approvals: Approvals;
  asks: Asks;
  /** The asks' road through Lumiverse's proxy: each request's secret, as its runtime shows it, is what that road's asks carry (kept in memory only). */
  road: Pick<ProxyRoad, "heard">;
  jobs: JobsBoard;
  /** What the extension LumiAH is built into supplies to the core; absent for LumiAH on its own. */
  extension: BackendExtension | undefined;
  /** What became of a `connection` push (`setup.connection`). */
  connectionMade(userId: string, ref: string, connection: { id: string; name: string } | null, problem: string | null): void;
  now(): number;
  /** Runs `fn` once after `ms`. */
  later(ms: number, fn: () => void): () => void;
  build: string;
  /** Who this backend is: what a runtime is told of it on hello, and the name its refusals send the user to. */
  identity: BackendIdentity;
}

type Fields = Record<string, unknown>;
type Results = { [K in LinkRequestType]: LinkRequests[K]["result"] };

const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v === "") throw new LinkRefused("bad_request", `The request names no ${what}: update the runtime and LumiAH to the same build.`);
  return v;
};

const whole = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new LinkRefused("bad_request", `The request's ${what} isn't a whole number: update the runtime and LumiAH to the same build.`);
  return v;
};

const short = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Which instance of its definition an agent is, where a call says (`as`): absent, or a string. */
const asOf = (v: unknown): v is string | undefined => v === undefined || typeof v === "string";

/** A call of a tool that runs here, as the core named it. */
function toolCallOf(raw: unknown): RemoteToolCall {
  if (!isRecord(raw) || !short(raw.name) || !isRecord(raw.args) || !short(raw.turn) || typeof raw.chatId !== "string" || !short(raw.agentId) || typeof raw.role !== "string" || !short(raw.callId) || !short(raw.kind) || typeof raw.main !== "boolean" || !asOf(raw.as) || !Array.isArray(raw.above) || !raw.above.every((over) => isRecord(over) && short(over.agentId) && typeof over.role === "string" && asOf(over.as))) {
    throw new LinkRefused("bad_request", "The tool call is malformed: update the runtime and LumiAH to the same build.");
  }
  const above = (raw.above as { agentId: string; role: string; as?: string }[]).map(({ agentId, role, as }) => ({ agentId, role, ...(as !== undefined ? { as } : {}) }));
  return { name: raw.name, args: raw.args as JsonObject, turn: raw.turn, chatId: raw.chatId, agentId: raw.agentId, role: raw.role, callId: raw.callId, kind: raw.kind as RemoteToolCall["kind"], main: raw.main, above, ...(raw.as !== undefined ? { as: raw.as } : {}) };
}

/** A tool call held for the user's word, as the core asks it. */
function approvalAskOf(raw: unknown): ApprovalAsk {
  if (!isRecord(raw) || !short(raw.turn) || typeof raw.chatId !== "string" || !short(raw.agentId) || typeof raw.role !== "string" || !short(raw.callId) || !short(raw.tool) || !(raw.tier === "read" || raw.tier === "write" || raw.tier === "external") || !isRecord(raw.args) || typeof raw.at !== "number" || !(raw.until === null || typeof raw.until === "number")) {
    throw new LinkRefused("bad_request", "The held call is malformed: update the runtime and LumiAH to the same build.");
  }
  return { turn: raw.turn, chatId: raw.chatId, agentId: raw.agentId, role: raw.role, callId: raw.callId, tool: raw.tool, tier: raw.tier, args: raw.args as JsonObject, at: raw.at, until: raw.until };
}

/** A job as the core says it: the fields the pages and the notices read are checked, the rest is the core's. */
function jobOf(raw: unknown): JobView {
  if (!isRecord(raw) || !short(raw.id) || !short(raw.chatId) || typeof raw.agent !== "string" || typeof raw.task !== "string" || typeof raw.state !== "string" || typeof raw.createdAt !== "number") {
    throw new LinkRefused("bad_request", "The job is malformed: update the runtime and LumiAH to the same build.");
  }
  return raw as unknown as JobView;
}

const streamId = (v: unknown): string => {
  if (typeof v !== "string" || !STREAM_ID.test(v)) throw new LinkRefused("bad_request", "A stream is named by 32 hex characters: update the runtime and LumiAH to the same build.");
  return v;
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

function openOf(v: unknown): OpenStream[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((o): OpenStream[] => (isRecord(o) && typeof o.stream === "string" && typeof o.seq === "number" && Number.isSafeInteger(o.seq) && o.seq >= 0 ? [{ stream: o.stream, seq: o.seq }] : []));
}

/** What to do about a frame the joiner refused, by the limit it passed: each is a setting of the link's, but the bound all accounts share, which is nobody's to raise. */
function joinAdvice(over: Extract<Joined, { refused: string }>["over"], name: string): string {
  const setting = (title: string): string => `"${title}" (${name} → Settings → Transport → Link)`;
  if (over === "shared") return "Send this one again in a moment.";
  if (over === "frame") return `Raise ${setting("Largest frame joined")} to send one that large.`;
  return `Those frames are this account's own: send this one again once they are done, or raise ${setting(over === "frames" ? "Frames joined at once" : "Characters held while joining")}.`;
}

export class LinkServer {
  /**
   * The frames each account's sessions are sending in parts, by account. One joiner takes them all,
   * each session's apart, so what an account may have under way is counted over its sessions
   * together: parts are joined before any secret is checked, a session's id is the client's to
   * choose and Lumiverse lets an account open any number of sockets, so a limit that held for each
   * session alone would bound nothing. An account with nothing under way has no joiner.
   */
  private readonly joiners = new Map<string, PartJoiner>();
  /** The link's settings of each user, as last read: a joiner asks for its limits without waiting. */
  private readonly limits = new Map<string, TransportSettings["link"]>();

  constructor(
    private readonly host: Pick<BackendHost, "frontend" | "log">,
    private readonly deps: ServerDeps,
  ) {}

  /**
   * Sends a frame to a session: whole, or in parts under `id` when it is too large to cross whole.
   * The parts go one per turn of the event loop, so Lumiverse's socket to the runtime empties
   * between them and is never closed for holding too much.
   */
  send(frame: LinkFrame, userId: string, session: string, id: string = randomHex(64)): void {
    const whole = JSON.stringify(frame);
    if (!needsParts(whole)) {
      this.host.frontend.send(frame, userId, session);
      return;
    }
    const parts = splitFrame(whole, id);
    const next = (at: number): void => {
      const part = parts[at];
      if (part === undefined) return;
      this.host.frontend.send(part, userId, session);
      this.deps.later(0, () => next(at + 1));
    };
    next(0);
  }

  /** Answers a request; `took`: how long it was worked on here, in ms, which the runtime's timing log keeps. */
  private answer(id: string, userId: string, session: string | undefined, body: unknown, took?: number): void {
    const frame: LinkResultFrame = { link: LINK, type: "result", id, body, ...(took !== undefined ? { took } : {}) };
    if (session === undefined) this.host.frontend.send(frame, userId);
    else this.send(frame, userId, session, id);
  }

  private refuse(id: string, userId: string, session: string | undefined, code: LinkErrorCode, message: string, took?: number): void {
    const frame: LinkErrorFrame = { link: LINK, type: "error", id, code, message, ...(took !== undefined ? { took } : {}) };
    this.host.frontend.send(frame, userId, session);
  }

  /** A session went away: the frames it was sending in parts are let go. Whose it was isn't said, so every account that has frames under way is asked. */
  sessionClosed(session: string): void {
    for (const [userId, joiner] of this.joiners) {
      joiner.clear(session);
      if (joiner.waiting === 0) this.joiners.delete(userId);
    }
  }

  /**
   * Every so often: the frames whose parts stopped coming are let go, for every account. A joiner
   * looks only when a part arrives, so a session that sends nothing more would keep its half-sent
   * frames until it closed.
   */
  sweep(): void {
    const now = this.deps.now();
    for (const [userId, joiner] of this.joiners) {
      joiner.purge(now);
      if (joiner.waiting === 0) this.joiners.delete(userId);
    }
  }

  /** What an account's sessions are sending in parts now: how many frames, and how many characters of them are held. */
  joining(userId: string): { frames: number; units: number } {
    const joiner = this.joiners.get(userId);
    return { frames: joiner?.waiting ?? 0, units: joiner?.held ?? 0 };
  }

  /**
   * One message from a session. True when it was the link's (and so not a page's): a request,
   * answered; or a part of one.
   */
  async frame(payload: unknown, userId: string, session: string | undefined): Promise<boolean> {
    if (!isLinkFrame(payload)) return false;
    let raw: unknown = payload;
    const part = partOf(payload);
    if (part !== null) {
      if (!this.limits.has(userId)) this.limits.set(userId, (await this.deps.settings.transport(userId)).link);
      // Nothing waits from here to `take`, so the joiner found or made is the one the account has when the part goes in.
      let joiner = this.joiners.get(userId);
      if (joiner === undefined) {
        joiner = new PartJoiner(() => {
          const link = this.limits.get(userId) ?? TRANSPORT_DEFAULTS.link;
          // The account's settings bound it as far as the ceilings, whatever they say; and what every other account has under way bounds it too, so all of them together stay within the worker's own totals.
          const shared = { frames: CEILINGS.joinFramesTotal, units: CEILINGS.joinHeldUnitsTotal };
          for (const [other, theirs] of this.joiners) {
            if (other === userId) continue;
            shared.frames -= theirs.waiting;
            shared.units -= theirs.held;
          }
          return { maxUnits: Math.min(link.joinMaxUnits, CEILINGS.joinMaxUnits), staleMs: Math.min(link.partStaleMs, CEILINGS.partStaleMs), maxFrames: Math.min(link.joinFrames, CEILINGS.joinFrames), maxHeldUnits: Math.min(link.joinHeldUnits, CEILINGS.joinHeldUnits), shared };
        });
        this.joiners.set(userId, joiner);
      }
      const joined = joiner.take(part, this.deps.now(), session ?? "");
      if (joiner.waiting === 0) this.joiners.delete(userId);
      if ("waiting" in joined) return true;
      if ("refused" in joined) {
        // Only a frame larger than the largest joined is too large, however often it is sent. Past what the account's other frames under way, or every account's, leave room for, the extension has no room just now: that passes once they are done, and the sender may send it again.
        this.refuse(joined.id, userId, session, joined.over === "frame" ? "too_large" : "unavailable", `${joined.refused} ${joinAdvice(joined.over, this.deps.identity.name)}`);
        return true;
      }
      try {
        raw = JSON.parse(joined.text);
      } catch {
        this.refuse(part.id, userId, session, "bad_request", "A frame sent in parts didn't read as JSON once put together.");
        return true;
      }
    }
    const notice = noticeOf(raw);
    if (notice !== null) {
      // Never answered. One from a session no hello bound to a runtime of this user is dropped: it carries no secret of its own.
      const relay = session === undefined ? null : this.deps.relays.relayOf(userId, session);
      if (relay !== null) this.deps.live.deltas(userId, relay, notice.deltas);
      return true;
    }
    const read = requestOf(raw);
    if (read === null) return isLinkFrame(raw);
    if ("malformed" in read) {
      if (read.id !== null) this.refuse(read.id, userId, session, "bad_request", read.malformed);
      return true;
    }
    const request = read.request as unknown as Fields & { id: string; type: LinkRequestType };
    const at = this.deps.now();
    try {
      // A runtime's pushes and answers go to its own socket: without the session a frame came from, there is nowhere to send them.
      if (session === undefined) throw new LinkRefused("unavailable", "This Lumiverse doesn't say which connection a runtime's requests come from, so LumiAH can't answer them: update Lumiverse.");
      const body = await this.serve(request.type, request, userId, session);
      this.answer(request.id, userId, session, body, this.deps.now() - at);
    } catch (error) {
      if (error instanceof LinkRefused) this.refuse(request.id, userId, session, error.code, error.message, this.deps.now() - at);
      else {
        this.host.log("error", `[LumiAH] ${request.type} failed: ${wordsOf(error)}`);
        this.refuse(request.id, userId, session, "internal", `LumiAH couldn't do that (${wordsOf(error)}).`, this.deps.now() - at);
      }
    }
    return true;
  }

  /** A user's settings changed: the limits their frames are joined within are read again. */
  settingsChanged(userId: string): void {
    this.limits.delete(userId);
  }

  private async serve<K extends LinkRequestType>(type: K, r: Fields, userId: string, session: string): Promise<Results[K]>;
  private async serve(type: LinkRequestType, r: Fields, userId: string, session: string): Promise<Results[LinkRequestType]> {
    const d = this.deps;
    if (type === "register") return d.relays.register(r, userId);
    const caller: Caller = await d.relays.authenticate(r.secret, userId, session);
    const relay = caller.relay.id;
    // The secret checked out: it is what this runtime's asks carry on the road through Lumiverse's proxy.
    d.road.heard(userId, relay, session, r.secret as string);
    switch (type) {
      case "hello": {
        await d.relays.hello(caller, r);
        return { relay, version: LINK_VERSION, build: d.build, lost: d.streams.resume(userId, relay, openOf(r.open)), settings: await d.settings.revision(userId), extension: offerOf(d.extension), backend: linkedBackend(d.identity), copy: await d.copy.offer(userId, relay), mirror: await d.mirror.hello(caller, r.mirror, r.report) };
      }
      case "ping": {
        await d.relays.ping(caller, r);
        void d.copy.pinged(userId, relay);
        return { lost: d.streams.missing(userId, relay, strings(r.streams)), told: d.copy.toldTo(userId, relay) };
      }
      case "models": {
        if (typeof r.key !== "string" || !(await d.registry.keyIs(userId, r.key))) throw wrongKey(d.identity.name);
        return { models: [{ id: loopbackModel(d.identity.identifier) }] };
      }
      case "turn.begin":
        return d.turns.begin(userId, relay, r.key, r.tag, r.request);
      case "turn.commit":
        return { anchoring: await d.turns.commit(userId, r.turn, r.chat, r.target, r.record) };
      case "stream.ack":
        return { done: d.streams.ack(userId, relay, streamId(r.stream), whole(r.seq, "chunk number")) };
      case "stream.cancel":
        return { cancelled: d.streams.cancel(userId, relay, streamId(r.stream), typeof r.reason === "string" ? r.reason : "") };
      case "settings.get": {
        const snapshot = await d.settings.snapshot(userId);
        // The built-in agents this backend leaves out reach the runtime's core with the user's definitions, which it reads at each run's start.
        const kept = snapshot.definitions;
        return d.without.length > 0 ? { ...snapshot, definitions: { ...(typeof kept === "object" && kept !== null && !Array.isArray(kept) ? kept : {}), without: [...d.without] } } : snapshot;
      }
      case "trace.push":
        return { taken: await d.live.push(userId, relay, Array.isArray(r.records) ? r.records : []) };
      case "setup.connection": {
        const made = isRecord(r.connection) && typeof r.connection.id === "string" && typeof r.connection.name === "string" ? { id: r.connection.id, name: r.connection.name } : null;
        d.connectionMade(userId, text(r.ref, "connection request"), made, typeof r.problem === "string" ? r.problem : null);
        return { taken: true };
      }
      case "blob.get":
        return { text: await d.storage.blob(userId, r.hash) };
      case "blob.put":
        await d.mirror.write(caller, r.mirror, { docs: [], blobs: [] }, () => d.storage.putBlob(userId, r.hash, r.text));
        return { stored: true };
      case "doc.get":
        return { doc: await d.storage.doc(userId, r.path) };
      case "doc.put":
        await d.mirror.write(caller, r.mirror, { docs: typeof r.path === "string" ? [r.path] : [], blobs: [] }, () => d.storage.putDoc(userId, r.path, r.doc));
        return { written: true };
      case "doc.remove":
        await d.mirror.write(caller, r.mirror, { docs: typeof r.path === "string" ? [r.path] : [], blobs: [] }, () => d.storage.removeDoc(userId, r.path));
        return { removed: true };
      case "chat.path":
        return { messages: await d.chats.path(userId, text(r.chat, "chat")) };
      case "chat.messages":
        return { messages: await d.chats.messages(userId, text(r.chat, "chat"), whole(r.from, "range"), whole(r.to, "range")) };
      case "chat.anchor": {
        if (r.record === undefined || r.record === null) throw new LinkRefused("bad_request", "The request has no record.");
        return { written: await d.chats.anchor(userId, text(r.chat, "chat"), text(r.message, "message"), whole(r.swipe, "swipe"), r.record as never) };
      }
      case "lore.books":
        return { books: await d.lore.books(userId, await d.chats.own(userId, text(r.chat, "chat"))) };
      case "lore.entries":
        return { entries: await d.lore.entries(userId, r.book) };
      case "lore.activated":
        return { entries: await d.turns.activated(userId, text(r.chat, "chat"), text(r.generation, "generation")) };
      case "preset.blocks": {
        const chat = typeof r.chat === "string" && r.chat !== "" ? (await d.chats.own(userId, r.chat)).id : null;
        return { blocks: await d.presets.blocks(userId, r.preset, chat) };
      }
      // A runtime's frame names whatever chat it likes, and any account can register a runtime: a chat is the caller's own before a tool or the extension LumiAH is built into hears of it (`""`: no chat).
      case "tools.list":
        return { tools: await d.tools.list(userId, typeof r.chat === "string" && r.chat !== "" ? (await d.chats.own(userId, r.chat)).id : "") };
      case "tool.call": {
        const stream = streamId(r.stream);
        const call = toolCallOf(r.call);
        if (call.chatId !== "") await d.chats.own(userId, call.chatId);
        // Asked again for a stream already open (after a reconnect), the call under way is the answer.
        const writer = d.streams.open(userId, relay, stream, call.turn, (await d.settings.transport(userId)).streams);
        if (writer !== null) {
          void d.tools.call(userId, call, writer.signal).then(
            (out) => writer.value(out.error === true ? { text: out.text, error: true } : { text: out.text }),
            (error: unknown) => writer.error(wordsOf(error), writer.signal.aborted ? "cancelled" : "tool_failed"),
          );
        }
        return { accepted: true };
      }
      case "approval.ask": {
        const stream = streamId(r.stream);
        const ask = approvalAskOf(r.ask);
        if (ask.chatId !== "") await d.chats.own(userId, ask.chatId);
        const writer = d.streams.open(userId, relay, stream, ask.turn, (await d.settings.transport(userId)).streams);
        if (writer !== null) {
          void holdCall(d, userId, ask, writer.signal).then(
            // The user's word crosses as it was given: the runtime's core reads it, and fails closed on anything that is no approval.
            (answer) => writer.value(answer as unknown as JsonValue),
            (error: unknown) => writer.error(wordsOf(error), "cancelled"),
          );
        }
        return { accepted: true };
      }
      case "extension.call":
        return callExtension(d.extension, r.member, r.arg, userId, { own: (owner, chatId) => d.chats.own(owner, chatId), claimAsk: (owner, chatId) => d.chatSwitch.claimAsk(owner, chatId) });
      case "blob.list":
        return d.storage.blobs(userId, r.cursor);
      case "blob.remove":
        await d.mirror.write(caller, r.mirror, { docs: [], blobs: strings(r.hashes) }, () => d.storage.removeBlobs(userId, r.hashes));
        return { removed: true };
      case "mirror.release":
        return { released: await d.mirror.release(caller, r.mirror) };
      case "doc.list":
        return { paths: await d.storage.docs(userId, r.prefix) };
      case "chat.info":
        return { chat: await d.chatSwitch.info(userId, text(r.chat, "chat")) };
      case "chat.anchors":
        return d.chats.anchors(userId, typeof r.cursor === "string" && r.cursor !== "" ? r.cursor : null);
      case "job.changed":
        await d.jobs.took(userId, jobOf(r.job), relay);
        return { taken: true };
      case "ask.answer":
        d.asks.answered(userId, relay, r.ask, r.value, r.refusal, r.took);
        return { taken: true };
      // The recall ports' reads and the book's, each checked and served where the ports are (recall.ts).
      case "recall.lore.read":
      case "recall.lore.activated":
      case "recall.chat.messages":
      case "recall.embedder":
      case "recall.embed":
      case "recall.memory.enabled":
      case "recall.memory.search":
      case "recall.memory.entity":
      case "recall.memory.entities":
      case "recall.memory.arcs":
      case "recall.databanks.list":
      case "recall.databanks.documents":
      case "recall.databanks.content":
      case "recall.web.enabled":
      case "recall.web.search":
      case "book.read":
        return d.recall.serve(userId, type, r);
      case "host.read":
        return d.copy.read(userId, r.port, r.method, r.args);
      case "own.read":
        return d.copy.own(userId, r.chat);
      case "turn.lore":
        return d.copy.turnLore(userId, r.chat, r.character);
      default:
        throw new LinkRefused("bad_request", `There is no link request ${String(type)}.`);
    }
  }
}
