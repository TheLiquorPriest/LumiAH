// The extension's end of the link (DESIGN §6): every frame a runtime sends is read here, put
// together when it came in parts, checked to be a request of the contract, authenticated by its
// relay secret, handed to what serves it, and answered by its id with exactly one result or one
// error. Frames that aren't the link's are left for the pages' messages (ui.ts).

import type { LinkErrorCode, LinkErrorFrame, LinkFrame, LinkRequestType, LinkRequests, LinkResultFrame, OpenStream } from "../../link/contract";
import { LINK, LINK_VERSION, MODEL_ID, STREAM_ID } from "../../link/contract";
import { isLinkFrame, noticeOf, requestOf } from "../../link/frames";
import { isRecord } from "../../link/json";
import { PartJoiner, needsParts, partOf, splitFrame } from "../../link/parts";
import { TRANSPORT_DEFAULTS } from "../../link/settings";
import type { Chats } from "./chat";
import type { Connections } from "./connections";
import { randomHex } from "./docs";
import { LinkRefused, wordsOf } from "./errors";
import type { LiveBuffer } from "./live";
import type { Models } from "./models";
import type { Lore, Presets, Storage } from "./reads";
import type { RegistryStore } from "./registry";
import type { Caller, Relays } from "./relays";
import type { SettingsStore } from "./settings";
import type { BackendHost } from "./spindle";
import type { StreamRegistry } from "./streams";
import type { Turns } from "./turns";

export interface ServerDeps {
  relays: Relays;
  registry: RegistryStore;
  settings: SettingsStore;
  streams: StreamRegistry;
  models: Models;
  turns: Turns;
  chats: Chats;
  storage: Storage;
  lore: Lore;
  presets: Presets;
  connections: Connections;
  live: LiveBuffer;
  /** What became of a `connection` push (`setup.connection`). */
  connectionMade(userId: string, ref: string, connection: { id: string; name: string } | null, problem: string | null): void;
  now(): number;
  /** Runs `fn` once after `ms`. */
  later(ms: number, fn: () => void): () => void;
  build: string;
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

const streamId = (v: unknown): string => {
  if (typeof v !== "string" || !STREAM_ID.test(v)) throw new LinkRefused("bad_request", "A stream is named by 32 hex characters: update the runtime and LumiAH to the same build.");
  return v;
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

function openOf(v: unknown): OpenStream[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((o): OpenStream[] => (isRecord(o) && typeof o.stream === "string" && typeof o.seq === "number" && Number.isSafeInteger(o.seq) && o.seq >= 0 ? [{ stream: o.stream, seq: o.seq }] : []));
}

export class LinkServer {
  /** The parts of the frames each session is sending, by session. */
  private readonly joiners = new Map<string, PartJoiner>();
  /** The joining limits each user's settings give, as last read: a joiner asks without waiting. */
  private readonly limits = new Map<string, { maxUnits: number; staleMs: number }>();

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

  private answer(id: string, userId: string, session: string | undefined, body: unknown): void {
    const frame: LinkResultFrame = { link: LINK, type: "result", id, body };
    if (session === undefined) this.host.frontend.send(frame, userId);
    else this.send(frame, userId, session, id);
  }

  private refuse(id: string, userId: string, session: string | undefined, code: LinkErrorCode, message: string): void {
    const frame: LinkErrorFrame = { link: LINK, type: "error", id, code, message };
    this.host.frontend.send(frame, userId, session);
  }

  /** A session went away: the frames it was sending in parts are let go. */
  sessionClosed(session: string): void {
    this.joiners.get(session)?.clear();
    this.joiners.delete(session);
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
      const key = session ?? `user:${userId}`;
      let joiner = this.joiners.get(key);
      if (joiner === undefined) {
        joiner = new PartJoiner(() => this.limits.get(userId) ?? { maxUnits: TRANSPORT_DEFAULTS.link.joinMaxUnits, staleMs: TRANSPORT_DEFAULTS.link.partStaleMs });
        this.joiners.set(key, joiner);
      }
      if (!this.limits.has(userId)) {
        const { link } = await this.deps.settings.transport(userId);
        this.limits.set(userId, { maxUnits: link.joinMaxUnits, staleMs: link.partStaleMs });
      }
      const joined = joiner.take(part, this.deps.now());
      if ("waiting" in joined) return true;
      if ("refused" in joined) {
        this.refuse(joined.id, userId, session, "too_large", joined.refused);
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
    try {
      // A runtime's pushes and answers go to its own socket: without the session a frame came from, there is nowhere to send them.
      if (session === undefined) throw new LinkRefused("unavailable", "This Lumiverse doesn't say which connection a runtime's requests come from, so LumiAH can't answer them: update Lumiverse.");
      this.answer(request.id, userId, session, await this.serve(request.type, request, userId, session));
    } catch (error) {
      if (error instanceof LinkRefused) this.refuse(request.id, userId, session, error.code, error.message);
      else {
        this.host.log("error", `[LumiAH] ${request.type} failed: ${wordsOf(error)}`);
        this.refuse(request.id, userId, session, "internal", `LumiAH couldn't do that (${wordsOf(error)}).`);
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
    switch (type) {
      case "hello": {
        await d.relays.hello(caller, r);
        return { relay, version: LINK_VERSION, build: d.build, lost: d.streams.resume(userId, relay, openOf(r.open)), settings: await d.settings.revision(userId) };
      }
      case "ping": {
        await d.relays.ping(caller, r);
        return { lost: d.streams.missing(userId, relay, strings(r.streams)) };
      }
      case "models": {
        if (typeof r.key !== "string" || !(await d.registry.keyIs(userId, r.key))) throw new LinkRefused("forbidden", "The key in the loopback connection isn't this account's loopback key. Mint a new one on LumiAH's Runtime page: your linked runtime puts it in the connection.");
        return { models: [{ id: MODEL_ID }] };
      }
      case "turn.begin":
        return d.turns.begin(userId, relay, r.key, r.tag, r.request);
      case "turn.commit":
        return { anchoring: await d.turns.commit(userId, r.turn, r.chat, r.target, r.record) };
      case "passthrough":
        return d.models.pass(caller, r);
      case "model.call":
        return d.models.call(caller, r);
      case "stream.ack":
        return { done: d.streams.ack(userId, relay, streamId(r.stream), whole(r.seq, "chunk number")) };
      case "stream.resend":
        return { last: d.streams.resend(userId, relay, streamId(r.stream), whole(r.from, "chunk number")) };
      case "stream.cancel":
        return { cancelled: d.streams.cancel(userId, relay, streamId(r.stream), typeof r.reason === "string" ? r.reason : "") };
      case "settings.get":
        return d.settings.snapshot(userId);
      case "trace.push":
        return { taken: await d.live.push(userId, Array.isArray(r.records) ? r.records : []) };
      case "setup.connection": {
        const made = isRecord(r.connection) && typeof r.connection.id === "string" && typeof r.connection.name === "string" ? { id: r.connection.id, name: r.connection.name } : null;
        d.connectionMade(userId, text(r.ref, "connection request"), made, typeof r.problem === "string" ? r.problem : null);
        return { taken: true };
      }
      case "blob.get":
        return { text: await d.storage.blob(userId, r.hash) };
      case "blob.put":
        await d.storage.putBlob(userId, r.hash, r.text);
        return { stored: true };
      case "doc.get":
        return { doc: await d.storage.doc(userId, r.path) };
      case "doc.put":
        await d.storage.putDoc(userId, r.path, r.doc);
        return { written: true };
      case "doc.remove":
        await d.storage.removeDoc(userId, r.path);
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
      case "connections.list":
        return { connections: await d.connections.list(userId) };
      case "connections.get":
        return { profile: await d.connections.profile(userId, typeof r.connection === "string" && r.connection !== "" ? r.connection : null) };
      default:
        throw new LinkRefused("bad_request", `There is no link request ${String(type)}.`);
    }
  }
}
