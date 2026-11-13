# Extending LumiAH

There are three ways to build on LumiAH. Take the shortest one that does what you need.

| Way | What you write | Good for |
| --- | --- | --- |
| [In the pages](#1-in-the-pages) | Nothing but words | An agent of your own, a skill, standing instructions |
| [An MCP server](#2-your-own-tools-as-an-mcp-server) | One small program | Tools that look something up or do something |
| [A package](#3-as-a-package) | A Lumiverse extension | Tools that need your extension's own state, shipping agents and skills to other people, pages of your own, answering some chats your own way |

This is written for someone who has built a Lumiverse extension and has not seen LumiAH. Every code block is taken from [`examples/`](../examples), and a test keeps it that way.

## What LumiAH is, in five lines

- A **main agent** works before each reply, in LumiAH's runtime beside Lumiverse: it reads the prompt Lumiverse assembled, looks things up with **tools**, and hands a brief to the **writer**, which writes the reply.
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

LumiAH is also a package, `lumi-ah`. An extension of yours can build LumiAH into itself: it is then LumiAH under your extension's name, with what you add. It ships LumiAH's runtime too, which its users start beside Lumiverse as LumiAH's users start LumiAH's. Do this when a tool needs your extension's own state or Lumiverse's own data, when you want to ship agents and skills to other people, or when you want pages of your own beside LumiAH's.

[`examples/dice-tools`](../examples/dice-tools) is a complete one: a dice tool, an agent, a skill, a hook, and the build that ships the runtime, in about a hundred and seventy lines.

The package has three entries you use:

| Entry | What it holds |
| --- | --- |
| `lumi-ah/extension/backend` | LumiAH's backend, to mount in yours |
| `lumi-ah/extension/frontend` | LumiAH's pages, to put in your drawer |
| `lumi-ah/core` | The types of what you supply, and a few helpers |

Your build also bundles one file of it: `src/runtime/main.ts`, LumiAH's runtime.

### The manifest

Your extension has its own identifier. Lumiverse keeps each extension's storage and records under its identifier, so a user can have LumiAH and your extension installed side by side, each with a runtime of its own. Ask for the permissions LumiAH's own `spindle.json` asks for: its backend is in your bundle, and it can't answer a chat without `interceptor`, `chats`, `generation`, `chat_mutation` and `generation_parameters`. Ask for `cors_proxy` too: with it, your pages and your tools' asks reach a runtime on Lumiverse's own machine through Lumiverse's proxy, not behind the link's traffic. Only an owner or an admin can grant it, and an update never does, so tell your users where to; without it everything works over the link.

```json
{
  "version": "0.1.0",
  "name": "Dice Tools",
  "identifier": "dice_tools",
```

### The build

Your build makes three bundles, as LumiAH's own does: LumiAH's runtime, your backend and your frontend. The runtime comes first, bundled from the package's own source. It carries LumiAH's model layer, pi-ai, which `lumi-ah` keeps among its development dependencies, so your `package.json` pins it as LumiAH does:

```json
  "scripts": {
    "build": "bun build.ts",
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": {
    "lumi-ah": "github:TheLiquorPriest/LumiAH#staging",
    "preact": "^11.0.1"
  },
  "devDependencies": {
    "@earendil-works/pi-ai": "1.5.2",
```

Then your backend, with the runtime's sha256 and size put in: your backend offers that file to a runtime of yours that says hello on another build, and the runtime updates itself from it. Every constant goes in when the bundle is made, never read at run time, since Lumiverse's install scan refuses a backend that reads the environment. The runtime's bundle needs one flag of its own, `--ignore-dce-annotations`: without it Bun's bundler leaves some modules of the runtime's model library unstarted, and the runtime fails at the end of an agent's session:

```ts
bundle("node_modules/lumi-ah/src/runtime/main.ts", "dist/lumiah.js", "bun", { LAH_BUILD_ID: BUILD }, ["--ignore-dce-annotations"]);
// It must start under the Bun that built it.
if (Bun.spawnSync([process.execPath, "dist/lumiah.js", "--version"]).exitCode !== 0) throw new Error("build: dist/lumiah.js doesn't start");
const runtime = readFileSync("dist/lumiah.js");
bundle("src/backend.ts", "dist/backend.js", "bun", { LAH_BUILD_ID: BUILD, LAH_RUNTIME_SHA256: createHash("sha256").update(runtime).digest("hex"), LAH_RUNTIME_SIZE: String(runtime.length) });
bundle("src/frontend.ts", "dist/frontend.js", "browser", {}, ["--minify"]);
```

`dist/lumiah.js` sits beside `dist/backend.js`: that is where your Runtime page's lines look for it.

A bundle holds the same code wherever it is built, so no bundle may take a file from outside your repository. Bun takes a package from any `node_modules` above the folder it builds in when it doesn't find it inside, and the runtime asks for one your folder leaves uninstalled on purpose: `supports-color`, which a library under the runtime's Google SDK asks for only to colour its own debug lines, and does without. So the build keeps it out of every bundle, lists each bundle's inputs, and fails when one lies outside the folder, as LumiAH's own build does:

```ts
function bundle(entry: string, out: string, target: "bun" | "browser", constants: Record<string, string>, flags: string[] = []): void {
  const defines = Object.entries(constants).flatMap(([name, value]) => ["--define", `process.env.${name}=${JSON.stringify(value)}`]);
  const left = LEFT_OUT.flatMap((name) => ["--external", name]);
  const meta = `${out}.meta.json`;
  const run = Bun.spawnSync([process.execPath, "build", entry, "--outfile", out, "--target", target, ...flags, ...left, `--metafile=${meta}`, ...defines], { stdout: "inherit", stderr: "inherit" });
  if (run.exitCode !== 0) throw new Error(`build: ${entry} failed`);
  const inputs = Object.keys(JSON.parse(readFileSync(meta, "utf8")).inputs as Record<string, unknown>);
  rmSync(meta);
  const outside = inputs.filter((path) => {
    const from = relative(".", resolve(path));
    return from.startsWith("..") || isAbsolute(from);
  });
  if (outside.length > 0) throw new Error(`build: ${out} took ${outside.join(", ")} from outside this folder: install it here, or add it to LEFT_OUT if nothing needs it`);
}
```

### Mounting the backend

Your backend's entry makes LumiAH's backend over Lumiverse and hands it what you add. This is the whole file:

```ts
import { createBackend, createSpindleHost } from "lumi-ah/extension/backend";
import { diceTools, IDENTIFIER } from "./dice";

/** This build of the extension (`build.ts` puts it in). A runtime linked to it says which build it is, and the Runtime page says when the two differ. */
const BUILD: string = process.env.LAH_BUILD_ID ?? "dev";

/** The runtime this build ships beside its backend (`dist/lumiah.js`): its sha256 and size, which `build.ts` puts in. A runtime on another build is offered that file, and updates itself from it. */
const RUNTIME = { sha256: process.env.LAH_RUNTIME_SHA256 ?? "", size: Number(process.env.LAH_RUNTIME_SIZE ?? "0") };

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
    runtime: RUNTIME,
  },
  diceTools({ random: Math.random, log: (line) => host.log("info", line) }),
);

// The backend keeps no timer of its own: once a second it is asked to look at what waits on time alone.
setInterval(() => {
  backend.tick().catch((error: unknown) => host.log("warn", `[Dice Tools] the backend's tick failed: ${String(error)}`));
}, 1_000);
```

The second argument is the clock and the build, and the runtime your build ships (`runtime`: its sha256 and size). Without `runtime`, your users' runtimes don't update themselves: the Runtime page shows the line that updates one by hand.

The third argument is everything of yours, all of it optional: `identity` (who you are in Lumiverse), `tools`, `extension` (definitions, a claim on chats, hooks) and `anchor`; and these choices: `declined` (the permissions your manifest doesn't ask for, which LumiAH's pages then never bring up), `ownSwitch` (your own pages switch a chat on and off: LumiAH's pages then offer no switch and say where it is), `withoutAgents` (built-in agents you leave out), `ownElsewhere` (you keep LumiAH's record of a message somewhere other than on the message, as a ledger: a reader of a chat's records and a way to say they changed, which the runtime's copy of the chat reads and hears) and `declinesLore` (you give LumiAH no lore, so the runtime's copy keeps none either).

With `ownElsewhere`, call the listeners LumiAH hands its `onChanged` (with the chat's id and its user) wherever your records of a chat change: in your `setOwn`, when Lumiverse says a chat changed, and on your own pages' edits too. Each call has LumiAH's backend and the runtime's copy both read that chat's records again; one you leave out leaves them on the old records until they read the chat again for some other reason.

Two more details. `identity.settingsAt` says where your users find LumiAH's Settings when that isn't "<your name>'s Settings" (LumiRPEngine: "LumiRPEngine's Harness tab → System → Settings"): every timeout's words, the runtime's own included, then name that place and its Timeouts page. And where your `anchor` keeps LumiAH's record in one of LumiAH's own forms, say so in it (`reads: { under: null }` for the record as the entry itself, `{ under: key }` for a member of it), so the runtime reads a chat's records from its own copy; without it, the runtime asks your backend for a chat's path every time.

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
- **A long read can come whole.** An answer longer than *Tool results clipped past* (12,000 characters as shipped) reaches the model clipped, and the agent reads the rest with `scratch_read`, one round at a time. A tool whose whole purpose is to hand the model a long text it asked for, and which already bounds its answer by a setting of yours, names that bound as `wholeChars`: up to it the answer reaches the model whole; past it, it is clipped there, and `scratch_read` gives the rest as much at a time. Fill it from the user's setting each time `list` is asked, and say in that setting's help what it trades: fewer rounds against a larger prompt on every later call. Whatever the bound, an answer that would take the agent's next call past its *Prompt per call* is cut to the room left, and the model is told so in plain words.
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

- `mainAgent`: the id of one of its agent definitions, which leads the chat's replies in place of LumiAH's main agent.
- `guidance`: its own middle level of guidance for the chat (a world's, say), in place of the character's.
- `withdraw`: built-in tools no agent is offered in that chat.
- `reply`: `"released"` where the reply is only what your agents release (*The reply your agents release*, below): no writer writes it.
- `replyTool`: `reply_write`'s own description and arguments in your chats (below).

Claiming a chat is also what lets a tool of yours stand in for a built-in: a tool that bears a built-in's name (`lore_search`) replaces it in the chats you claim, and nowhere else.

Nothing stands in for what your claim needs. Who leads a reply is settled before anything is sent to a model:

- **The agent you name must be there.** Where it isn't (you supply no definition of that id, the user switched it off, or your `definitions` gave no answer within *Wait for the extension* or threw), the reply doesn't start: no model is called, and the user is told your name, the agent, why it can't run, and what to do. LumiAH's own main agent never answers in its place.
- **Your `claim` must answer.** Where it gives no answer in time or throws, nobody knows whether you claim the chat, so no run about that chat starts: not a reply, not a job's run, not a conversation's turn. Answered as one of LumiAH's own chats, it could be answered wrongly.
- **Your `definitions` are needed only where something names them.** A run that needs none of your agents goes on without them, and its live view says your agents and skills are missing, and why; a job or a conversation whose agent is yours fails with that, and can be started again.

Answer both well inside the wait: ten seconds as LumiAH ships, a setting the user may change. Both are asked together at the start of every run, and also, `claim`, whenever the Agents page shows with one of your chats open, so it must be safe to answer outside a run. The Agents page marks the agent your claim names as the one that leads the chat's replies, and LumiAH's Main agent (and the Writer, where your claim says `reply: "released"`) as taking no part in them.

LumiAH's own tests hold a sample extension that claims chats and supplies one of everything: `test/runtime/mounting.test.ts`.

### The reply your agents release

In a chat your claim marks `reply: "released"`, no writer writes the reply. Your agent that leads (and any agent of yours whose definition names `reply_write`) releases it itself with `reply_write`, or hands it to another agent with `delegate` and `to_reply`, whose answer streams into the chat as it is written.

- **A turn's reply is released once, whole.** The first release that sends text is the reply. A second, of either kind, is refused in words that tell the agent to finish its turn, and nothing more reaches the chat. Write your agents' instructions so that they work out the whole reply, then release it in one call. A release that sent nothing (your `releasing` kept it back or gave no usable word, or a handed-on answer ended before any of it streamed) leaves the turn's release still to come; one asked for while a handed-on answer holds the reply with nothing out yet is told to wait for it. A handed-on agent's answer reaches the chat only while that `delegate` call is under way: what it says to a later `agent_message` is for the agent that asked.
- **`releasing` is asked before a `reply_write` goes out**, with the call's arguments as the agent gave them (`release.args`; `release.text` is the text the call carries). Answer `{ refused }` to keep it back (your words are the agent's answer), `{ text }` to send that in place of what the call carried, or `null` to let the call's own text go. A throw, no answer within *Wait for the extension*, or anything else lets nothing go, and the agent is told so; where the wait ran out, the words name it and where it is changed.
- **`released` hears the release** once it went out: `release.text` is what reached the user, `release.args` the call's arguments (`{}` for a handed-on answer, which `releasing` is never asked about, and for what `unreleased` gave). It is heard once a turn at most.
- **`unreleased` keeps ready work from being lost.** Where your agent that leads ends with none of the reply released (it answered, one of its limits stopped it, a call failed: `ended` says which), the core asks it once for what your agents had ready, and never once the user stopped the turn. An agent the lead handed the reply on to that is still ending is let end first, for no longer than *Wait for the extension*: what it sent is the reply, and one that hasn't ended by then leaves nothing to ask about. Answer `{ text }` (what your checks passed, joined as the reply should read) and that goes out as the turn's reply, `released` hears it, and the turn ends with a reply, its live view and record still saying how the lead ended. Answer `null` and the turn fails as it would without the member.
- **`replyTool` gives `reply_write` arguments of your own.** With it in your claim, your agents are offered `reply_write` with your description and your arguments (a JSON Schema whose `type` is `object`) in place of its one `text`: they name what goes out your way, and your `releasing` answers with the `{ text }` that goes out. With your tool only a text lets anything go. So nothing is typed out twice: an agent of yours drafts a piece once, and the agent that leads releases it by its number. A claim of `{ mainAgent: "author", reply: "released", replyTool: { description: "Release the reply: the drafts you name, in order.", parameters: { type: "object", properties: { drafts: { type: "array", items: { type: "integer" } } }, required: ["drafts"] } } }` is answered by a `releasing` that joins the drafts `release.args.drafts` names into `{ text }`, or refuses in words that name the draft and why. A reply tool with no description, with arguments that are no such schema, or from an extension with no `releasing`, isn't offered: `reply_write` takes its `text`, and the log says why. Where a later hello leaves `releasing` out while a run that was offered your tool goes on, nothing goes, and the agent is told so.

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

Every member is waited for a bounded time (a setting, ten seconds as it ships). A hook that is slow or throws never costs the user a reply: the run goes on without its answer. `claim`, and `definitions` where your claim's lead needs them, are the exceptions above.

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
- **Don't put in your backend what Lumiverse's install scan refuses.** LumiAH's code in your bundle reads no environment variable, evaluates no code and imports no `node:` module, and reaches Lumiverse only through the Spindle API. Hold your own code to the same. A constant your build puts in (`--define`, as `build.ts` does) is replaced in the bundle, not read.
- **Don't make the user wait on you.** Answer `list`, `definitions` and `claim` from memory where you can: they are asked on every run.

### Testing it

`test/examples/dice-tools.test.ts` mounts the example on a fake Lumiverse, links LumiAH's runtime to it, and plays a turn in which a scripted model calls `roll_dice`. Hand your dice (or your clock, or your store) in as the example does, and a test can say exactly what a turn does.

### The runtime

Every chat LumiAH answers runs in its runtime: the agents, their tools and jobs, and their model calls, which go from it to the user's providers on connections it keeps itself. The user starts it once beside Lumiverse with the line your Runtime page shows, which names your identifier (`--extension`); it links to your extension by it, and updates itself from your `dist/lumiah.js` each time your extension is updated. [RUNTIME.md](RUNTIME.md), *Beside an extension that includes LumiAH*, covers the user's side.

An agent runs on the runtime's connections. `agentModel` (asked as each agent starts) names one by its id, as the runtime's Connections section shows it; one the runtime doesn't have leaves the agent on the runtime's default. For a page of your own that picks an agent's connection, `lumi-ah/extension/frontend` gives the runtime's connections as a page knows them (`useRuntimeConnections(chatId)`: the connections of the runtime that plays that chat, else of the runtime heard from last), the section itself (`ConnectionsSection`), the notice Home and Live show while there is none (`ConnectionsWanted({ chatId })`, `leadToConnections`), and a picker's words (`pickerLabel`, `whoseWords`, `goneWords`, `noneWords`, `unlistedWords`, `modelsConnection`).

### Coming from LumiAH's `main` branch

`main` still runs a chat inside Lumiverse when the user asks (built-in mode). This branch doesn't: every chat runs in the runtime, the agents call their models from it on its own connections, and the runtime updates itself. What an extension built on `main` changes:

- **`place: "runtime"`** in `createBackend`'s options is gone: every chat plays only in the runtime. Pass `ownSwitch: true` where your own pages switch chats on; the Runtime page then names you (`RuntimeView.switchedBy`, which replaces `RuntimeView.only`).
- **`ChatClaim.place`** is gone: leave it out of your claim.
- **`Backend.builtin`** (`stop`, `runs`) is gone. Stop a run with the page request `lah.turn.stop`; there are no runs but the runtime's.
- **`ChatView.place`** and **`ChatView.needsRuntime`** are gone. Whether a chat is answered is `chatAnswered(chat)` from `lumi-ah/shared`: it is when it generates on the loopback (`chat.connection?.loopback === true`), switched on or not, so a switched-off chat the user pinned to the loopback by hand is answered too. `lah.chat.set` takes `{ chatId, on }`; a `place` sent with it is passed over.
- **Gone from `lumi-ah/shared`:** `RunPlace`, `NoPart`, `NoPartWhy`; the `place` and `replyBy` of `LiveView`, `RunningTurn` and `LastTurn`; the `place`, `noPart` and `recovered` of `TurnRow`; the causes `skipped` and `time`. A turn's record carries no `ran`.
- **`generation_parameters`** is a permission LumiAH can't do without: ask for it in your manifest.
- **`BackendEnv.runtime`** (`{ sha256, size }`) is new: pass what your build puts in, as above.
- **A host of your own** (most extensions take `createSpindleHost`, which has all of it) now gives `cors` (a request through Lumiverse's proxy), `role` (a user's role in Lumiverse), `database` (Lumiverse's database file, or null), `frontend.everyone(message)` (every page and runtime of the extension: Spindle's `sendToFrontend`) and `events.onLumiverse` (Lumiverse's events about chats and world books, for the runtime's copy); it no longer gives `interceptorMs`, `models` or `connections.models`.
- **New options:** `ownElsewhere`, `declinesLore`, `identity.settingsAt` and `AnchorCodec.reads` (above). An extension that keeps LumiAH's records elsewhere and declines lore, as LumiRPEngine does, passes the first two.
- **`agentModel`** names the runtime's connections by id, not Lumiverse's.
- **`lah.models.list`** is gone: a picker asks `lah.connections.models`. New page requests: `lah.connections.list`, `.save`, `.remove`, `.default`, `.test`, `.models` and `lah.signin.start`, `.finish`, `.cancel`, `.out`, `.state` (each with `relay` to name one of the user's runtimes, else the runtime heard from last); `lah.connections.lumiverse`; `lah.runtime.service.get`, `.set`, `lah.runtime.update.apply`, `lah.runtime.store` and `lah.runtime.chatdata` (each with `relay`); `lah.runtime.database` (the operator's switch of the database reader); `lah.timings.get`. `backend.asks.ask` takes `{ relay }` the same way.
- **The link's version is 2.** A runtime and a backend of different link versions refuse each other at hello; one built from the same `lumi-ah` as your backend, as *The build* makes it, always agrees with it.
- **Your build** bundles the runtime with `--ignore-dce-annotations`, puts its sha256 and size into your backend, and takes no file from outside your repository (*The build*).
- **A runtime run from your own entry.** One that calls `lumiah` or `serve` from `lumi-ah/runtime` with a `RuntimeIO` of its own (as `src/runtime/main.ts` makes LumiAH's) now gives it `updateFiles`, `handOver` and `pid`, a `files.folder`, and a `run` that takes a time limit and finds programs in the system's own folders; its `harness` is handed a fourth argument, `place` (where the user changes one of the core's settings), to pass to `createHarness` as `HarnessOptions.place`, so the core's waits that run out (*Wait for the extension* among them) name where they are changed. One that calls `createRuntime` itself passes `models` (`createModelLayer`), `dir` (the runtime's own folder, its owner's alone) and `update` (a function that gives `createUpdate(…)` for what says something is under way), and awaits `close()`, which now returns a promise. A runtime bundled from `src/runtime/main.ts`, as *The build* does, needs none of this.
- **One release a turn.** A turn's reply is released once, whole: where each `reply_write` used to add a piece, a second `reply_write`, or a `delegate` with `to_reply` after the reply went out, is now refused. Rewrite any of your agents' texts that release a reply in pieces. `ReplyRelease` carries the call's `args`, `ReleaseVerdict` may be `{ text }`, a claim may carry `replyTool`, and a new member, `unreleased` (`ReplyUnreleased`), gives what your agents had ready where the lead released nothing (*The reply your agents release*). The core's `ReplyStream` takes the call's arguments (`write(args, ctx)`) and carries your reply tool (`tool`); its `length` and `stream` are gone, and its `hold` gives a `ReplyHand` (`stream`, then `end`), after which nothing streams. A sub-agent's answer now comes back under the line that names its handle, where that line used to end it. Over the link, the core is offered only the members your extension has, as beside it in one process.
