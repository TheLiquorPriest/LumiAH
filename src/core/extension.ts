// What an extension that builds LumiAH into itself may supply (DESIGN §21), as the core takes it: one
// object, handed to `createHarness`.
//
// Every member is a function that answers later and takes and gives plain JSON, so each can be a
// request over the link: the extension's own code then runs in its backend, and the runtime that
// holds the core stays the same for every extension. A member left out is something it doesn't
// supply. The core waits for each call no longer than Settings allow and goes on without an answer
// that doesn't come, or that fails: an extension can add to a turn, never hold it.
//
// Every member is told whom the call is for: the user (`userId`) and, where the call is about one,
// the chat. One backend may serve every user of a Lumiverse (§25), and what an extension supplies
// (its definitions, its texts, what it prepared) is a user's own.
//
// Two things an extension supplies never come this way:
// - Its tools run in its backend and reach the core through the host's `tools` port (§13).
// - Its own record per message, where it keeps one (§5), is the host's to fold LumiAH's record into:
//   `ChatPort.path` gives each message's anchor as LumiAH's record alone, and `ChatPort.anchor` and
//   the turn's commit take LumiAH's record alone.

import type { AgentDefinition } from "./agents";
import type { AgentUsage, ChatInfo, ModelMessage, RunKind, TurnKind, TurnRecord, TurnStatus } from "./ports";
import type { Skill } from "./skills";
import type { StorySetting, StorySource } from "./story";

/**
 * A level of guidance (§12) by the name agents are told it under ("this world's"), and where its
 * markdown is: a file of the user's area (`~/worlds/harbour/GUIDANCE.md`), which the user edits on
 * the page like any other, or the text itself, where the extension keeps it somewhere of its own.
 */
export type GuidanceLevel = { name: string; path: string } | { name: string; text: string };

/**
 * What an extension supplies for one chat it claims: the agent definition that answers it in place
 * of LumiAH's main agent; the middle level of guidance, in place of the character's; the tools
 * of LumiAH's own it withdraws there, by name (none of this chat's agents is offered them); and its
 * word on what counts as the chat's story (§24.4), member by member: each member it gives stands
 * over the chat's own choice and the user's setting, and the pages show it as set by the extension.
 *
 * Claiming a chat is also what lets the extension's own tools stand in for LumiAH's: in a chat it
 * claims, a tool of its that bears the name of one of LumiAH's replaces it (its `lore_search`, with
 * rules of its own, is the one offered). In every other chat LumiAH's stands and the extension's
 * tool of that name isn't offered. A claim that names nothing (`{}`) is still a claim.
 */
export interface ChatClaim {
  mainAgent?: string;
  guidance?: GuidanceLevel;
  withdraw?: string[];
  story?: Partial<StorySetting>;
}

/** An extension's own definitions: its defaults, which the user's still override (§13). */
export interface ExtensionDefinitions {
  agents?: AgentDefinition[];
  skills?: Skill[];
}

/** Whose definitions are asked for, and for a run about which chat (null: about none). */
export interface DefinitionsAsk {
  userId: string;
  chatId: string | null;
}

/**
 * The chat a claim is asked about, and whose it is. `story`: what counts as the chat's story without
 * the claim's word (the chat's own choice over the user's setting, Lumiverse's Sovereign Hand
 * followed where they say to). The claim's `story` stands over it member by member, so the story the
 * chat's runs read is known when the claim is made. `sovereignHand`: whether Lumiverse's Sovereign
 * Hand is on for the user in this chat; null where Lumiverse doesn't tell extensions (a word that
 * follows Lumiverse then counts it as off).
 */
export interface ClaimAsk {
  userId: string;
  chatId: string;
  chat: ChatInfo;
  story: StorySource;
  sovereignHand: boolean | null;
}

/** The writer's request as the core built it: Lumiverse's messages as they came, with the main agent's brief put in (null: it wrote none). */
export interface WriterRequest {
  userId: string;
  chatId: string;
  generationId: string;
  kind: TurnKind;
  brief: string | null;
  messages: ModelMessage[];
}

/** A run beginning: a turn that answers a generation, a job's run, or a turn of a side session (`chatId` is empty for one about no chat). `story`: what counts as the chat's story for this run (§24.4), the claim's word included. */
export interface RunBegan {
  userId: string;
  chatId: string;
  /** The run's id: the generation's, the job's, or the side session turn's. */
  turn: string;
  kind: RunKind;
  story: StorySource;
}

/** A turn's reply, written whole: its text as it was sent, and how its last call ended. */
export interface ReplyWritten {
  userId: string;
  chatId: string;
  turn: string;
  reply: string;
  finish: string;
}

/** A run ended: how, what it spent, and, for a turn that answered a generation, the reply it sent and the record it leaves. */
export interface RunEnded {
  userId: string;
  chatId: string;
  turn: string;
  kind: RunKind;
  status: TurnStatus;
  reason?: string;
  reply: string;
  record: TurnRecord | null;
  usage: AgentUsage;
}

export interface HarnessExtension {
  /** Its name, as the log says it. */
  name: string;
  /** Its agent definitions and skills for a user, read at the start of every run. */
  definitions?(ask: DefinitionsAsk): Promise<ExtensionDefinitions>;
  /** What it supplies for a chat; null for a chat it doesn't claim. Asked at the start of every run about that chat. */
  claim?(ask: ClaimAsk): Promise<ChatClaim | null>;
  /**
   * The writer's request, rewritten: the messages the writer is sent instead, to place what the
   * extension prepared where the user's preset expects it. Null: as the core built it.
   */
  writerRequest?(request: WriterRequest): Promise<ModelMessage[] | null>;
  /** A run begins: nothing of it has been sent to a model yet, and nothing is until this answers (or its wait runs out). */
  runBegan?(run: RunBegan): Promise<void>;
  /** A turn's reply has been written and its stream ended. */
  replyWritten?(reply: ReplyWritten): Promise<void>;
  /** A run ended, whichever way. */
  runEnded?(run: RunEnded): Promise<void>;
}
