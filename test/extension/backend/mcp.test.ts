// MCP tools through Lumiverse (DESIGN §16): a server the user set up there offers its tools once
// it is switched on for agents, each named `mcp:<server>:<tool>`; a call goes through Lumiverse; and
// a server that is off, gone or unreachable offers nothing, and says why.

import { describe, expect, test } from "bun:test";
import { Mcp, mcpNameOf, mcpSlug, mcpSlugs } from "../../../src/extension/backend/mcp";
import { type FakeMcpServer, FakeHost } from "../../support/fake-host";

const USER = "user-mara";

function tides(): FakeMcpServer {
  return {
    server: { id: "srv-1", name: "Harbour Tides", enabled: true, createdAt: 1 },
    tools: [
      { name: "tide_table", description: "The day's tides at a harbour.", parameters: { type: "object", properties: { harbour: { type: "string" } }, required: ["harbour"] } },
      { name: "moon/phase", description: "The moon's phase on a day.", parameters: { type: "object", properties: {} } },
    ],
    run: (tool, args) => (tool === "tide_table" ? `High water at ${String(args.harbour)}: 06:10 and 18:40.` : "Waning."),
  };
}

function rig(on: string[] = ["srv-1"]) {
  const host = new FakeHost();
  host.permissions.add("mcp_servers");
  host.mcpServers.push(tides());
  const mcp = new Mcp(host, { on: async () => on, callMs: async () => 45_000 });
  return { host, mcp };
}

describe("an MCP server's tools", () => {
  test("are listed as mcp:<server>:<tool> once the user switched the server on for agents", async () => {
    const { mcp } = rig();
    const tools = await mcp.tools(USER);
    expect(tools.map((t) => t.name)).toEqual(["mcp:harbour-tides:tide_table", "mcp:harbour-tides:moon/phase"]);
    expect(tools[0]).toMatchObject({ family: "mcp:harbour-tides", serverId: "srv-1", serverName: "Harbour Tides", tool: "tide_table", description: "The day's tides at a harbour.", parameters: { required: ["harbour"] } });
    expect(await mcp.servers(USER)).toEqual([{ id: "srv-1", name: "Harbour Tides", slug: "harbour-tides", enabled: true, on: true, tools: ["mcp:harbour-tides:tide_table", "mcp:harbour-tides:moon/phase"], problem: null }]);
  });

  test("are not offered while the server is off for agents, and Lumiverse isn't asked for them", async () => {
    const { host, mcp } = rig([]);
    expect(await mcp.tools(USER)).toEqual([]);
    expect(await mcp.servers(USER)).toMatchObject([{ id: "srv-1", on: false, tools: [], problem: null }]);
    await expect(mcp.call(USER, "mcp:harbour-tides:tide_table", { harbour: "Okoro's Quay" }, new AbortController().signal)).rejects.toThrow('The MCP server "Harbour Tides" isn\'t switched on for LumiAH\'s agents.');
    expect(host.mcpCalls).toEqual([]);
  });

  test("of a server that is off in Lumiverse or can't be reached are left out, and the page is told why", async () => {
    const { host, mcp } = rig(["srv-1", "srv-2"]);
    host.mcpServers.push({ server: { id: "srv-2", name: "Ledger", enabled: true, createdAt: 2 }, tools: [], down: "MCP connection failed", run: () => "" });
    const first = host.mcpServers[0];
    if (first === undefined) throw new Error("no server");
    first.server.enabled = false;
    expect(await mcp.tools(USER)).toEqual([]);
    const [tidesState, ledger] = await mcp.servers(USER);
    expect(tidesState?.problem).toBe('"Harbour Tides" is switched off in Lumiverse, so its tools aren\'t offered. Switch it on in Lumiverse\'s MCP settings.');
    expect(ledger?.problem).toBe('"Ledger" couldn\'t be reached, so its tools aren\'t offered (MCP connection failed). Check it in Lumiverse\'s MCP settings.');
  });

  test("are none without the permission to use the user's MCP servers", async () => {
    const { host, mcp } = rig();
    host.permissions.delete("mcp_servers");
    expect(await mcp.tools(USER)).toEqual([]);
    expect(await mcp.servers(USER)).toEqual([]);
  });
});

describe("a call of an MCP tool", () => {
  test("goes through Lumiverse to the tool's own server, with the user's time limit, and gives its text back", async () => {
    const { host, mcp } = rig();
    const out = await mcp.call(USER, "mcp:harbour-tides:tide_table", { harbour: "Okoro's Quay" }, new AbortController().signal);
    expect(out).toBe("High water at Okoro's Quay: 06:10 and 18:40.");
    expect(host.mcpCalls).toEqual([{ serverId: "srv-1", tool: "tide_table", args: { harbour: "Okoro's Quay" }, timeoutMs: 45_000, userId: USER }]);
    // A tool's own name may hold what a server's can't: everything after the server is the tool.
    expect(await mcp.call(USER, "mcp:harbour-tides:moon/phase", {}, new AbortController().signal)).toBe("Waning.");
  });

  test("is refused in words the agent can act on for a server that is gone, and fails in the server's own words", async () => {
    const { host, mcp } = rig();
    const signal = new AbortController().signal;
    await expect(mcp.call(USER, "mcp:lighthouse:lamp", {}, signal)).rejects.toThrow('There is no MCP server "lighthouse" now: it was removed or renamed in Lumiverse.');
    await expect(mcp.call(USER, "tide_table", {}, signal)).rejects.toThrow("isn't an MCP tool's name");
    await expect(mcp.call(USER, "mcp:harbour-tides:storm_warning", {}, signal)).rejects.toThrow("MCP tool is not advertised by this server");
    const first = host.mcpServers[0];
    if (first === undefined) throw new Error("no server");
    first.run = () => {
      throw new Error("MCP tool error: the harbour is closed");
    };
    await expect(mcp.call(USER, "mcp:harbour-tides:tide_table", { harbour: "Okoro's Quay" }, signal)).rejects.toThrow("MCP tool error: the harbour is closed");
  });

  test("stops being waited for when its signal ends", async () => {
    const { host, mcp } = rig();
    const first = host.mcpServers[0];
    if (first === undefined) throw new Error("no server");
    first.run = () => new Promise<string>(() => undefined);
    const stop = new AbortController();
    const calling = mcp.call(USER, "mcp:harbour-tides:tide_table", { harbour: "Okoro's Quay" }, stop.signal);
    stop.abort(new Error("The turn was stopped."));
    await expect(calling).rejects.toThrow("The turn was stopped.");
  });
});

describe("a server's part of its tools' names", () => {
  test("is its name in lowercase letters, digits and dashes, one of a kind among the user's servers", () => {
    expect(mcpSlug("Harbour Tides")).toBe("harbour-tides");
    expect(mcpSlug("  Ilse's — Ledger (v2)  ")).toBe("ilse-s-ledger-v2");
    expect(mcpSlug("灯台")).toBe("server");
    const slugs = mcpSlugs([
      { id: "b", name: "Ledger", enabled: true, createdAt: 20 },
      { id: "a", name: "ledger!", enabled: true, createdAt: 10 },
      { id: "c", name: "LEDGER", enabled: true, createdAt: 30 },
    ]);
    // The one made first keeps the plain name.
    expect([slugs.get("a"), slugs.get("b"), slugs.get("c")]).toEqual(["ledger", "ledger-2", "ledger-3"]);
    expect(mcpNameOf("mcp:ledger-2:entries:list")).toEqual({ slug: "ledger-2", tool: "entries:list" });
    expect(mcpNameOf("mcp:ledger")).toBeNull();
    expect(mcpNameOf("chat_search")).toBeNull();
  });
});
