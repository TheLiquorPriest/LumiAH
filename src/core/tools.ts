// What a tool is (DESIGN §4.1), and the registry tools are kept in (§1: an extension that uses LumiAH
// as a package registers its own beside the base tools).
//
// A tool as an agent holds it is built for one agent of one turn: its description and its arguments'
// are the user's texts as they stand that turn, and what it reads is the turn's own (the chat as the
// turn reads it, the lore that applies, the main agent's earlier turns). So the registry keeps
// definitions, each of which builds its tool from the turn's environment (`ToolEnv`).

import type { ActivatedLore, ChatMessage, HarnessHost, JsonObject, LoreBook, LoreEntry, PathMessage, TurnRequest } from "./ports";
import type { LexicalIndex } from "./lexical";
import type { SessionSegment } from "./sessions";
import type { Settings } from "./settings";
import type { Texts } from "./texts";

/** What a tool's run gets besides its arguments: a signal that ends when the agent is cancelled or its time runs out, and who called. */
export interface ToolCtx {
  signal: AbortSignal;
  agentId: string;
  role: string;
  callId: string;
}

/**
 * What a tool gives back for the model: its text, and whether that's a failure. `end` ends the send
 * once the round's results are in, answered with this text and no further call (`write_reply`, whose
 * text is the reply).
 */
export interface ToolOutcome {
  text: string;
  error?: true;
  end?: true;
}

export interface AgentTool {
  name: string;
  description: string;
  /** Its arguments' JSON Schema, hand-written. */
  parameters: JsonObject;
  /**
   * What its calls act on, as a number that changes whenever that does, for a tool whose arguments
   * name something by where it stands now: once it changed, the same arguments ask something else,
   * so the loop detector takes a call the same as the one before it for a repeat only while this is
   * the same too.
   */
  state?(): number;
  run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome>;
}

/** The chat as one turn reads it: every message of the active path before the reply, read once and kept for the turn. */
export interface ChatView {
  /** The messages before the reply, oldest first, without their text. */
  path(): Promise<readonly PathMessage[]>;
  /** The same messages with their text. */
  messages(): Promise<readonly ChatMessage[]>;
  /** Their text indexed for search, by each message's place in `messages()`. */
  index(): Promise<LexicalIndex<number>>;
}

/** A lore entry as the tools name it: the entry, its book, and the short id an agent reads it by. */
export interface LoreItem {
  /** The shortest start of the entry's id that names it alone among the entries that apply. */
  short: string;
  entry: LoreEntry;
  book: LoreBook;
}

/** The lore that applies to the turn's chat, read once and kept for the turn. */
export interface LoreView {
  books(): Promise<readonly LoreBook[]>;
  /** Every entry of every book that applies, in the books' order. */
  items(): Promise<readonly LoreItem[]>;
  /** The entries' titles, keys and text indexed for search, by each entry's place in `items()`. */
  index(): Promise<LexicalIndex<number>>;
  /** The entries Lumiverse activated for this generation. */
  activated(): Promise<readonly ActivatedLore[]>;
}

/** An earlier turn of the main agent's on the path this turn reads: the reply it was for, its segment's hash, and its work in full. */
export interface PastTurn {
  reply: number;
  hash: string;
  segment: SessionSegment;
}

/**
 * What a tool is built from: the host, the turn, the user's settings and texts as they stand this
 * turn, the agent definition it is built for, and the turn's own reads. A later slice adds to it
 * (a workspace, starting sub-agents, jobs); a tool reads only what it needs.
 */
export interface ToolEnv {
  host: HarnessHost;
  turn: TurnRequest;
  settings: Readonly<Settings>;
  texts: Texts;
  /** The definition of the agent the tool is built for. */
  agent: string;
  chat: ChatView;
  lore: LoreView;
  /** The main agent's earlier turns on the path this turn reads, oldest first. */
  past: readonly PastTurn[];
  /** Hands the writer a brief and has it write the reply; absent where no writer writes this turn's reply. */
  writeReply?: (brief: string, ctx: ToolCtx) => Promise<ToolOutcome>;
}

/** A tool as the registry keeps it: its name, and how it is built for an agent of a turn (null: it has nothing to offer there). */
export interface ToolDefinition {
  name: string;
  build(env: ToolEnv): AgentTool | null;
}

/** The tools an agent definition may be given, by name. A name registered again replaces the one before it. */
export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();

  register(...definitions: readonly ToolDefinition[]): void {
    for (const d of definitions) this.byName.set(d.name, d);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  /** The tools `names` name, built for `env`, in the order named; a name no definition has, or one with nothing to offer, is left out. */
  build(names: readonly string[], env: ToolEnv): AgentTool[] {
    const out: AgentTool[] = [];
    for (const name of new Set(names)) {
      const tool = this.byName.get(name)?.build(env);
      if (tool) out.push(tool);
    }
    return out;
  }
}
