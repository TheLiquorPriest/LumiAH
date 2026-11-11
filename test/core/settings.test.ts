// The core's settings: every limit has a default, the schema and the defaults are one shape, the
// user's own values merge over the defaults, and a value the schema refuses is named with why.

import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../../src/core/ports";
import { isRecord } from "../../src/core/ports";
import { checkSettings, defaultSettings, SETTINGS_SCHEMA, settingsOf, settingsSchema } from "../../src/core/settings";

/** The keywords the Settings page builds forms from (src/shared/ui.ts), and `default` for a table's new row. */
const KEYWORDS: readonly string[] = ["title", "description", "type", "properties", "additionalProperties", "enum", "oneOf", "const", "minimum", "maximum", "multipleOf", "x-unit", "x-none", "x-keys", "format", "maxLength", "items", "uniqueItems", "default"];

/** Every node of a schema with the path to it. */
function nodes(schema: JsonObject, path: string[] = []): { path: string[]; node: JsonObject }[] {
  const out = [{ path, node: schema }];
  if (isRecord(schema.properties)) for (const [key, child] of Object.entries(schema.properties)) out.push(...nodes(child as JsonObject, [...path, key]));
  if (isRecord(schema.additionalProperties)) out.push(...nodes(schema.additionalProperties as JsonObject, [...path, "*"]));
  return out;
}

describe("the schema and the defaults", () => {
  test("the defaults are settings the schema takes as they are", () => {
    expect(checkSettings(defaultSettings())).toEqual([]);
    expect(settingsOf(defaultSettings())).toEqual(defaultSettings());
    expect(settingsOf(undefined)).toEqual(defaultSettings());
    expect(settingsOf("not settings")).toEqual(defaultSettings());
  });

  test("every setting the schema has is in the defaults, and every default is in the schema", () => {
    const walk = (schema: JsonObject, value: unknown, path: string): void => {
      if (!isRecord(schema.properties)) return;
      expect(isRecord(value)).toBe(true);
      expect({ path, keys: Object.keys(value as object).sort() }).toEqual({ path, keys: Object.keys(schema.properties).sort() });
      for (const [key, child] of Object.entries(schema.properties)) walk(child as JsonObject, (value as Record<string, unknown>)[key], `${path}/${key}`);
    };
    walk(SETTINGS_SCHEMA, defaultSettings(), "");
  });

  test("the schema is written in the keywords the Settings page reads, and every setting has a title", () => {
    for (const { path, node } of nodes(SETTINGS_SCHEMA)) {
      expect({ path, unknown: Object.keys(node).filter((k) => !KEYWORDS.includes(k)) }).toEqual({ path, unknown: [] });
      if (path.length > 0 && path.at(-1) !== "*") expect({ path, title: typeof node.title }).toEqual({ path, title: "string" });
      // A setting that may be none says what none means.
      if (Array.isArray(node.type) && node.type.includes("null")) expect({ path, none: typeof node["x-none"] }).toEqual({ path, none: "string" });
    }
  });

  test("every limit is a setting: each one of an agent's budget, the turn's, the loop's, the tools' and what is kept", () => {
    const s = defaultSettings();
    expect(Object.keys(s.agents.main!.budget).sort()).toEqual(["callMs", "callTokensIn", "callTokensOut", "callTools", "concurrency", "revisions", "tokensIn", "tokensOut", "toolTurns", "wallMs"]);
    expect(Object.keys(s.turn).sort()).toEqual(["tokensIn", "tokensOut", "toolTurns", "wallMs"]);
    expect(s.loop).toEqual({ repeats: 3, clipChars: 6000, thinkingInToolLoops: true, stream: true, charsPerToken: 3.2, retries: 2, retryWaitMs: 2000, answerFloor: 256, warnRounds: 2, cutRoomFactor: 2, cutRoomTokens: 64_000 });
    // Retries can be switched off, and a wait is never longer than a timer can hold.
    expect(checkSettings({ loop: { retries: 0, retryWaitMs: 0 } })).toEqual([]);
    expect(checkSettings({ loop: { retries: -1, retryWaitMs: 3_000_000_000 } }).map((p) => p.path.join("."))).toEqual(["loop.retries", "loop.retryWaitMs"]);
    // How often the live view is sent a streaming answer; 0 turns it off.
    expect(s.trace).toEqual({ deltaMs: 200 });
    expect(checkSettings({ trace: { deltaMs: 0 } })).toEqual([]);
    expect(settingsOf({ trace: { deltaMs: 500 } }).trace.deltaMs).toBe(500);
    expect(s.tools.pageChars).toBeLessThan(s.loop.clipChars);
    expect(s.reply).toMatchObject({ writer: "writer", withoutBrief: "write" });
  });

  test("every limit of the workspace, guidance, delegation, jobs, approval, spend and upkeep is a setting with a default", () => {
    const s = defaultSettings();
    // Agents pin in the chat's own areas alone: pinning in the user's area, which every chat reads, is the user's unless they give it away.
    expect(s.workspace).toEqual({ fileChars: 200_000, files: 400, areaChars: 4_000_000, pathChars: 200, versions: 10, pinChars: 12_000, agentsPinUser: false });
    expect(s.guidance).toEqual({ chars: 8000, agentsEdit: false });
    expect(s.skills).toEqual({ listChars: 4000 });
    // Two deep: the main agent delegates, and so does a job it starts (the job's agent stands at 1); whoever those hand a task to stands at 2 and hands nothing on.
    expect(s.delegation).toEqual({ depth: 2, atOnce: 3, perRun: 12, grant: "own", fileChars: 12_000, asChars: 200, replyHoldChars: 200 });
    // A job's sub-agents have no count of their own, since its allowance bounds them. A turn waits a minute at most for the jobs due by it.
    expect(s.jobs).toEqual({ enabled: true, atOnce: 1, perRun: 3, budget: { tokensIn: 600_000, tokensOut: 60_000, toolTurns: 60, wallMs: 900_000 }, tokensPerDay: 3_000_000, taskChars: 4000, openingChars: 600, recordWaitMs: 120_000, chain: true, delegations: null, dueWaitMs: 60_000 });
    expect(settingsOf({ jobs: { delegations: 4 } }).jobs.delegations).toBe(4);
    // No tier waits for the user's word as it ships: a tool that acts outside LumiAH is one they set up and switched on. Asking first is theirs to choose, by tier or by tool.
    expect(s.approval).toEqual({ tiers: { read: "allow", write: "allow", external: "allow" }, tools: {}, waitMs: 300_000 });
    // The main agent holds the tools the user adds (an extension's, a switched-on MCP server's) under one name; no other agent does, and no agent holds a built-in that acts outside LumiAH unless the user gives it.
    expect(s.agents.main?.tools.at(-1)).toBe("@added");
    expect(Object.entries(s.agents).filter(([, agent]) => agent.tools.includes("@added")).map(([id]) => id)).toEqual(["main"]);
    expect(Object.values(s.agents).flatMap((agent) => agent.tools).filter((name) => name === "web_search")).toEqual([]);
    expect(checkSettings({ agents: { summarizer: { tools: ["chat_read", "@added"] } } })).toEqual([]);
    // No cap on a day's spend as it ships; a prompt token read again from a provider's cache counts as a tenth of one against every limit on prompt tokens, and the user may set any share from none to all.
    expect(s.spend).toEqual({ tokensPerDay: null, costPerDay: null, cachedWeight: 0.1 });
    expect(settingsOf({ spend: { cachedWeight: 1 } }).spend.cachedWeight).toBe(1);
    expect(checkSettings({ spend: { cachedWeight: 0 } })).toEqual([]);
    expect(checkSettings({ spend: { cachedWeight: 1.5 } }).map((p) => [p.path.join("."), p.message])).toEqual([["spend.cachedWeight", "It must be at most 1."]]);
    expect(s.extension).toEqual({ waitMs: 10_000 });
    expect(s.keep).toMatchObject({ promptDays: 30, transcriptDays: 90, spanDays: null, graceHours: 24 });
    // A receipt keeps as much of a call's arguments as of its result.
    expect(s.session).toMatchObject({ rollbackMarginTokens: 8000, receiptChars: 600, receiptArgChars: 600 });
    // Each agent says how its tools are offered, and the summarizer holds read tools only.
    expect(s.agents.main?.toolCalls).toBe("auto");
    expect(s.agents.summarizer?.tools).toEqual(["chat_search", "chat_grep", "chat_read", "book_outline", "book_read", "lore_search", "lore_read", "workspace_list", "workspace_read", "workspace_grep"]);
    // A tool's own rule stands over its tier's, by the tool's name.
    expect(settingsOf({ approval: { tools: { workspace_delete: "ask" } } }).approval.tools).toEqual({ workspace_delete: "ask" });
    expect(checkSettings({ approval: { tiers: { read: "sometimes" } }, jobs: { atOnce: 0 }, delegation: { grant: "all" } }).map((p) => p.path.join("."))).toEqual(["delegation.grant", "jobs.atOnce", "approval.tiers.read"]);
  });
});

describe("the user's own values", () => {
  test("merge over the defaults, whole or in part", () => {
    const s = settingsOf({ reply: { writer: "main" }, loop: { repeats: 5 }, agents: { main: { connectionId: "conn-1", budget: { toolTurns: null, callMs: 90_000 } } }, session: { summarizeAtTokens: null } });
    expect(s.reply.writer).toBe("main");
    expect(s.reply.briefAt).toBe("before_last_user");
    expect(s.loop).toEqual({ ...defaultSettings().loop, repeats: 5 });
    expect(s.agents.main).toEqual({ ...defaultSettings().agents.main!, connectionId: "conn-1", budget: { ...defaultSettings().agents.main!.budget, toolTurns: null, callMs: 90_000 } });
    expect(s.agents.writer).toEqual(defaultSettings().agents.writer!);
    expect(s.session.summarizeAtTokens).toBeNull();
  });

  test("a value the schema refuses reads as its default, and is named with why", () => {
    const values = { loop: { repeats: 1, clipChars: "long", stream: "yes", charsPerToken: 40 }, reply: { writer: "nobody", progress: null }, agents: { main: { effort: "extreme", tools: ["chat_read", "chat_read", "telepathy", 7] } }, turn: { tokensIn: 0 }, colour: "blue", tools: { pageItems: 2.5 } };
    expect(checkSettings(values)).toEqual([
      { path: ["reply", "writer"], message: "It must be one of: writer, main." },
      { path: ["reply", "progress"], message: "It can't be none." },
      { path: ["agents", "main", "effort"], message: "It must be one of: inherit, off, auto, minimal, low, medium, high, xhigh, max." },
      { path: ["agents", "main", "tools", 1], message: "It is listed twice." },
      { path: ["agents", "main", "tools", 2], message: expect.stringContaining("It must be one of: chat_search") as unknown as string },
      { path: ["agents", "main", "tools", 3], message: "It must be text." },
      { path: ["turn", "tokensIn"], message: "It must be at least 1." },
      { path: ["loop", "repeats"], message: "It must be at least 2." },
      { path: ["loop", "clipChars"], message: "It must be a number." },
      { path: ["loop", "stream"], message: "It must be on or off." },
      { path: ["loop", "charsPerToken"], message: "It must be at most 8." },
      { path: ["tools", "pageItems"], message: "It must be a whole number." },
      { path: ["colour"], message: "There is no such setting." },
    ]);
    const s = settingsOf(values);
    expect(s.loop).toEqual(defaultSettings().loop);
    expect(s.reply).toEqual(defaultSettings().reply);
    expect(s.agents.main?.tools).toEqual(["chat_read"]);
    expect(s).not.toHaveProperty("colour");
  });

  test("a table takes rows by name: a throttle per connection, a price per model", () => {
    const s = settingsOf({ connections: { atOnce: 2, throttles: { "conn-1": { requestsPerMinute: 30 }, "conn-2": { tokensPerMinute: -5 } } }, prices: { "model-a": { in: 3, out: 15 } } });
    expect(s.connections).toEqual({ atOnce: 2, toolRefusalMinutes: 60, throttles: { "conn-1": { requestsPerMinute: 30, tokensPerMinute: null, atOnce: null }, "conn-2": { requestsPerMinute: null, tokensPerMinute: null, atOnce: null } } });
    expect(s.prices).toEqual({ "model-a": { in: 3, cachedIn: 0, out: 15 } });
    expect(checkSettings({ connections: { throttles: { "conn-2": { tokensPerMinute: -5 } } } })).toEqual([{ path: ["connections", "throttles", "conn-2", "tokensPerMinute"], message: "It must be at least 1." }]);
  });

  test("an extension's own tools and agent definitions are settings too, once the schema is written for them", () => {
    const scope = { tools: ["chat_read", "tide_table"], agents: [{ id: "scout", label: "Scout", note: "Looks ahead.", defaults: { ...defaultSettings().agents.writer!, tools: ["tide_table"] } }] };
    expect(checkSettings({ agents: { main: { tools: ["tide_table"] } } })).toHaveLength(1);
    expect(checkSettings({ agents: { main: { tools: ["tide_table"] }, scout: { effort: "low" } } }, scope)).toEqual([]);
    const s = settingsOf({ agents: { main: { tools: ["tide_table"] }, scout: { effort: "low" } } }, scope);
    expect(s.agents.main?.tools).toEqual(["tide_table"]);
    expect(s.agents.scout).toMatchObject({ effort: "low", tools: ["tide_table"] });
    const schema = settingsSchema(scope);
    expect(nodes(schema).find((n) => n.path.join("/") === "agents/scout")?.node.title).toBe("Scout");
  });
});
