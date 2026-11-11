// Reading what crossed the link. Each end checks the frames it receives before it acts on them: the
// extension a runtime's requests, the runtime the extension's answers and pushes. A frame that isn't
// the link's (`link` missing or another value) reads as null and is left for whoever it is for.

import type { ModelResult, ModelThinkingBlock, ModelToolCall, TraceDelta } from "../core/ports";
import type { JsonObject, JsonValue } from "./json";
import { hasOwn, isRecord } from "./json";
import type { ChunkPush, ExtensionMember, ExtensionOffer, LinkedBackend, LinkErrorCode, LinkErrorFrame, LinkNotice, LinkPush, LinkRequest, LinkRequestType, LinkResultFrame, RuntimeReport, SchedulerState, StreamChunk } from "./contract";
import { EXTENSION_MEMBERS, LINK, OWN_BACKEND } from "./contract";

const text = (v: unknown): v is string => typeof v === "string";
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Every request type the extension serves, for telling a request of this contract from a stray frame. */
const REQUEST_TYPES: Readonly<Record<LinkRequestType, true>> = {
  register: true,
  hello: true,
  ping: true,
  models: true,
  "turn.begin": true,
  "turn.commit": true,
  passthrough: true,
  "model.call": true,
  "stream.ack": true,
  "stream.resend": true,
  "stream.cancel": true,
  "settings.get": true,
  "trace.push": true,
  "setup.connection": true,
  "blob.get": true,
  "blob.put": true,
  "doc.get": true,
  "doc.put": true,
  "doc.remove": true,
  "chat.path": true,
  "chat.messages": true,
  "chat.anchor": true,
  "lore.books": true,
  "lore.entries": true,
  "lore.activated": true,
  "preset.blocks": true,
  "connections.list": true,
  "connections.get": true,
  "tools.list": true,
  "tool.call": true,
  "approval.ask": true,
  "extension.call": true,
  "blob.list": true,
  "blob.remove": true,
  "doc.list": true,
  "chat.info": true,
  "chat.anchors": true,
  "job.changed": true,
  "ask.answer": true,
  "recall.lore.read": true,
  "recall.lore.activated": true,
  "recall.chat.messages": true,
  "recall.embedder": true,
  "recall.embed": true,
  "recall.memory.enabled": true,
  "recall.memory.search": true,
  "recall.memory.entity": true,
  "recall.memory.entities": true,
  "recall.memory.arcs": true,
  "recall.databanks.list": true,
  "recall.databanks.documents": true,
  "recall.databanks.content": true,
  "recall.web.enabled": true,
  "recall.web.search": true,
  "book.read": true,
};

/** Whether a frame is the link's at all. */
export function isLinkFrame(raw: unknown): raw is Record<string, unknown> & { link: typeof LINK } {
  return isRecord(raw) && raw.link === LINK;
}

/**
 * A runtime's request as the extension reads it: a request of this contract (its fields still to be
 * checked by its handler); an `id` to answer `bad_request` to when it is the link's but no request;
 * null when it isn't the link's.
 */
export function requestOf(raw: unknown): { request: LinkRequest } | { malformed: string; id: string | null } | null {
  if (!isLinkFrame(raw)) return null;
  const id = text(raw.id) && raw.id !== "" ? raw.id : null;
  if (id === null) return { malformed: "A link request has no id.", id: null };
  if (!text(raw.type) || !hasOwn(REQUEST_TYPES, raw.type)) return { malformed: `There is no link request ${String(raw.type)}: update LumiAH in Lumiverse, or the runtime, so both are the same build.`, id };
  return { request: raw as unknown as LinkRequest };
}

function toolCallOf(raw: unknown): ModelToolCall | null {
  if (!isRecord(raw) || !text(raw.callId) || !text(raw.name) || !isRecord(raw.args) || (raw.thoughtSignature !== undefined && !text(raw.thoughtSignature))) return null;
  return { callId: raw.callId, name: raw.name, args: raw.args as JsonObject, ...(raw.thoughtSignature !== undefined ? { thoughtSignature: raw.thoughtSignature } : {}) };
}

function thinkingBlockOf(raw: unknown): ModelThinkingBlock | null {
  if (!isRecord(raw) || (raw.type !== "thinking" && raw.type !== "redacted_thinking")) return null;
  const block: ModelThinkingBlock = { type: raw.type };
  if (text(raw.thinking)) block.thinking = raw.thinking;
  if (text(raw.signature)) block.signature = raw.signature;
  if (text(raw.data)) block.data = raw.data;
  return block;
}

/** A model call's answer as it crossed, checked; null when it isn't one. */
export function modelResultOf(raw: unknown): ModelResult | null {
  if (!isRecord(raw) || !text(raw.content) || !text(raw.finishReason)) return null;
  const result: ModelResult = { content: raw.content, finishReason: raw.finishReason };
  if (raw.model !== undefined) {
    if (!text(raw.model)) return null;
    result.model = raw.model;
  }
  if (raw.reasoning !== undefined) {
    if (!text(raw.reasoning)) return null;
    result.reasoning = raw.reasoning;
  }
  if (raw.toolCalls !== undefined) {
    if (!Array.isArray(raw.toolCalls)) return null;
    const calls = raw.toolCalls.map(toolCallOf);
    if (calls.some((c) => c === null)) return null;
    result.toolCalls = calls as ModelToolCall[];
  }
  if (raw.thinkingBlocks !== undefined) {
    if (!Array.isArray(raw.thinkingBlocks)) return null;
    const blocks = raw.thinkingBlocks.map(thinkingBlockOf);
    if (blocks.some((b) => b === null)) return null;
    result.thinkingBlocks = blocks as ModelThinkingBlock[];
  }
  if (raw.reasoningDetails !== undefined) {
    if (!Array.isArray(raw.reasoningDetails) || !raw.reasoningDetails.every(isRecord)) return null;
    result.reasoningDetails = raw.reasoningDetails as JsonObject[];
  }
  if (raw.usage !== undefined) {
    if (!isRecord(raw.usage)) return null;
    result.usage = raw.usage as JsonObject;
  }
  return result;
}

/** A chunk as it crossed, checked; null when it isn't one. */
export function chunkOf(raw: unknown): StreamChunk | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "content":
    case "reasoning":
      return text(raw.text) ? { kind: raw.kind, text: raw.text } : null;
    case "done": {
      const result = modelResultOf(raw.result);
      return result === null ? null : { kind: "done", result };
    }
    case "value":
      return raw.value === undefined ? null : { kind: "value", value: raw.value as JsonValue };
    case "error":
      return text(raw.message) && text(raw.code) ? { kind: "error", message: raw.message, code: raw.code } : null;
    default:
      return null;
  }
}

/** A delta as it crossed, checked; null when it isn't one. */
function deltaOf(raw: unknown): TraceDelta | null {
  if (!isRecord(raw) || !text(raw.turn) || !text(raw.chatId) || !text(raw.agentId) || !count(raw.call) || raw.call < 1 || typeof raw.at !== "number") return null;
  if ((raw.text !== undefined && !text(raw.text)) || (raw.reasoning !== undefined && !text(raw.reasoning))) return null;
  return { turn: raw.turn, chatId: raw.chatId, agentId: raw.agentId, call: raw.call, ...(raw.text !== undefined ? { text: raw.text } : {}), ...(raw.reasoning !== undefined ? { reasoning: raw.reasoning } : {}), at: raw.at };
}

/** A notice as it crossed, checked: what of it reads as the contract's, in the order it came; null when it isn't a notice. */
export function noticeOf(raw: unknown): LinkNotice | null {
  if (!isLinkFrame(raw) || raw.type !== "trace.deltas" || !Array.isArray(raw.deltas)) return null;
  return { link: LINK, type: "trace.deltas", deltas: raw.deltas.flatMap((d) => deltaOf(d) ?? []) };
}

/** A push as it crossed, checked; null when it isn't one of the link's. */
export function pushOf(raw: unknown): LinkPush | null {
  if (!isLinkFrame(raw)) return null;
  switch (raw.type) {
    case "chunk": {
      const chunk = chunkOf(raw.chunk);
      if (chunk === null || !text(raw.stream) || !count(raw.seq) || raw.seq < 1) return null;
      return { link: LINK, type: "chunk", stream: raw.stream, seq: raw.seq, chunk } satisfies ChunkPush;
    }
    case "stop":
      return text(raw.turn) && text(raw.why) ? { link: LINK, type: "stop", turn: raw.turn, why: raw.why, ...(raw.by === "live" || raw.by === "lumiverse" ? { by: raw.by } : {}) } : null;
    case "settings":
      return count(raw.revision) ? { link: LINK, type: "settings", revision: raw.revision } : null;
    case "secret":
      return text(raw.relay) && text(raw.secret) && raw.secret !== "" ? { link: LINK, type: "secret", relay: raw.relay, secret: raw.secret } : null;
    case "connection":
      return text(raw.ref) && raw.ref !== "" && text(raw.key) && raw.key !== "" ? { link: LINK, type: "connection", ref: raw.ref, key: raw.key, ...(text(raw.name) && raw.name !== "" ? { name: raw.name } : {}) } : null;
    case "ask":
      return text(raw.ask) && raw.ask !== "" && text(raw.op) && raw.op !== "" && isRecord(raw.args) ? { link: LINK, type: "ask", ask: raw.ask, op: raw.op, args: raw.args as JsonObject } : null;
    default:
      return null;
  }
}

/** What a hello's answer says the extension supplies, checked: its name and the members this contract knows; null when it says none (LumiAH on its own, or a backend from before it could say). */
export function extensionOfferOf(raw: unknown): ExtensionOffer | null {
  if (!isRecord(raw) || !text(raw.name) || !Array.isArray(raw.members)) return null;
  const said = new Set<unknown>(raw.members);
  return { name: raw.name, members: EXTENSION_MEMBERS.filter((m): m is ExtensionMember => said.has(m)) };
}

/** Who a register's or a hello's answer says the runtime is linked to, checked; LumiAH's own where it says none (a backend from before it could say). */
export function linkedBackendOf(raw: unknown): LinkedBackend {
  return isRecord(raw) && text(raw.name) && raw.name !== "" && text(raw.connection) && raw.connection !== "" ? { name: raw.name, connection: raw.connection } : OWN_BACKEND;
}

const ERROR_CODES: Readonly<Record<LinkErrorCode, true>> = { bad_request: true, forbidden: true, not_found: true, conflict: true, unavailable: true, version: true, too_large: true, internal: true };

/** An answer to a request as it crossed: its result, or its error with a code this contract knows (`internal` otherwise); null when it isn't one. */
export function answerOf(raw: unknown): LinkResultFrame | LinkErrorFrame | null {
  if (!isLinkFrame(raw) || !text(raw.id)) return null;
  if (raw.type === "result") return { link: LINK, type: "result", id: raw.id, body: raw.body };
  if (raw.type === "error") {
    const code = text(raw.code) && hasOwn(ERROR_CODES, raw.code) ? (raw.code as LinkErrorCode) : "internal";
    return { link: LINK, type: "error", id: raw.id, code, message: text(raw.message) ? raw.message : "LumiAH refused the request." };
  }
  return null;
}

/** The longest name, build, host, address or date a runtime's report keeps: what it says is shown on the Runtime page and kept with its registration, so it is held short. Not a setting: nothing a runtime truthfully says of itself is longer. */
export const REPORT_TEXT_MAX = 255;
/** The longest path a report keeps (Linux's PATH_MAX). */
const REPORT_PATH_MAX = 4096;

const SCHEDULER: Readonly<Record<SchedulerState, true>> = { excluded: true, missing: true, unavailable: true, unknown: true };

/** What a runtime says of itself (hello, ping), as it may be kept and shown: every field its type has, each of its type and within its bound, nothing else; null for anything other. */
export function runtimeReportOf(raw: unknown): RuntimeReport | null {
  if (!isRecord(raw) || !isRecord(raw.runtime) || !isRecord(raw.session)) return null;
  const short = (v: unknown): v is string => text(v) && v.length <= REPORT_TEXT_MAX;
  const path = (v: unknown): v is string => text(v) && v.length <= REPORT_PATH_MAX;
  const { name, build, host, listen, port, scheduler, turns } = raw;
  const { bun, script, unit } = raw.runtime;
  const { valid, expiresAt, checkedAt } = raw.session;
  if (!short(name) || !short(build) || !short(host) || !short(listen) || !count(port) || port < 1 || port > 65535 || !text(scheduler) || !hasOwn(SCHEDULER, scheduler) || !count(turns)) return null;
  if (!(bun === null || path(bun)) || !path(script) || !(unit === null || short(unit))) return null;
  if (!(valid === null || typeof valid === "boolean") || !(expiresAt === null || short(expiresAt)) || !(checkedAt === null || typeof checkedAt === "number")) return null;
  return { name, build, runtime: { bun, script, unit }, host, listen, port, scheduler: scheduler as SchedulerState, session: { valid, expiresAt, checkedAt }, turns };
}
