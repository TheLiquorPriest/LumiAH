// The MCP example (`examples/mcp-tide-table`), run as Lumiverse runs a stdio server: a process whose
// stdin is sent one JSON-RPC message a line and whose stdout answers one a line. The messages are
// the ones an MCP client sends: `initialize`, the `initialized` notification, `tools/list` and
// `tools/call`.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SERVER = resolve(import.meta.dir, "../../examples/mcp-tide-table/tide-table.js");

/** Runs the server, sends it `messages` a line each, closes its stdin, and gives what it answered, a message for each line it wrote. */
async function converse(messages: readonly unknown[]): Promise<Record<string, unknown>[]> {
  const server = Bun.spawn([process.execPath, SERVER], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  for (const message of messages) server.stdin.write(typeof message === "string" ? `${message}\n` : `${JSON.stringify(message)}\n`);
  await server.stdin.end();
  const out = await new Response(server.stdout).text();
  expect(await server.exited).toBe(0);
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

describe("the tide table MCP server", () => {
  test("answers a client's opening, lists its one tool with a schema, and gives a day's tides as text", async () => {
    const answers = await converse([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      call(3, "tide_table", { day: "tomorrow" }),
    ]);
    // The notification is answered with nothing: three answers, each to the request of its id.
    expect(answers.map((a) => a.id)).toEqual([1, 2, 3]);
    expect(answers[0]?.result).toEqual({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "greywater-tides", version: "1.0.0" } });
    expect(answers[1]?.result).toEqual({
      tools: [{ name: "tide_table", description: "Greywater's tide table for a day: the times of high and low water, and what they mean for the ferry.", inputSchema: { type: "object", properties: { day: { type: "string", enum: ["today", "tomorrow"], description: "Which day." } }, required: ["day"], additionalProperties: false } }],
    });
    expect(answers[2]?.result).toEqual({ content: [{ type: "text", text: "Greywater, tomorrow. High water 07:02 and 19:28; low water 00:58 and 13:14. Spring tide: the lower quay steps are under water at high." }] });
  });

  test("a call it can't answer is an error the model can act on, a method it doesn't know is refused, and a line that isn't a message is passed over", async () => {
    const answers = await converse([call(1, "tide_table", { day: "constructor" }), call(2, "moon_phase", {}), "not json", { jsonrpc: "2.0", id: 3, method: "resources/list" }, { jsonrpc: "2.0", id: 4, method: "ping" }, call(5, "tide_table", { day: "today" })]);
    const wrong = { content: [{ type: "text", text: 'Unknown tool or day. Call tide_table with day "today" or "tomorrow".' }], isError: true };
    expect(answers.map((a) => a.id)).toEqual([1, 2, 3, 4, 5]);
    expect(answers[0]?.result).toEqual(wrong);
    expect(answers[1]?.result).toEqual(wrong);
    expect(answers[2]?.error).toEqual({ code: -32601, message: "Method not found: resources/list" });
    expect(answers[3]?.result).toEqual({});
    expect(answers[4]?.result).toEqual({ content: [{ type: "text", text: expect.stringMatching(/^Greywater, today\. High water 06:10 and 18:35;/) }] });
  });
});
