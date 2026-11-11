// Approval (DESIGN §17): which tool calls wait for the user's word, and what the user already said
// yes to for a chat.
//
// Every tool has a tier (`read`, `write`, `external`), and Settings say for each tier, and per tool
// over its tier, whether a call runs or waits. A call that waits is held in the loop (`ApprovalGate`),
// asked through the host's `approvals` port and answered with once, the tool for this chat, or no.
// "For this chat" is kept in a document of the chat's (`approved.ts`), so it holds across turns and
// restarts and is one chat's alone. Several runs may be under way in one chat (a turn, and jobs
// beside it): each reads that document again before it asks and before it adds to it, so a word
// given in one holds in the others, and none writes over what another kept.
//
// What comes back from an ask is outside data, as every answer of a port is: only an answer that is
// exactly an approval lets the call run (`approvalAnswerOf`). Anything else is no word for it.

import { keepApproval, keptApprovals } from "./approved";
import type { ApprovalGate } from "./loop";
import type { ApprovalAnswer, HarnessHost, ToolTier } from "./ports";
import { isRecord } from "./ports";
import type { ApprovalRule, Settings } from "./settings";
import { SCRATCH_READ, TOOL } from "./text-def";
import type { AgentTool, RunInfo } from "./tools";
import { errorText, hasOwn } from "./util";

/**
 * The tools a tier's rule never holds, whatever it says: `scratch_read` gives an agent the rest of a
 * result it was already given, and `write_reply` is the turn's own answer, which the user asked for
 * by sending their message. Fixed, not a setting: a rule for the tier they sit in ("ask before
 * anything that reads") would otherwise ask before every reply. A rule set for one of them by name
 * still holds it.
 */
const NEVER_BY_TIER: readonly string[] = [SCRATCH_READ, TOOL.writeReply];

/** The rule a tool's calls go by: its own where Settings give it one, else its tier's. */
export function approvalOf(settings: Readonly<Pick<Settings, "approval">>, tool: { name: string; tier?: ToolTier }): ApprovalRule {
  const own = hasOwn(settings.approval.tools, tool.name) ? settings.approval.tools[tool.name] : undefined;
  if (own !== undefined) return own;
  if (NEVER_BY_TIER.includes(tool.name)) return "allow";
  return settings.approval.tiers[tool.tier ?? "read"];
}

/**
 * An answer to an ask, read as what it is: data from outside the core (the host's port, and behind
 * it a page, a link, another process). An approval is an object whose `decision` is exactly `once`
 * or `chat`; a refusal one whose `decision` is exactly `refused`, with the user's reason where it
 * holds one in words. Null for anything else (nothing, a text, an object with no decision or with
 * one that is none of the three, however it is spelled): nobody gave their word, so no call runs on
 * it. Approval fails closed.
 */
export function approvalAnswerOf(raw: unknown): ApprovalAnswer | null {
  if (!isRecord(raw)) return null;
  if (raw.decision === "once" || raw.decision === "chat") return { decision: raw.decision };
  if (raw.decision !== "refused") return null;
  return typeof raw.reason === "string" ? { decision: "refused", reason: raw.reason } : { decision: "refused" };
}

/**
 * The tools the user approved for one chat, as one run holds them: read when the run begins, read
 * again before it asks about a call and when it keeps an approval (another run of the chat may have
 * been told "for this chat" since), and added to as the user approves more.
 */
export class ChatApprovals {
  private readonly tools = new Set<string>();

  constructor(
    private readonly host: Pick<HarnessHost, "store" | "clock" | "log">,
    private readonly chatId: string,
  ) {}

  /** Reads what is stored, beside what the run holds already. A document that can't be read is taken as none: the user is asked again, which is the safe way to be wrong. */
  async load(): Promise<void> {
    try {
      for (const { tool } of await keptApprovals(this.host.store, this.chatId)) this.tools.add(tool);
    } catch (error) {
      this.host.log("warn", `[LumiAH] the tools approved for chat ${this.chatId} couldn't be read: ${errorText(error)}`);
    }
  }

  has(tool: string): boolean {
    return this.tools.has(tool);
  }

  all(): string[] {
    return [...this.tools];
  }

  /**
   * Approves a tool for the chat from now on: it is added to what the store holds now, which may be
   * more than this run read (another run of the chat kept an approval since). The call that asked
   * runs either way; an approval that can't be kept is asked for again next turn, and a store that
   * can't be read is left as it is, since writing this run's own tools would lose the others'.
   */
  async add(tool: string): Promise<void> {
    this.tools.add(tool);
    try {
      // Added to what the store holds now, never this run's whole list written over it: that list may hold a tool the user has taken out again since the run read it.
      for (const kept of await keepApproval(this.host, this.chatId, tool)) this.tools.add(kept.tool);
    } catch (error) {
      this.host.log("warn", `[LumiAH] approving ${tool} for chat ${this.chatId} couldn't be kept: ${errorText(error)}`);
    }
  }
}

/**
 * Approval for one run's agents: a call waits when its tool's rule says ask and the user hasn't
 * approved the tool for the run's chat. A run about no chat has no "for this chat": such an answer
 * holds for that run alone.
 */
export function approvalGate(host: Pick<HarnessHost, "approvals">, settings: Readonly<Pick<Settings, "approval">>, run: RunInfo, approved: ChatApprovals | null): ApprovalGate {
  const forRun = new Set<string>();
  const port = host.approvals;
  return {
    waitMs: settings.approval.waitMs,
    asks: (tool: AgentTool) => approvalOf(settings, tool) === "ask" && !approved?.has(tool.name) && !forRun.has(tool.name),
    ...(port
      ? {
          ask: async (ask, signal) => {
            // The user may have approved the tool for this chat in another run since this one last read (a job beside a turn): they gave their word for the chat, and aren't asked for it twice.
            if (approved) {
              await approved.load();
              if (approved.has(ask.tool)) return { decision: "chat" };
            }
            // Read before anything is done on it: an answer that isn't one keeps nothing for the chat, and goes on to the loop as no answer.
            const answer = approvalAnswerOf(await port.ask({ turn: run.id, chatId: run.chatId, ...ask }, signal));
            if (answer?.decision === "chat") {
              forRun.add(ask.tool);
              await approved?.add(ask.tool);
            }
            return answer;
          },
        }
      : {}),
  };
}
