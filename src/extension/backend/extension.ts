// What an extension that builds LumiAH into its backend supplies (DESIGN §21), as this backend
// serves it to the core: where the core runs here (§25) it is handed the members themselves; where
// it runs in a runtime it asks for each over the link (`extension.call`). Its tools reach the core
// through the tools port (`tools.list`, `tool.call`), beside the tools of the user's MCP servers
// (§16). Everything of the extension's runs here, in its own backend.
//
// The members are the core's (`HarnessExtension`, `ToolsPort`), each with the user it is asked for
// added last: a backend serves every user, where the core's host serves one. So what a test or a
// one-user host wrote against the core's shapes fits as it is.

import type { ChatClaim, ClaimAsk, ExtensionDefinitions, HarnessExtension, ReplyWritten, RunBegan, RunEnded, WriterRequest } from "../../core/extension";
import type { JsonValue, ModelMessage, RemoteTool, RemoteToolCall } from "../../core/ports";
import type { ExtensionMember, ExtensionOffer } from "../../link/contract";
import { EXTENSION_MEMBERS } from "../../link/contract";
import { isRecord } from "../../link/json";
import { CEILINGS } from "../../link/settings";
import type { Chats } from "./chat";
import { LinkRefused, wordsOf } from "./errors";
import type { Mcp } from "./mcp";
import { mcpNameOf } from "./mcp";

/** What the extension supplies to the core. A member left out is something it doesn't supply. */
export interface BackendExtension {
  /** Its name, as the log says it. */
  name: string;
  /** Its agent definitions and skills for a user, read at the start of every run; `chatId` is the chat that run is about (null: none). */
  definitions?(userId: string, chatId: string | null): Promise<ExtensionDefinitions>;
  /** What it supplies for a chat (the main agent that answers it, its guidance level, its word on what counts as the story); null for a chat it doesn't claim. */
  claim?(ask: ClaimAsk, userId: string): Promise<ChatClaim | null>;
  /** The writer's request, rewritten; null: as the core built it. */
  writerRequest?(request: WriterRequest, userId: string): Promise<ModelMessage[] | null>;
  runBegan?(run: RunBegan, userId: string): Promise<void>;
  replyWritten?(reply: ReplyWritten, userId: string): Promise<void>;
  runEnded?(run: RunEnded, userId: string): Promise<void>;
}

/** The extension's own tools: what it offers for a chat (`""`: none), and a call of one, run here. */
export interface BackendTools {
  list(chatId: string, userId: string): Promise<RemoteTool[]>;
  call(call: RemoteToolCall, signal: AbortSignal, userId: string): Promise<{ text: string; error?: boolean }>;
}

/** What the runtime is told on hello: the extension's name and the members it has; null when there is no extension. */
export function offerOf(extension: BackendExtension | undefined): ExtensionOffer | null {
  if (extension === undefined) return null;
  return { name: extension.name, members: EXTENSION_MEMBERS.filter((member) => typeof extension[member] === "function") };
}

/**
 * The extension as the core takes it (`HarnessExtension`), for one user. The core's asks name whom
 * they are for; whatever one names, the members are handed `userId`: where the core runs here it
 * is that user's own harness, and behind a link the ask is a runtime's word and the runtime was
 * authenticated as that user's.
 */
export function harnessExtension(extension: BackendExtension, userId: string): HarnessExtension {
  return {
    name: extension.name,
    ...(extension.definitions ? { definitions: (ask) => extension.definitions?.(userId, ask.chatId) ?? Promise.resolve({}) } : {}),
    ...(extension.claim ? { claim: (ask) => extension.claim?.({ ...ask, userId }, userId) ?? Promise.resolve(null) } : {}),
    ...(extension.writerRequest ? { writerRequest: (request) => extension.writerRequest?.({ ...request, userId }, userId) ?? Promise.resolve(null) } : {}),
    ...(extension.runBegan ? { runBegan: (run) => extension.runBegan?.({ ...run, userId }, userId) ?? Promise.resolve() } : {}),
    ...(extension.replyWritten ? { replyWritten: (reply) => extension.replyWritten?.({ ...reply, userId }, userId) ?? Promise.resolve() } : {}),
    ...(extension.runEnded ? { runEnded: (run) => extension.runEnded?.({ ...run, userId }, userId) ?? Promise.resolve() } : {}),
  };
}

/** A name as a refusal says it back. What a runtime sent as a name may be any length, and a refusal is held until its reader has it: one longer than any name is cut. */
const said = (name: string): string => (name.length > CEILINGS.nameChars ? `${name.slice(0, CEILINGS.nameChars)}…` : name);

/**
 * `extension.call`: one member, run here with what the core handed it, for the user the runtime was
 * authenticated as. `supplied` false when the extension has no such member.
 *
 * The user is the link's word; the chat is only the frame's, and any account can register a runtime
 * and send one. So a member is handed a chat id only once `chats` says it is a chat of that user's
 * (`""`, a run about no chat, names none), and what `claim` is asked with (the chat, and what counts
 * as its story) is read here, never taken as the frame described it. A chat that isn't the user's is
 * refused before the member runs.
 */
export async function callExtension(extension: BackendExtension | undefined, member: unknown, arg: unknown, userId: string, chats: Pick<Chats, "own"> & { claimAsk(userId: string, chatId: string): Promise<ClaimAsk | null> }): Promise<{ supplied: boolean; value: JsonValue }> {
  if (typeof member !== "string" || !EXTENSION_MEMBERS.includes(member as ExtensionMember)) throw new LinkRefused("bad_request", `An extension has no member ${said(String(member))}: update the runtime and the extension to the same build.`);
  const none = { supplied: false, value: null };
  if (extension === undefined) return none;
  const core = harnessExtension(extension, userId);
  // The core hands each member what its contract says (extension.ts); past the chat it names, a member checks what it reads of it, as it would beside the core.
  const given = arg as never;
  const json = (value: unknown): JsonValue => (value === undefined ? null : (value as JsonValue));
  /** A hook's word is about a run, and a run names its chat. */
  const ownChat = async (): Promise<void> => {
    if (!isRecord(arg) || typeof arg.chatId !== "string") throw new LinkRefused("bad_request", `${member} is told of a run, which names its chat: update the runtime and the extension to the same build.`);
    if (arg.chatId !== "") await chats.own(userId, arg.chatId);
  };
  switch (member as ExtensionMember) {
    case "definitions": {
      if (core.definitions === undefined) return none;
      const chatId = isRecord(arg) && typeof arg.chatId === "string" && arg.chatId !== "" ? (await chats.own(userId, arg.chatId)).id : null;
      return { supplied: true, value: json(await core.definitions({ userId, chatId })) };
    }
    case "claim": {
      if (core.claim === undefined) return none;
      // The ask names its chat; a runtime of an earlier build sent the chat alone.
      const chat = isRecord(arg) && isRecord(arg.chat) ? arg.chat : arg;
      if (!isRecord(chat) || typeof chat.id !== "string") throw new LinkRefused("bad_request", "A claim is asked about a chat.");
      const ask = await chats.claimAsk(userId, chat.id);
      // The same words whether it is another account's chat or no chat at all, as everywhere a chat is refused.
      if (ask === null) throw new LinkRefused("not_found", "There is no such chat in this account.");
      return { supplied: true, value: json(await core.claim(ask)) };
    }
    case "writerRequest":
      if (core.writerRequest === undefined) return none;
      await ownChat();
      return { supplied: true, value: json(await core.writerRequest(given)) };
    case "runBegan":
      if (core.runBegan === undefined) return none;
      await ownChat();
      await core.runBegan(given);
      return { supplied: true, value: null };
    case "replyWritten":
      if (core.replyWritten === undefined) return none;
      await ownChat();
      await core.replyWritten(given);
      return { supplied: true, value: null };
    case "runEnded":
      if (core.runEnded === undefined) return none;
      await ownChat();
      await core.runEnded(given);
      return { supplied: true, value: null };
  }
}

/**
 * The tools that run in the extension: its own, then those of the MCP servers the user left on,
 * each MCP tool a row of tier `external` named `mcp:<server>:<tool>`. A tool of the extension's that
 * takes an MCP tool's name stands over it.
 */
export class RemoteTools {
  constructor(
    private readonly own: BackendTools | undefined,
    private readonly mcp: Mcp,
    private readonly log: (level: "warn", message: string) => void,
  ) {}

  /** `tools.list`. An MCP listing that fails leaves the extension's own tools standing: one unreachable server never takes a run's tools away. */
  async list(userId: string, chatId: string): Promise<RemoteTool[]> {
    const own = this.own === undefined ? [] : (await this.own.list(chatId, userId)).map((tool): RemoteTool => ({ ...tool, source: "extension" }));
    const taken = new Set(own.map((tool) => tool.name));
    let mcp: RemoteTool[] = [];
    try {
      mcp = (await this.mcp.tools(userId)).filter((tool) => !taken.has(tool.name)).map((tool): RemoteTool => ({ name: tool.name, family: tool.family, tier: "external", description: tool.description, parameters: tool.parameters, source: "user" }));
    } catch (error) {
      this.log("warn", `[LumiAH] the MCP servers' tools couldn't be listed (${wordsOf(error)})`);
    }
    return [...own, ...mcp];
  }

  /**
   * `tool.call`: runs one. A failure is the tool's answer too, in words the model can act on; only
   * the call's own signal ending it rejects.
   */
  async call(userId: string, call: RemoteToolCall, signal: AbortSignal): Promise<{ text: string; error?: boolean }> {
    const ownIt = this.own !== undefined && (mcpNameOf(call.name) === null || (await this.own.list(call.chatId, userId)).some((tool) => tool.name === call.name));
    try {
      if (ownIt && this.own !== undefined) return await this.own.call(call, signal, userId);
      if (mcpNameOf(call.name) !== null) return { text: await this.mcp.call(userId, call.name, call.args, signal) };
      return { text: `There is no tool ${said(call.name)} in this extension now. Go on without it.`, error: true };
    } catch (error) {
      if (signal.aborted) throw error;
      return { text: wordsOf(error), error: true };
    }
  }
}
