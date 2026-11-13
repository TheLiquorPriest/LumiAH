// What an extension that builds LumiAH into itself may supply (DESIGN §21), as the core takes it: one
// object, handed to `createHarness`.
//
// Every member is a function that answers later and takes and gives plain JSON, so each can be a
// request over the link: the extension's own code then runs in its backend, and the runtime that
// holds the core stays the same for every extension. A member left out is something it doesn't
// supply. The core waits for each call no longer than Settings allow and goes on without an answer
// that doesn't come, or that fails: an extension can add to a turn, never hold it. Two answers it
// can't do without: the claim on a chat (no run about the chat starts without it), and the
// definitions, where the agent a claim names to lead the chat's replies is one of them (no reply
// starts without that agent: nothing stands in for it). The run knows which asks got no answer,
// and why (`Setup.unanswered`).
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
import type { AgentRef, AgentUsage, ChatInfo, JsonObject, ModelEffort, ModelMessage, RunKind, TurnKind, TurnRecord, TurnStatus } from "./ports";
import type { Skill } from "./skills";
import type { StorySetting, StorySource } from "./story";

/**
 * A level of guidance (§12) by the name agents are told it under ("this world's"), and where its
 * markdown is: a file of the user's area (`~/worlds/harbour/GUIDANCE.md`), which the user edits on
 * the page like any other, or the text itself, where the extension keeps it somewhere of its own.
 */
export type GuidanceLevel = { name: string; path: string } | { name: string; text: string };

/**
 * What an extension supplies for one chat it claims: the agent definition that leads its replies in
 * place of LumiAH's main agent (one that can't run, nothing stands in for: the reply doesn't start);
 * the middle level of guidance, in place of the character's; the tools
 * of LumiAH's own it withdraws there, by name (none of this chat's agents is offered them); and its
 * word on what counts as the chat's story (§24.4), member by member: each member it gives stands
 * over the chat's own choice and the user's setting, and the pages show it as set by the extension.
 *
 * Claiming a chat is also what lets the extension's own tools stand in for LumiAH's: in a chat it
 * claims, a tool of its that bears the name of one of LumiAH's replaces it (its `lore_search`, with
 * rules of its own, is the one offered). In every other chat LumiAH's stands and the extension's
 * tool of that name isn't offered. A claim that names nothing (`{}`) is still a claim.
 *
 * `request` says what of the request Lumiverse assembled the main agent is shown (and a sub-agent
 * given the request): all of it (`whole`, the default), or only the user's newest message
 * (`newest`). `reply: "released"` says the reply is only what the chat's agents release
 * (`reply_write`, `delegate`'s `to_reply`): no writer writes it, and a turn that released nothing
 * fails with a plain reason. `replyTool` gives `reply_write` a description and arguments of the
 * extension's own in the chat (`ReplyTool`).
 */
export interface ChatClaim {
  mainAgent?: string;
  guidance?: GuidanceLevel;
  withdraw?: string[];
  story?: Partial<StorySetting>;
  request?: "whole" | "newest";
  reply?: "released";
  replyTool?: ReplyTool;
}

/**
 * `reply_write` as an extension offers it in the chats it claims (`ChatClaim.replyTool`): its
 * description, and its arguments as a JSON Schema of type object, in place of the one `text` the
 * core's own takes. The agent then names what goes out the extension's way (pieces it holds, by
 * number), and the extension's `releasing` gives the text that goes out: nothing is typed out twice.
 * Where the extension has no `releasing`, or the tool isn't one a model can be offered (no
 * description; arguments that aren't such a schema), the core's own `reply_write` stands in the
 * chat, and the log says why.
 */
export interface ReplyTool {
  description: string;
  parameters: JsonObject;
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

/**
 * Which model an agent of a run is about to run on, asked of the extension (`agentModel`): the
 * definition it runs as, which instance of it (`as`, from `delegate` or `job_start`; null where
 * nobody said), how it stands (`turn`: an agent the run starts itself, such as a turn's main agent
 * or the writer, or a side session's agent; `sub`: one another agent started; `job`: a job's
 * agent), and who started it (the agent that delegated or started the job, the user who started
 * the job, or null for an agent the run starts itself).
 */
export interface AgentModelAsk {
  userId: string;
  chatId: string;
  turn: string;
  kind: RunKind;
  definition: string;
  as: string | null;
  standing: "turn" | "sub" | "job";
  by: AgentRef | "user" | null;
}

/** The extension's word on an agent's model: each member given stands over the definition's own; one left out, or null, leaves the definition's. */
export interface AgentModelChoice {
  connectionId?: string | null;
  model?: string | null;
  effort?: ModelEffort | null;
}

/**
 * The turn's reply as an agent releases it itself (`reply_write`), or a sub-agent's answer that
 * streamed into it as the reply (`delegate`'s `to_reply`): the turn (its generation's id), the agent
 * whose release it is, its text, and the call's arguments as the agent gave them (`args`; none for
 * a `to_reply` stream). Asked about before a `reply_write` call goes out (`releasing`: `text` is the
 * text the call carries, empty where the chat's reply tool is the extension's own), and told of once
 * it went out or a stream ended (`released`: `text` is what reached the user). A turn's reply is
 * released once, whole.
 */
export interface ReplyRelease {
  userId: string;
  chatId: string;
  turn: string;
  agent: AgentRef;
  text: string;
  args: Record<string, unknown>;
}

/**
 * The extension's word on a release: refused (`refused` is what the agent is told), the text that
 * goes out in place of what the call carried (`text`), or null to let the call's own text go. Where
 * the chat's reply tool is the extension's own (`ChatClaim.replyTool`), the call carries no text:
 * only a text lets anything go.
 */
export type ReleaseVerdict = { refused: string } | { text: string } | null;

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
  /** Which connection, model and effort an agent runs on, asked as each agent of a run starts. Null: its definition's own, as without this. */
  agentModel?(ask: AgentModelAsk): Promise<AgentModelChoice | null>;
  /**
   * Whether the turn's reply may go out as an agent releases it with `reply_write`, and what goes
   * out: asked before it does. A refusal is the call's answer and nothing streams; a text is what
   * streams. Without this member, the call's text goes. An answer that is none of these (or null,
   * where the chat's reply tool is the extension's own), or none within Settings' wait, lets nothing
   * go: what the user reads is held to what the extension let through. A release that sent nothing
   * leaves the turn's one release still to come. A sub-agent's answer streaming in as the reply
   * (`to_reply`) is never asked about, only told.
   */
  releasing?(release: ReplyRelease): Promise<ReleaseVerdict>;
  /** The turn's reply went out (`reply_write`), or a sub-agent's answer finished streaming in as the reply (`to_reply`): what reached the user, and the call's arguments. Told once a turn at most. */
  released?(release: ReplyRelease): Promise<void>;
  /** A turn's reply has been written and its stream ended. */
  replyWritten?(reply: ReplyWritten): Promise<void>;
  /** A run ended, whichever way. */
  runEnded?(run: RunEnded): Promise<void>;
}
