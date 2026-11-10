# LumiAH design

LumiAH is an agent harness for Lumiverse. A main agent works in a loop with tools, sub-agents, sessions, a workspace and guidance files, and answers Lumiverse's main generation through a loopback connection. This document is the contract the code is built to. Where the code and this document disagree, one of them is wrong and gets fixed.

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
- **The runtime asks, the extension answers:** check a tag and begin a turn; make a model call; read and write blobs, documents, anchors; read the chat, lore and preset; push trace events; commit a turn.
- **The extension tells the runtime:** stop a turn; settings changed.

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
