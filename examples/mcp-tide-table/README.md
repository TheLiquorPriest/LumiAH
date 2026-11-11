# Tide table: a tool for LumiAH's agents, as an MCP server

The shortest way to give LumiAH's agents a tool of your own takes no LumiAH code at all: write an [MCP](https://modelcontextprotocol.io) server, add it to Lumiverse, and switch it on for agents.

`tide-table.js` is such a server in one file with no dependencies. It offers one tool, `tide_table`, which gives the day's tides at the invented harbour of Greywater.

## Try it

1. **Add it to Lumiverse.** In Lumiverse's MCP server settings, add a server:
   - name: `Greywater tides`
   - transport: stdio
   - command: `bun` (or `node`)
   - one argument: the full path to `tide-table.js` on the machine Lumiverse runs on

   Lumiverse starts a stdio server only with `node`, `bun`, `deno`, `python` or `python3`, unless whoever runs it allows more.
2. **Switch it on for agents.** Open **LumiAH → Agents → Tools**. The server is listed under *MCP servers*, off. Switch it on. Its tool now shows among the tools as `mcp:greywater-tides:tide_table`.
3. **Ask for the tide** in a chat LumiAH answers. The main agent holds the tool from its next turn, and the **Live** page shows the call and what came back.

That is all. Two things you may want to change afterwards:

- **Ask first.** A server's tools are called without asking once you switch it on. To approve each call instead, choose *Ask first* on the Tools page, for all external tools or for this one.
- **Who holds it.** The main agent holds every tool you add. Other agents hold what their own tools list names: tick the tool for an agent on the Agents page, or untick *the tools you added* for the main agent to take them all away from it.

## How it works

The server reads one JSON-RPC message a line on stdin and writes one a line on stdout. It answers four methods:

| Method | What it answers |
| --- | --- |
| `initialize` | its name, and that it has tools |
| `tools/list` | each tool: a name, a description, and a JSON Schema for its arguments |
| `tools/call` | the tool's answer as text, or an error the model can act on |
| `ping` | nothing, to say it is up |

A model chooses a tool by its description and writes the arguments from the schema, so those two are where the care goes: say what the tool gives, and describe every argument.

An answer is text for the model. When a call can't be answered, say what to do instead and mark it `isError`: the agent reads that and tries again.

## Make it yours

Copy the file, replace `TIDES` with whatever you look up (a file, a database, a service), and describe your tools in `TOOLS`. Keep stdout for the protocol: anything you want to log goes to stderr.

`test/examples/mcp-tide-table.test.ts` in LumiAH's repository runs this server and checks its answers; it is a small harness for your own, too.

For more than tools (an agent, a skill, pages of your own), see [docs/EXTENDING.md](../../docs/EXTENDING.md).
