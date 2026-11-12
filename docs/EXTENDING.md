# Extending LumiAH

There are three ways to build on LumiAH. Take the shortest one that does what you need.

| Way | What you write | Good for |
| --- | --- | --- |
| [In the pages](#1-in-the-pages) | Nothing but words | An agent of your own, a skill, standing instructions |
| [An MCP server](#2-your-own-tools-as-an-mcp-server) | One small program | Tools that look something up or do something |
| [A package](#3-as-a-package) | A Lumiverse extension | Tools that need your extension's own state, shipping agents and skills to other people, pages of your own, answering some chats your own way |

This is written for someone who has built a Lumiverse extension and has not seen LumiAH. Every code block is taken from [`examples/`](../examples), and a test keeps it that way.

## What LumiAH is, in five lines

- A **main agent** works before each reply: it reads the prompt Lumiverse assembled, looks things up with **tools**, and hands a brief to the **writer**, which writes the reply.
- An **agent** is a definition: a name, instructions, the tools it holds, and what it runs with. The main agent can hand a task to another agent.
- A **skill** is a written procedure. An agent sees each skill's name and description, and loads the body when its work calls for it.
- A **tool** has a name, a description, a JSON Schema for its arguments, and a **tier**: `read` (changes nothing), `write` (changes what LumiAH keeps), `external` (acts outside LumiAH).
- Nothing runs a tool or calls a model on an agent's behalf. A tool runs when a model calls it.

## 1. In the pages

No code. Open LumiAH's drawer tab.

- **An agent** (**Agents → Agents**). Make one, or copy one and change it. Give it a description that says what to hand it (the main agent reads that when it chooses whom to delegate to), instructions, and the tools it needs. The main agent can then delegate to it, you can give it a job on **Jobs**, and you can ask it things on **Talk**.
- **A skill** (**Agents → Skills**). A name, a description that says when it applies, and a body: the steps. Agents load it themselves when their work matches the description.
- **Guidance** (**Story → Guidance**). Standing instructions every agent follows, at three levels: yours for every chat, the character's, and this chat's.

A definition of yours with the id of a built-in stands over it, and removing yours brings the original back.

## 2. Your own tools, as an MCP server

An MCP server is a program that lists tools and runs them. Lumiverse starts it and talks to it; LumiAH offers its tools to agents. You write no LumiAH code, and the same server works with any MCP client.

[`examples/mcp-tide-table`](../examples/mcp-tide-table) is one in a single file with no dependencies.

**Describe each tool.** A model chooses a tool by its description and writes the arguments from the schema:

```js
const TOOLS = [
  {
    name: "tide_table",
    description: "Greywater's tide table for a day: the times of high and low water, and what they mean for the ferry.",
    inputSchema: { type: "object", properties: { day: { type: "string", enum: ["today", "tomorrow"], description: "Which day." } }, required: ["day"], additionalProperties: false },
  },
];
```

**Answer a call with text.** When a call can't be answered, say what to do instead and mark it as an error, so the agent can try again:

```js
function callTool(name, args) {
  const row = name === "tide_table" && typeof args?.day === "string" && Object.hasOwn(TIDES, args.day) ? TIDES[args.day] : undefined;
  if (!row) return { content: [{ type: "text", text: 'Unknown tool or day. Call tide_table with day "today" or "tomorrow".' }], isError: true };
  return { content: [{ type: "text", text: `Greywater, ${args.day}. High water ${row.high.join(" and ")}; low water ${row.low.join(" and ")}. ${row.note}` }] };
}
```

**Speak the protocol.** One JSON-RPC message a line on stdin, one a line on stdout. Four methods are enough:

```js
function handle({ id, method, params }) {
  if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "greywater-tides", version: "1.0.0" } } });
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") return send({ jsonrpc: "2.0", id, result: callTool(params?.name, params?.arguments) });
  // A message without an id is a notification (`notifications/initialized`): it is answered with nothing.
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}
```

**Then, in Lumiverse:**

1. Add the server in Lumiverse's MCP server settings: transport stdio, command `bun` or `node`, one argument, the full path to the file.
2. Open **LumiAH → Agents → Tools** and switch the server on under *MCP servers*.

That is all. What follows from it:

- Each tool is named `mcp:<server>:<tool>`, here `mcp:greywater-tides:tide_table`, and is of the `external` tier.
- The main agent holds it from its next turn. It holds every tool you add; on the Agents page that is one tick-box you can clear. Another agent holds it once its own tools name it.
- Its calls run without asking. Switching the server on was your word. To approve each call, choose *Ask first* on the Tools page, for external tools or for the one tool.

## 3. As a package

LumiAH is also a package, `lumi-ah`. An extension of yours can build LumiAH into itself: it is then LumiAH under your extension's name, with what you add. Do this when a tool needs your extension's own state or Lumiverse's own data, when you want to ship agents and skills to other people, or when you want pages of your own beside LumiAH's.

[`examples/dice-tools`](../examples/dice-tools) is a complete one: a dice tool, an agent, a skill and a hook, in about a hundred lines.

The package has three entries you use:

| Entry | What it holds |
| --- | --- |
| `lumi-ah/extension/backend` | LumiAH's backend, to mount in yours |
| `lumi-ah/extension/frontend` | LumiAH's pages, to put in your drawer |
| `lumi-ah/core` | The types of what you supply, and a few helpers |

### The manifest

Your extension has its own identifier. Lumiverse keeps each extension's storage and records under its identifier, so a user can have LumiAH and your extension installed side by side. Ask for the permissions LumiAH's own `spindle.json` asks for: its backend is in your bundle.

```json
{
  "version": "0.1.0",
  "name": "Dice Tools",
  "identifier": "dice_tools",
```

### The build

```json
  "scripts": {
    "build": "bun build src/backend.ts --outfile dist/backend.js --target bun && bun build src/frontend.ts --outfile dist/frontend.js --target browser --minify",
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": {
    "lumi-ah": "github:TheLiquorPriest/LumiAH",
    "preact": "^11.0.1"
  },
```

### Mounting the backend

Your backend's entry makes LumiAH's backend over Lumiverse and hands it what you add. This is the whole file:

```ts
import { createBackend, createSpindleHost } from "lumi-ah/extension/backend";
import { diceTools, IDENTIFIER } from "./dice";

/** This build of the extension. A runtime linked to it says which build it is, and the Runtime page says when the two differ. */
const BUILD = "dice-tools-0.1.0";

const host = createSpindleHost(IDENTIFIER);
const backend = createBackend(
  host,
  {
    now: () => Date.now(),
    later: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    build: BUILD,
  },
  diceTools({ random: Math.random, log: (line) => host.log("info", line) }),
);

// The backend keeps no timer of its own: once a second it is asked to look at what waits on time alone.
setInterval(() => {
  backend.tick().catch((error: unknown) => host.log("warn", `[Dice Tools] the backend's tick failed: ${String(error)}`));
}, 1_000);
```

The third argument is everything of yours. It has four parts, all optional: `identity` (who you are in Lumiverse), `tools`, `extension` (definitions, a claim on chats, hooks), and `anchor`.

### A tool

A tool is what a model is offered, and a function that runs when a model calls it. First what the model is offered:

```ts
export const ROLL_DICE: RemoteTool = {
  name: "roll_dice",
  family: "dice",
  tier: "read",
  description: "Rolls dice and gives each die and the total. The dice are real: never make up a roll, call this.",
  parameters: { type: "object", properties: { dice: { type: "string", description: "What to roll: NdS with an optional +M or -M, such as 2d6+3 or d20." } }, required: ["dice"] },
  source: "extension",
};
```

Then where it is listed and run. `list` is asked at the start of every turn, so what you offer can differ by chat. `call` is given the arguments, which run made the call (`call.turn`, and `call.kind`: a turn, a job, a side session), the chat, and the agent. `call.main` says whether that agent is the run's main agent, and `call.above` lists the agents over it: go by those, never by the agent's definition, since a delegate may run as the same definition the run started with.

```ts
tools: {
  list: async () => [ROLL_DICE],
  // A call says which run and which agent made it. The answer is text for the model; an error says how to call it right.
  call: async (call) => {
    const line = typeof call.args.dice === "string" ? roll(call.args.dice, deps.random) : null;
    if (line === null) return { text: NOT_A_ROLL, error: true };
    rolled.set(call.turn, (rolled.get(call.turn) ?? 0) + 1);
    return { text: line };
  },
},
```

What to know:

- **Who holds it.** LumiAH's main agent holds every tool an extension adds, with nothing to set. Another agent holds it when its tools name it, by name or as `@dice` for the whole family.
- **The tier decides whether it asks.** As LumiAH ships no tier asks first; the user can have a tier, or one tool, ask. Say `external` for a tool that acts outside LumiAH, so that switch covers it.
- **The arguments are a model's.** Check them, and answer a wrong call with how to make a right one.
- **The answer is text.** Short and exact beats long: the agent reads it on every later call of the turn.
- **A long read can come whole.** An answer longer than *Tool results clipped past* (6,000 characters as shipped) reaches the model clipped, and the agent reads the rest with `scratch_read`, one round at a time. A tool whose whole purpose is to hand the model a long text it asked for, and which already bounds its answer by a setting of yours, names that bound as `wholeChars`: up to it the answer reaches the model whole; past it, it is clipped there, and `scratch_read` gives the rest as much at a time. Fill it from the user's setting each time `list` is asked, and say in that setting's help what it trades: fewer rounds against a larger prompt on every later call. Whatever the bound, an answer that would take the agent's next call past its *Prompt per call* is cut to the room left, and the model is told so in plain words.
- **A file it keeps is the agent's.** To keep a file in LumiAH's workspace from your tool, call `harness.workspace.writeAs({ chatId, area, path, text, base, by: { agentId, role }, turn, callId })` with `call.chatId`, `call.agentId`, `call.role`, `call.turn` and `call.callId` as the call was handed them (`area` is `chat`, `learned` or `user`; `base` is the version the text was based on, `null` for a new file). It is the write `workspace_write` makes: same limits, same refusals, recorded as that agent's, listed in what the reply changed and on the call in the live view. `harness.workspace.write` is the user's own write: don't use it for an agent. A file in the chat's own area can only be written while the call's run is under way.

### An agent

An agent definition is data. `newAgentSettings()` gives what a new agent runs with (connection, model, effort, budget); you add who it is and the tools it holds:

```ts
export const DICE_CLERK: AgentDefinition = {
  ...newAgentSettings(),
  id: "dice_clerk",
  name: "Dice clerk",
  description: "Settles something by dice: hand it what is at stake and the roll to make, and it rolls and says what came of it.",
  instructions: "You are the dice clerk of a roleplay chat. Another agent hands you something to settle by dice. Roll with roll_dice, once for each roll the task needs, and never state a number you didn't roll. Answer with each roll as the tool gave it and, in one line, what the result means for the task.",
  given: "task",
  tools: [ROLL_DICE.name, "skill_load"],
};
```

The description is what the main agent reads when it chooses whom to hand a task to. `given` says what the agent is handed: its `task` alone, or the whole `request` the turn answers as well.

A sub-agent is given the tools its definition names, and no more than the agent that started it holds. The main agent holds `roll_dice`, so the clerk gets it.

### A skill

```ts
export const CONTESTED_ROLL: Skill = {
  id: "contested_roll",
  name: "A contested roll",
  description: "How to settle two characters acting against each other with dice.",
  body: ["1. Say in a line what each side is trying to do.", "2. Roll d20 for each side with roll_dice, adding what the story gives that side (+2 for a clear advantage, -2 for a clear hindrance).", "3. The higher total has its way. On a tie, roll again.", "4. A margin of ten or more is decisive: say so, and what it costs the loser."].join("\n"),
};
```

Every agent that holds `skill_load` is told each skill's name and description, and loads the body when it needs it. No code decides when a skill applies.

Agents and skills are handed over together, read at the start of every run:

```ts
definitions: async () => ({ agents: [DICE_CLERK], skills: [CONTESTED_ROLL] }),
```

They are your defaults. On the pages they show as the extension's, and a user's own definition with the same id stands over yours.

A user who saves a version of your agent to change its model keeps that version until they reset it. To keep fields of your agent your own, name them in `owns` (`instructions`, `tools`, `name`, `description`): a user's version then takes them from your definition as it is at each run, keeps its own model and limits, and never stores them. Tools you own also stand over Settings: a tools value there for that agent is neither read nor stored. A skill marked `owned: true` is yours alone: a user's copy of it is not used. A skill may name the agents it is for (`agents: ["dice_clerk"]`); left out, every agent that holds `skill_load` is offered it.

To see what each agent can really use in a chat, call `backend.agents.held(userId, chatId)` on the backend `createBackend` returns: for each agent, the tools it holds, and each tool it names that it can't use, with why (`off`, `withdrawn` or `unknown`).

### The pages

The frontend's entry puts LumiAH's pages in a drawer tab under your name:

```ts
export function setup(ctx: SpindleFrontendContext): () => void {
  return lumiah(ctx, { id: "dice-tools", title: "Dice Tools", shortName: "Dice", description: "LumiAH's agents with real dice: switch them on for a chat, watch them work, and set them up" });
}
```

`lumiah` is `setup` from `lumi-ah/extension/frontend`. For pages of your own beside LumiAH's, the same entry exports `mountPages` (all the pages, or the ones you name, in a root you choose) and each page as a component.

### What `claim` is for

Dice Tools claims nothing, so LumiAH's own main agent answers every chat. An extension that wants some chats answered its own way supplies `claim`: it is asked about a chat at the start of every run, and answers `null` (not mine) or what it supplies there:

- `mainAgent`: the id of one of its agent definitions, which answers the chat in place of LumiAH's main agent.
- `guidance`: its own middle level of guidance for the chat (a world's, say), in place of the character's.
- `withdraw`: built-in tools no agent is offered in that chat.

Claiming a chat is also what lets a tool of yours stand in for a built-in: a tool that bears a built-in's name (`lore_search`) replaces it in the chats you claim, and nowhere else.

LumiAH's own tests hold a sample extension that claims chats and supplies one of everything: `test/runtime/mounting.test.ts`.

### Hooks on a turn

Three hooks, each optional: `runBegan` (before anything is sent to a model), `replyWritten` (the reply's text, whole), and `runEnded` (how it ended, what it spent, and the turn's record). A run is a turn, a job, or a side session's turn. Dice Tools counts its rolls and writes a line when a run that rolled ends:

```ts
runEnded: async (run) => {
  const rolls = rolled.get(run.turn);
  rolled.delete(run.turn);
  if (rolls !== undefined) deps.log(`[Dice Tools] ${rolls} ${rolls === 1 ? "roll" : "rolls"} in a ${run.kind} run of chat ${run.chatId} that ended ${run.status}`);
},
```

One more member, `writerRequest`, is handed the messages the writer is about to be sent, with the brief in place, and may return them rewritten: that is how an extension puts what it prepared where the user's preset expects it.

Every member is waited for a bounded time (a setting, ten seconds as it ships). A hook that is slow or throws never costs the user a reply: the run goes on without its answer.

### What your backend may rely on

Each member and each tool call is handed a `userId`, and most name a chat: `chatId` on a tool call and on every hook, the chat `claim` is asked about, the chat `list` and `definitions` are for.

- **The `userId` is the account the work is for.** Lumiverse said so; nothing a runtime sent decides it.
- **Every `chatId` you are handed is a chat of the `userId` you are handed it with.** A runtime's request that names another account's chat, or a chat that doesn't exist, is refused before your code runs. So a tool that reads the chat by its id reads the caller's own. An empty `chatId` (or `null`, for `definitions`) means the run is about no chat: a side session, say.
- **The chat `claim` is asked about is the chat as Lumiverse has it**: its name, its character and the chat it was branched from are read from Lumiverse for that call, never taken from the request.

Nothing else in what you are handed is checked for you. A tool call's `args` are a model's; the rest of a hook's argument (a turn's id, a reply's text, what a run spent) is the runtime's account of its own run. The runtime is the user's own program, so that account can only mislead its own user, but don't let it choose whose data you touch: key by `userId` and `chatId`, and look up anything else yourself.

### What an extension must not do

- **Don't call a model, run a tool or start a job for an agent.** Your tool runs when a model calls it. A hook hears what happened; it doesn't act in an agent's place.
- **Don't reuse LumiAH's identifier.** Your identifier is what keeps your storage, your records and your runtime apart from LumiAH's.
- **Don't name a tool after a built-in** unless you mean to replace that built-in in the chats you claim. Anywhere else the built-in stands and yours isn't offered.
- **Don't keep one user's state for all.** A backend serves every user of the Lumiverse. Each member and each tool call is handed the id of the user it is for; key what you keep by it.
- **Don't trust what a model sends.** A call's arguments are outside data, whatever your schema says.
- **Don't write LumiAH's records.** It keeps one on each reply it answers. If your extension keeps a record of its own on a message, supply `anchor` to say where LumiAH's sits inside yours.
- **Don't put in your backend what Lumiverse's install scan refuses.** LumiAH's code in your bundle reads no environment variable, evaluates no code and imports no `node:` module, and reaches Lumiverse only through the Spindle API. Hold your own code to the same.
- **Don't make the user wait on you.** Answer `list`, `definitions` and `claim` from memory where you can: they are asked on every run.

### Testing it

`test/examples/dice-tools.test.ts` mounts the example on a fake Lumiverse, links LumiAH's runtime to it, and plays a turn in which a scripted model calls `roll_dice`. Hand your dice (or your clock, or your store) in as the example does, and a test can say exactly what a turn does.

### The runtime

LumiAH runs a chat's turns built in, or in a runtime the user starts beside Lumiverse for turns that need longer. An extension with LumiAH built in gets both. The runtime is LumiAH's own program; it links to your extension by your identifier. [RUNTIME.md](RUNTIME.md), *Beside an extension that includes LumiAH*, covers it.
