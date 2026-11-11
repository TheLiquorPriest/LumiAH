// The definitions as the Agents page shows and edits them (DESIGN §13, §16): the agents, the skills
// and the tools the core has for the user (its own, the extension's and the user's, merged where the
// core runs, so the page shows what a run would get), the MCP servers the user set up in Lumiverse,
// and what a tool's calls do (run, or wait for the user: §17).
//
// What the user makes or switches is kept with their settings (one revision for both, so the core
// reads either before its next run, in whichever place it runs): their own agents and skills by id,
// what they switched off, and the MCP servers they switched on. An MCP server's tools reach the core
// through the tools port only while its server is on, so nothing of an MCP server is offered until
// the user says so.

import type { AgentDefinition } from "../../core/agents";
import type { JsonObject, JsonValue, ToolTier } from "../../core/ports";
import { checkAgent, checkSkill } from "../../core/definitions";
import { ADDED_TOOLS } from "../../core/settings";
import type { Skill } from "../../core/skills";
import { isRecord } from "../../link/json";
import type { ApprovalChoice, DefsView, McpServerView } from "../../shared/ui";
import type { Asks } from "./asks";
import { UiRefused } from "./errors";
import type { Mcp } from "./mcp";
import type { SettingsStore } from "./settings";
import { defsView } from "./views";

/** What the user keeps of definitions, as stored with their settings. `mcp` is this backend's; the rest is the core's to read. */
interface StoredDefs {
  agents: Record<string, JsonObject>;
  skills: Record<string, JsonObject>;
  off: { agents: string[]; skills: string[]; tools: string[] };
  /** The MCP servers switched on for agents, by their ids in Lumiverse. */
  mcp: string[];
}

const strings = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s !== "") : []);

const records = (raw: unknown): Record<string, JsonObject> => {
  const out: Record<string, JsonObject> = {};
  if (isRecord(raw)) for (const [id, one] of Object.entries(raw)) if (isRecord(one)) out[id] = one as JsonObject;
  return out;
};

function storedOf(raw: JsonObject): StoredDefs {
  const off = isRecord(raw.off) ? raw.off : {};
  return { agents: records(raw.agents), skills: records(raw.skills), off: { agents: strings(off.agents), skills: strings(off.skills), tools: strings(off.tools) }, mcp: strings(raw.mcp) };
}

/**
 * A definition's id: what an agent names it by in a tool call, and a key of a stored document. Lower
 * case letters, digits, `_` and `-`, starting with a letter. A format, not a limit.
 */
const DEF_ID = /^[a-z][a-z0-9_-]{0,63}$/;

function idOf(id: string, what: string): string {
  if (!DEF_ID.test(id)) throw new UiRefused("invalid", `${what} is named by lower-case letters, digits, "_" and "-", starting with a letter (64 at most).`, [{ path: ["id"], message: "Not a name a definition can have." }]);
  return id;
}

const KIND_KEY = { agent: "agents", skill: "skills", tool: "tools" } as const;

export interface DefsDeps {
  settings: Pick<SettingsStore, "definitions" | "setDefinitions" | "values" | "change">;
  asks: Pick<Asks, "ask">;
  mcp: Pick<Mcp, "servers">;
  /** The key the core's settings sit under. */
  coreKey: string;
}

export class Definitions {
  /** How many times each user's definitions changed since the extension started. */
  private readonly revs = new Map<string, number>();
  private readonly changed: ((userId: string) => void)[] = [];

  constructor(
    private readonly deps: DefsDeps,
    private readonly now: () => number,
  ) {}

  /** A user's definitions changed (a counter in the pages' state moves). */
  onChange(listener: (userId: string) => void): void {
    this.changed.push(listener);
  }

  /** The counter the pages' state holds: it starts where no page can hold it from before this start. */
  rev(userId: string): number {
    let rev = this.revs.get(userId);
    if (rev === undefined) {
      rev = this.now();
      this.revs.set(userId, rev);
    }
    return rev;
  }

  private moved(userId: string): void {
    this.revs.set(userId, this.rev(userId) + 1);
    for (const listener of this.changed) listener(userId);
  }

  /** The MCP servers the user switched on for agents. */
  async mcpOn(userId: string): Promise<string[]> {
    return storedOf(await this.deps.settings.definitions(userId)).mcp;
  }

  private async edit(userId: string, change: (stored: StoredDefs) => void): Promise<void> {
    const raw = await this.deps.settings.definitions(userId);
    const stored = storedOf(raw);
    change(stored);
    // Whatever else the stored document holds (a later build's fields) is kept as it is.
    await this.deps.settings.setDefinitions(userId, { ...raw, agents: stored.agents, skills: stored.skills, off: stored.off, mcp: stored.mcp });
    this.moved(userId);
  }

  private async approval(userId: string): Promise<{ tiers: Record<ToolTier, ApprovalChoice>; tools: Record<string, ApprovalChoice> }> {
    const core = (await this.deps.settings.values(userId))[this.deps.coreKey];
    const approval = isRecord(core) && isRecord(core.approval) ? core.approval : {};
    const choice = (v: unknown): ApprovalChoice => (v === "ask" ? "ask" : "allow");
    const tiers = isRecord(approval.tiers) ? approval.tiers : {};
    const tools: Record<string, ApprovalChoice> = {};
    if (isRecord(approval.tools)) for (const [name, rule] of Object.entries(approval.tools)) if (rule === "ask" || rule === "allow") tools[name] = rule;
    return { tiers: { read: choice(tiers.read), write: choice(tiers.write), external: choice(tiers.external) }, tools };
  }

  /**
   * `lah.defs.get`: every definition as the core has it for the user (they are about no chat, so
   * the core built in merges them: asks.ts), each tool with what its calls do, and the MCP servers
   * with their switches.
   */
  async view(userId: string): Promise<DefsView> {
    const merged = await this.deps.asks.ask(userId, "definitions.get", {});
    const servers = await this.deps.mcp.servers(userId);
    const mcp = servers.map((s): McpServerView => ({ id: s.id, name: s.name, off: !s.on, status: !s.enabled ? "stopped" : s.problem !== null ? "failed" : "ready", ...(s.problem !== null ? { problem: s.problem } : {}), tools: s.tools.length }));
    return defsView(merged, await this.approval(userId), mcp);
  }

  /** What the core has for the user now, as it merges it. */
  private async merged(userId: string): Promise<Record<string, unknown>> {
    const merged = await this.deps.asks.ask(userId, "definitions.get", {});
    return isRecord(merged) ? merged : {};
  }

  /**
   * `lah.agent.save`: the user's own agent definition, new or in place of theirs of that id; one
   * with the id of a built-in or an extension's stands over it. Refused (`invalid`) with what the
   * core finds wrong with it. The fields an extension's definition keeps as its own (`owns`) are not
   * stored: the core takes them from the extension's definition as it is at each run. What an agent
   * runs with is the user's Settings for it over its definition's own, so the Settings they had for
   * this id are taken away with the save: what the page just saved is in force, and a later change
   * in Settings stands over it again.
   */
  async saveAgent(userId: string, agent: AgentDefinition): Promise<DefsView> {
    const id = idOf(agent.id, "An agent");
    const merged = await this.merged(userId);
    const tools = merged.tools;
    // A definition may name a tool, a whole family (`@chat`, `@mcp:<server>`) or every tool that isn't built in (`@added`), as the core's own check takes them.
    const names = [...new Set([...(Array.isArray(tools) ? tools : []).flatMap((t) => (isRecord(t) && typeof t.name === "string" ? [t.name, ...(typeof t.family === "string" && t.family !== "" ? [`@${t.family}`] : [])] : [])), ADDED_TOOLS])];
    // What the extension keeps of its own agent, as the core merged it: the user's version stands over the extension's (or is the user's already) under the same id.
    const row = (Array.isArray(merged.agents) ? merged.agents : []).find((a) => isRecord(a) && a.id === id);
    const owned = isRecord(row) && (row.source === "extension" || row.over === "extension") && Array.isArray(row.owns) ? row.owns.filter((field): field is string => typeof field === "string") : [];
    // Those fields are the extension's to give: what the page sent of them is set aside, the check reads the extension's own, and its tools aren't checked at all (a tool it names may be one this place doesn't list now).
    const given: Record<string, unknown> = { ...agent };
    for (const field of owned) if (field !== "tools" && isRecord(row)) given[field] = row[field];
    if (owned.includes("tools")) delete given.tools;
    const checked = checkAgent(given, names);
    const kept = checked.agent;
    if (kept === null || checked.problems.length > 0) throw new UiRefused("invalid", "The agent wasn't saved: it has something the core refuses.", checked.problems.map((p) => ({ path: [...p.path], message: p.message })));
    const { owns: _owns, ...stored } = kept as unknown as JsonObject;
    for (const field of owned) delete stored[field];
    if (owned.includes("instructions")) delete stored.text;
    await this.edit(userId, (defs) => {
      defs.agents[id] = stored;
    });
    await this.deps.settings.change(userId, [], [[this.deps.coreKey, "agents", id]]);
    return this.view(userId);
  }

  /** `lah.skill.save`. Refused (`forbidden`) for a skill the extension keeps as its own. */
  async saveSkill(userId: string, skill: Skill): Promise<DefsView> {
    const id = idOf(skill.id, "A skill");
    const skills = (await this.merged(userId)).skills;
    if ((Array.isArray(skills) ? skills : []).some((s) => isRecord(s) && s.id === id && s.owned === true)) throw new UiRefused("forbidden", "This skill belongs to the extension. You change it on that extension's own pages.");
    const checked = checkSkill(skill);
    const kept = checked.skill;
    if (kept === null || checked.problems.length > 0) throw new UiRefused("invalid", "The skill wasn't saved: it has something the core refuses.", checked.problems.map((p) => ({ path: [...p.path], message: p.message })));
    const { owned: _owned, ...stored } = kept;
    await this.edit(userId, (defs) => {
      defs.skills[id] = stored as unknown as JsonObject;
    });
    return this.view(userId);
  }

  /** `lah.def.remove`: the user's own definition goes; one that stood over an original gives way to it. An agent that was the user's alone takes its Settings with it, which would name no agent. */
  async remove(userId: string, kind: "agent" | "skill", id: string): Promise<DefsView> {
    const held = storedOf(await this.deps.settings.definitions(userId))[KIND_KEY[kind]];
    if (!Object.hasOwn(held, id)) throw new UiRefused("not_found", `You have no ${kind} of your own named "${id}". A built-in or an extension's can be switched off, not removed.`);
    const agents = kind === "agent" ? (await this.merged(userId)).agents : [];
    const alone = (Array.isArray(agents) ? agents : []).some((a) => isRecord(a) && a.id === id && a.over === undefined);
    await this.edit(userId, (stored) => {
      delete stored[KIND_KEY[kind]][id];
    });
    if (alone) await this.deps.settings.change(userId, [], [[this.deps.coreKey, "agents", id]]);
    return this.view(userId);
  }

  /** `lah.def.switch`: an agent, a skill or a tool off or on again; an MCP server's tools on for agents, or off again. */
  async switch(userId: string, kind: "agent" | "skill" | "tool" | "mcp", id: string, off: boolean): Promise<DefsView> {
    await this.edit(userId, (stored) => {
      const list = kind === "mcp" ? stored.mcp : stored.off[KIND_KEY[kind]];
      // The MCP list holds what is on; the others hold what is off.
      const listed = kind === "mcp" ? !off : off;
      const at = list.indexOf(id);
      if (listed && at < 0) list.push(id);
      if (!listed && at >= 0) list.splice(at, 1);
    });
    return this.view(userId);
  }

  private async approve(userId: string, path: string[], value: JsonValue | null): Promise<DefsView> {
    await this.deps.settings.change(userId, value === null ? [] : [{ path, value }], value === null ? [path] : []);
    this.moved(userId);
    return this.view(userId);
  }

  /** `lah.tool.approval`: what one tool's calls do; null: what its tier's do. The same setting Settings holds. */
  toolApproval(userId: string, name: string, approval: ApprovalChoice | null): Promise<DefsView> {
    return this.approve(userId, [this.deps.coreKey, "approval", "tools", name], approval);
  }

  /** `lah.tier.approval`. */
  tierApproval(userId: string, tier: ToolTier, approval: ApprovalChoice): Promise<DefsView> {
    return this.approve(userId, [this.deps.coreKey, "approval", "tiers", tier], approval);
  }
}
