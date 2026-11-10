# LumiAH design

LumiAH is an agent harness for Lumiverse. A main agent works in a loop with tools, sub-agents, sessions, a workspace and guidance files, and answers Lumiverse's main generation through a loopback connection. This document is the contract the code is built to. Where the code and this document disagree, one of them is wrong and gets fixed.

**What is built:** §1 to §8. §11 to §21 are the contract for what is being built next; a section moves into this line when its code and tests are in.

## 1. Parts and where they run

| Part | Source | Runs | Owns |
|---|---|---|---|
| Core | `src/core/` | Anywhere: it reaches the outside only through ports | The agent loop, the provider session, budgets, sessions and compaction, the tool, agent and skill registries, the workspace, jobs, the trace |
| Link | `src/link/` | Both ends | The contract between the runtime and the extension backend: envelopes, requests, pushes, versions |
| Runtime | `src/runtime/` | Its own process beside Lumiverse (`dist/lumiah.js`, under Bun) | The loopback endpoint Lumiverse calls, the link's client end, the core's ports implemented over the link, the turn |
| Extension backend | `src/extension/backend/` | Lumiverse's extension worker (`dist/backend.js`) | The link's server end, tagging, model calls on the user's connections, storage, chat, lore and preset access, anchors, settings, the live buffer |
| Extension frontend | `src/extension/frontend/` | The browser (`dist/frontend.js`) | All UI |
| Shared | `src/shared/` | Backend and frontend | The messages between the two, and types both read |

Rules that keep the boundary:
- **Core imports nothing outside `src/core/`.** No Lumiverse type, no Spindle call, no Node or Bun API beyond what both a worker and a process have (`crypto.subtle`, `AbortController`, timers). A test enforces it.
- **Only `src/extension/backend/spindle.ts` touches the `spindle` global.** Everything else in the backend talks to an interface it implements, so tests run against a fake.
- **The extension backend's bundle must pass Lumiverse's install scan:** no `eval`, no `Function(`, no `process.env`, no `node:` import, no `Buffer.from(…, "base64")`, no `fetch`, no `Bun.serve`. The runtime is an ordinary process and has no such limit.
- **Another extension uses LumiAH as a package.** It bundles the backend and frontend pieces into its own extension, loads its own definitions into the runtime, and registers its tools, agents, skills and guidance. LumiAH imports nothing from any extension that uses it.

## 2. One reply

1. The user sends a message in a chat whose connection is the loopback.
2. Lumiverse assembles the prompt from the active preset. The extension's prompt interceptor runs last, tags the generation with a single-use token tied to the chat and the generation, and leaves out the messages the user's history cutoff hides.
3. Lumiverse calls the loopback connection: `POST /v1/chat/completions` on the runtime, with the assembled messages, the sampling parameters and the tag.
4. The runtime checks the tag with the extension, which answers with the turn: the user, the chat, the generation and what kind it is (new reply, regenerate, swipe, continue), and the message it targets.
5. The runtime resumes the chat's session from the anchor on the chat's active path (§5) and runs the main agent (§3).
6. While the main agent works, its steps go to the reply's thinking block as progress lines and to the live session view in full.
7. The reply is written (§3.2) and streamed back to Lumiverse as the completion.
8. The runtime hands the turn's record to the extension, which writes the anchor on the reply's message once Lumiverse has saved it.

A request with no tag is not a turn. The runtime passes it through to the writer's connection unchanged, so a feature of Lumiverse that happens to use the loopback connection still works.

LumiAH answers only generations that reach the loopback connection. A chat on any other connection is untouched.

## 3. The main agent and the writer

### 3.1 The main agent
One continuous session per chat. It decides its own steps: there are no stages, and no code calls a tool or a model on its behalf. Each turn it is given:
- its instructions (an editable text) and the guidance files that apply;
- what it carries from earlier turns: the last compaction summary, and a receipt for each turn since;
- the request: the messages Lumiverse assembled, as a document it reads, with the preset's instruction blocks marked as the instructions the reply must achieve.

It works with tools until it has what the reply needs, then calls `write_reply` with a brief.

### 3.2 The writer
By default a separate agent writes the prose. Its call is Lumiverse's assembled messages as they came, with the main agent's brief inserted, the request's own sampling parameters, and no tools. Its answer streams to Lumiverse as the reply. So the user's preset governs the prose exactly as it does without LumiAH.

Who writes is a setting. The main agent may write the reply itself: then its final answer is the reply, and there is no second call.

### 3.3 Everything here is a default
The main agent's and the writer's instructions, tools, connection, model, effort and budgets are settings the user can change. Every text sent to a model has an id and can be replaced by the user. Every limit is a setting with a default. A fixed value in the code needs a comment that says why it can't be a setting.

## 4. Core

### 4.1 The loop
`startAgent(spec, deps)` returns a handle; `send(text)` runs the loop: call the model, run the tools it calls (as many at once as its budget allows), send the results back, until it answers or a limit stops it. It keeps:
- native tool calls, with a fallback that offers the tools as text when a connection refuses them, and recovery of tool calls a model writes as text;
- budgets per call, per agent and per turn (tokens in and out, rounds, time, revisions);
- a loop detector for the same call made on the same state several times running;
- clipping of long tool results, with the whole kept for `scratch_read`;
- reasoning carried across tool calls where the provider needs it;
- cache breakpoints on a stable prefix;
- request and token throttles per connection.

A tool is `{ name, description, parameters, state?, run(args, ctx) }`, with `parameters` a hand-written JSON Schema. Its outcome is `{ text, error?, end? }`; `end` finishes the send with that text.

### 4.2 Ports
Core reaches the world through one object, the host:

| Port | What it gives |
|---|---|
| `models` | One model call: messages (text, tool calls and tool results as parts), tools, effort, sampling parameters, a signal; the answer with its tool calls, reasoning and usage. Deltas as they arrive, for a call that streams |
| `connections` | The user's connections: which exist, each one's provider and model, and what the loop must know about it (cache breakpoints, whether it takes parallel tool calls) |
| `blobs` | Text stored once by its hash |
| `store` | Small JSON documents by path, written whole |
| `chat` | The chat's active path with each message's anchor; messages by range; an anchor written on a message |
| `lore` | The world books that apply to a chat, their entries, and the entries Lumiverse activated for this generation |
| `preset` | The active preset's blocks, in order, each with its role and whether it is an instruction or a marker |
| `trace` | Where every step of every agent goes |
| `clock`, `log` | Time and diagnostics |

The runtime implements the host over the link. Tests implement it in memory.

### 4.3 Base tools
Search, grep and read over the chat; an index, search, grep and read over lore; the preset's instruction blocks; the lore activated for this turn; `past_turn` for an earlier turn's work in full; `scratch_read`; `write_reply`. Later: workspace tools, delegation, scheduling, summarize, MCP tools.

Tool results follow one set of conventions: results are paged with a cursor, a search says how many it found and how many it shows, an error says what to do next, and nothing returns more than its limit setting allows.

## 5. Sessions and anchors

A session is the main agent's working memory across turns: what it was told, what it called, what came back, what it concluded. The chat's own messages are not copied into it; Lumiverse sends those with every request.

- **Each turn ends with a record** on the reply's message, in that message's extension metadata under LumiAH's key, one per swipe: the hash of the turn's session segment, of a compaction summary when one was made, of the turn's transcript, and a path hash chained over the messages before it.
- **Bodies are blobs,** stored once by hash and never changed.
- **The session at a turn** is read by walking the chat's active path back to the latest record with a summary, then taking the segments after it. A swipe, a regenerate, an edit and a branch therefore need no bookkeeping: whatever path is active is the one that is read.
- **A record whose path hash no longer matches** the messages before it (an earlier message was edited or deleted) is off the path. It is not used, and the main agent is told its notes from that point were dropped.
- **Compaction** runs when the session passes its token setting: the span is summarized, the summary lands with the turn's record, and the replaced span is kept so a rollback can restore it.
- **An extension with its own per-message record** supplies the anchor itself, so a turn has one record and not two.

## 6. Link

The runtime is a client of Lumiverse like any other: it signs in as the user, finds the extension, opens the event socket, and sends the extension enveloped requests, each answered by its id. The extension pushes to the runtime's session.

- **Versioned.** Both ends say their link version in `hello`; a mismatch is refused in plain words that name which side to update.
- **Three secrets, three jobs.** The runtime's Lumiverse session lets it reach the extension. The relay secret, minted when the runtime registers, proves a request comes from that runtime. The loopback key, which the user puts in the connection, proves a completion request comes from that user's Lumiverse. The extension stores only hashes of the last two.
- **Streams are numbered.** A reply or a model call's deltas arrive as chunks numbered from 1, acknowledged in batches, and asked for again after a gap.
- **The runtime asks, the extension answers:** check a tag and begin a turn; make a model call, or pass an untagged request through; read and write blobs, documents and anchors (a turn's own record on commit, and a record rewritten later, as a rollback does); read the chat, lore, the preset and the connections; read the settings; push trace events; commit a turn; say what became of a connection it was asked to make.
- **The extension tells the runtime:** stop a turn; settings changed; a new relay secret, when the user rotates it on the Runtime page; and a loopback key to put in the user's loopback connection, making the connection when there is none. Spindle gives an extension no way to make a connection, so the runtime does it with its own Lumiverse session, says what it did, and never keeps the key.

## 7. Extension backend

- Registers the prompt interceptor that tags turns, at the highest priority, so it sees the prompt as it will be sent.
- Serves the link.
- Makes each model call the runtime asks for through Lumiverse's generation API on the connection named, streaming, and reports usage as the provider gave it.
- Writes each turn's anchor when Lumiverse saves the reply.
- Keeps the live buffer: the current turn's trace for each chat, sent to every page that has that chat's live view open.
- Keeps settings and the user's texts in user storage.

## 8. Frontend

One drawer tab. Every surface works at phone width (360 px) and uses the room on a desktop; no control depends on hover; touch targets are at least 42 px on a coarse pointer.

- **Live:** the session view. The main agent and every other agent as they run: what each was told, each answer with its thinking where the model gives it, each tool call with its arguments and result, each stop. Tokens, time and cost per call, agent and turn. The exact prompt of any call. Stop. Search, filter, copy and export.
- **Sessions:** a chat's turns, each with its transcript; compaction points; rollback.
- **Settings:** agents (connection, model, effort, budgets, tools), every text, the history cutoff, who writes the reply.
- **Runtime:** whether the runtime is linked and which build it is; first-time setup, step by step; the loopback key; which chats LumiAH answers.

## 9. Conventions

- TypeScript, strict. No `any` without a comment that says why.
- JSON Schemas are written by hand. No schema library.
- A comment says why, not what.
- Prompts are texts with ids in one place per area, never string literals at a call site.
- Tests are `bun:test`, beside nothing: they live under `test/`, mirroring `src/`. A test checks behaviour a user or a caller would notice. Fixtures are synthetic.
- No file under `src/` knows about a particular extension that uses LumiAH.

## 10. Credits
See `NOTICE`.

## 11. The workspace

The workspace is the agents' only file system: markdown and other text files they keep for themselves and for each other.

- **Three areas.**
  - The chat's area (`/`) follows the story path, like the session.
  - `learned/` is kept with the chat itself: a swipe or an edit never changes it, and a branch copies it.
  - `~/` is the user's own area, shared by all their chats.
- **Storage.** A file's body is a blob. An area is an index: path to hash, size, when it was last written and by whom (an agent's id, a job's, or the user).
- **Anchoring.** Each turn's record holds the hash of the chat area's index as it stood when the turn ended. The chat area at a turn is the index of the latest record on the active path, plus what jobs on that path wrote since (§15).
- **Versioned writes.** A write or an edit names the hash of the version it was based on, or says the file is new. A mismatch is refused with the current hash, so the agent reads again. That is what lets the main agent, sub-agents and jobs work on the same files.
- **History.** The difference between two records' indexes is a turn's change set. The page shows a file's history, compares two versions and restores one.
- **Tools.** `workspace_list`, `workspace_read`, `workspace_grep`, `workspace_write`, `workspace_edit` (replace an exact match), `workspace_move`, `workspace_delete`, `workspace_pin` (a pinned file is put in the agent's context each turn, under a size setting).
- **Bounds.** A path is checked and normalized; one that leaves its area is refused. Nothing reaches the host's disk. File size, file count and total size have settings.
- **The user** reads and edits every file on the page. A user's edit is a versioned write like any other, recorded as the user's.

## 12. Guidance

A guidance file is markdown an agent is given as part of its instructions, every turn.

- **Three levels:** the user's (`~/GUIDANCE.md`), a middle level (for a plain chat, the character's; an extension may name its own, such as a world's), and the chat's (`learned/GUIDANCE.md`).
- **Loaded** into every agent's system prompt in that order, under a size setting, with each level named so an agent knows whose words they are.
- **Edited** by the user on the page. An agent may edit the chat's level when a setting allows.

## 13. Agents, skills and tools as definitions

- **An agent definition:** id, name, description (what a delegating agent reads when choosing), instructions, tools (by name or family), connection, model, effort, budgets, and what it is given (the whole request, or only its task).
- **A skill:** id, name, description and a markdown body: a procedure an agent may follow. An agent's prompt lists the skills it may load, by name and description; `skill_load` returns a body. Nothing in the code decides when a skill applies.
- **A tool:** name, family, tier (read, write or external), description, parameters, and where it runs: in the runtime, or in the extension over the link (`tool.call`), which is how an extension's own tools and MCP tools run.
- **Three sources for each:** built in, an extension's, the user's. A user's definition with the id of a built-in or an extension's overrides it, and a reset restores the original. The user makes, copies, edits, switches off and deletes definitions on the page.
- **The registry** the runtime uses for a turn is the merge of the three, read at the turn's start.

## 14. Delegation

- `delegate({agent, task, files?})` starts a registered agent as a sub-agent with its own session. Its answer is the tool's result. Several calls in one round run at once, under a setting.
- **The handle lives until the turn ends:** `agent_message({handle, text})` continues that agent, under a revision cap.
- **A depth setting** decides whether a sub-agent may delegate.
- **A sub-agent's writes** are its own versioned writes. Its tools are its definition's, never more than the agent that started it may grant.
- Every sub-agent's session appears in the live view under the agent that started it, and is kept with the turn's transcript.

## 15. Jobs

A job is an agent run that outlives the reply.

- **Tools.** `job_start({agent, task, when})` with `when` as `now` (it runs beside the turn) or `after_reply`; `job_list`, `job_read`, `job_cancel`.
- **Nothing starts a job except an agent's `job_start` call or the user on the page.** A test fails if any other code does.
- **Limits, all settings:** jobs at once, tokens per job, time per job, tokens per day; and the user's controls: off, pause, cancel.
- **Basis.** A job belongs to the record of the turn that started it. Its report is a blob listed with that record. Its workspace writes are versioned writes, made when they happen.
- **Off the path.** When its basis is no longer on the chat's active path at the moment it would write or report, the job stops, and its report is marked off the path. Writes it already made to the chat area stay with the path they were made on.
- **Hearing about it.** At the start of its next turn the main agent is told which jobs finished or failed since, with each report's opening and how to read the whole. The page lists every job with its state, agent, spend and report, and tells the user when one finishes or needs them.
- **A runtime restart** leaves a running job marked interrupted, with what it had done kept. The user or an agent may start it again.

## 16. MCP tools

A server the user has set up in Lumiverse appears in the tool registry once the user switches it on for agents, each tool as `mcp:<server>:<tool>` with the tier `external`. Calls go through Lumiverse on the extension's side.

## 17. Approval

- **Settings decide for each tier,** with an override per tool: allow, or ask.
- **"Ask" holds the call** and shows a card in the live view with the tool, its arguments and the agent asking: approve once, approve for this chat, or refuse (with a reason the agent is given). A setting bounds the wait; when it runs out the call is refused and the agent is told why.

## 18. Talking to a working agent

- **Say something:** a note the main agent receives at its next round, marked as the user's.
- **Pause and resume:** holds every agent of the turn at its next round.
- **Stop** (already there) ends the turn.

## 19. Side sessions

A side session is a conversation with an agent that is not a reply in the chat: the page's own chat with the main agent, or with any agent the user picks, about a chat or about nothing in particular. It has the same tools, workspace, guidance and live view. It is kept in the store, not anchored to a message, and it never writes to the chat's messages.

## 20. Spend and upkeep

- **Spend.** Every model call is recorded with its agent, connection, model, tokens and cost. The page shows spend by day, chat, agent and connection, and the caps in force. A cap that is reached refuses the next call in plain words that name the setting.
- **Upkeep.** Prompts, transcripts and the spans a compaction replaced are kept for a time that is a setting. A sweep removes blobs nothing refers to. The page shows what is stored and how big it is, and can run the sweep.

## 21. An extension that uses LumiAH

Another extension builds LumiAH into itself (§1). What it may supply:

- **Tools,** which run in its own backend (§13).
- **Agent definitions, skills and guidance levels,** as its defaults; the user's still override them.
- **A main agent** for the chats it claims, in place of LumiAH's.
- **The anchor** (§5), when it keeps its own record per message.
- **The writer's request:** it may rewrite the messages the writer is sent, to place what it prepared where the user's preset expects it.
- **Hooks on the turn:** when a turn begins, when the reply has been written, and when the turn ends.
- **Pages:** LumiAH's pages are components it mounts in its own drawer.

LumiAH's own tests include a sample extension that supplies one of each, so this surface is exercised without any real extension.
