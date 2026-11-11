// An MCP server in one file, with no dependencies: one tool, the tide table of the invented harbour
// of Greywater. It speaks MCP's stdio transport: one JSON-RPC message a line on stdin, one a line on
// stdout. Run it with `bun tide-table.js` or `node tide-table.js`; Lumiverse does, once you add it
// as a stdio server. Nothing here knows of LumiAH: any MCP client can use it.

// The data a tool of your own would look up: a file, a database, a service.
const TIDES = {
  today: { high: ["06:10", "18:35"], low: ["00:05", "12:20"], note: "The bar is passable for the ferry from two hours either side of high water." },
  tomorrow: { high: ["07:02", "19:28"], low: ["00:58", "13:14"], note: "Spring tide: the lower quay steps are under water at high." },
};

// What a model reads when it chooses a tool and writes its arguments: say what the tool gives, and describe each argument.
const TOOLS = [
  {
    name: "tide_table",
    description: "Greywater's tide table for a day: the times of high and low water, and what they mean for the ferry.",
    inputSchema: { type: "object", properties: { day: { type: "string", enum: ["today", "tomorrow"], description: "Which day." } }, required: ["day"], additionalProperties: false },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// A tool's answer is text for the model. A call that can't be answered says what to do instead, marked as an error, so the model can try again.
function callTool(name, args) {
  const row = name === "tide_table" && typeof args?.day === "string" && Object.hasOwn(TIDES, args.day) ? TIDES[args.day] : undefined;
  if (!row) return { content: [{ type: "text", text: 'Unknown tool or day. Call tide_table with day "today" or "tomorrow".' }], isError: true };
  return { content: [{ type: "text", text: `Greywater, ${args.day}. High water ${row.high.join(" and ")}; low water ${row.low.join(" and ")}. ${row.note}` }] };
}

function handle({ id, method, params }) {
  if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "greywater-tides", version: "1.0.0" } } });
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") return send({ jsonrpc: "2.0", id, result: callTool(params?.name, params?.arguments) });
  // A message without an id is a notification (`notifications/initialized`): it is answered with nothing.
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line === "") continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // A line that isn't a JSON-RPC message is ignored: the next one is read as usual.
    }
  }
});
process.stdin.on("end", () => process.exit(0));
