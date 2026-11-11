# LumiAH design

LumiAH is an agent harness for Lumiverse. A main agent works in a loop with tools, sub-agents, sessions, a workspace and guidance files before each reply: inside Lumiverse by default, or in a runtime of its own (§25). This document is the contract the code is built to. Where the code and this document disagree, one of them is wrong and gets fixed.

**What is built:** §1 to §8 and §11 to §25, with tests, except where a section says a part is not yet built. The README's "Things to know" lists the gaps a user can meet.

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

A request with no tag is not a turn. The runtime passes it through to the writer's connection unchanged, so a feature of Lumiverse that happens to use the loopback connection still works. It goes whole or not at all: one that holds something Lumiverse's generation call can't carry (a picture given by its address, a file) is refused in words that name it, never sent on without it (docs/RUNTIME.md, *A request with no tag*).

LumiAH answers only generations that reach the loopback connection. A chat on any other connection is untouched. Which connection a chat generates on is Lumiverse's to pick, and the extension follows the same order: the chat's own connection, else the one selected in Lumiverse, else the default, else the first listed. Where Lumiverse doesn't tell an extension which one is selected, the page reads it there and says it with `lah.hello`.

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

Nothing of LumiAH's own that fails before the writer costs the reply. A main agent that stops short of a brief (a limit, a failed call), a session that can't be resumed, a summary that can't be stored, or settings that can't be read all end in the same place: the writer writes from the request alone, unless the setting `reply.withoutBrief` says such a turn fails, and the thinking block, the trace and the turn's record say what failed. A summary that fails only leaves the notes whole: the main agent still works. With settings that can't be read the main agent isn't run at all, and the writer's call goes to the connection the request names, else the user's default; no prompt or transcript is kept for that turn. A main agent that writes the reply itself has no writer to fall back on: its turn fails with why.

### 3.3 Everything here is a default
The main agent's and the writer's instructions, tools, connection, model, effort and budgets are settings the user can change. Every text sent to a model has an id and can be replaced by the user. Every limit is a setting with a default. A fixed value in the code needs a comment that says why it can't be a setting.

## 4. Core

### 4.1 The loop
`startAgent(spec, deps)` returns a handle; `send(text)` runs the loop: call the model, run the tools it calls (as many at once as its budget allows), send the results back, until it answers or a limit stops it. It keeps:
- native tool calls, with a fallback that offers the tools as text when a connection refuses them, and recovery of tool calls a model writes as text;
- budgets per call, per agent and per turn (tokens in and out, rounds, time, revisions);
- a loop detector for the same call made on the same state, with the same result, several times running; the same call written more than once in one answer is run once, and of one answer's calls that would end the agent's work (`write_reply`) only the first is run;
- no call of a round begun once the turn was stopped or its time ran out;
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
- **A deleted swipe** moves the later swipes' records down with them, and with them the place of a record still to be written. A record whose own swipe was deleted is written nowhere.
- **Bodies are blobs,** stored once by hash and never changed.
- **The session at a turn** is read by walking the chat's active path back to the latest record with a summary, then taking the segments after it. A swipe, a regenerate, an edit and a branch therefore need no bookkeeping: whatever path is active is the one that is read.
- **What the main agent carries of a turn since is a receipt:** each thing it did in a line or two, with the start of each call's arguments and of each result, each within its own length setting, and how to read either whole (`past_turn`). A file it wrote or a long brief is never carried whole in the notes of the turns after.
- **A record whose path hash no longer matches** the messages before it (an earlier message was edited or deleted) is off the path. It is not used, and the main agent is told its notes from that point were dropped.
- **Compaction** runs when the session passes its token setting: the span is summarized, the summary lands with the turn's record, and the replaced span is kept so a rollback can restore it.
- **A summary lands only when its call ended of itself.** Whether it was cut is told from the call's finish reason, never from its last word.
- **A rollback** marks the summary's record, and the session then reads past it. The notes aren't summarized again until they have grown by `session.rollbackMarginTokens` or the user asks. A regenerate, a swipe or a continue of the reply the summary was made on carries the marked summary on its own record, so the rollback holds whichever swipe the chat shows afterwards.
- **An extension with its own per-message record** supplies the anchor itself, so a turn has one record and not two.

## 6. Link

The runtime is a client of Lumiverse like any other: it signs in as the user, finds the extension, opens the event socket, and sends the extension enveloped requests, each answered by its id. The extension pushes to the runtime's session.

**The runtime is optional, and nothing stands in for it.** A chat runs built in unless the user sets it to run in a runtime (§25), and a user who starts none has no link at all. A chat set to a runtime is answered only there. While that runtime isn't linked (stopped, crashed, refused for its link version, forgotten), the chat's replies fail on the loopback connection, as a reply on any connection that doesn't answer does: LumiAH moves no chat by itself. It tells the user instead. A toast says so as a reply is about to go to a runtime that isn't linked; the chat's view says the runtime isn't answering (`ChatView.away`), where Home offers one tap to run the chat built in; and a reply the runtime itself has to refuse says why, and the same way out.

- **Versioned.** Both ends say their link version in `hello`; a mismatch is refused in plain words that name which side to update.
- **Three secrets, three jobs.** The runtime's Lumiverse session lets it reach the extension. The relay secret, minted when a runtime registers, tells that runtime's requests from a page's and from another runtime's; registering needs only the user's session, so it proves a runtime the account registered and no more. The loopback key, which the user puts in the connection, proves a completion request comes from that user's Lumiverse. The extension stores only hashes of the last two.
- **Streams are numbered.** A reply or a model call's deltas arrive as `chunk` pushes numbered from 1, acknowledged in batches (`stream.ack`), and asked for again after a gap (`stream.resend`). A stream ends with exactly one terminal chunk: `done` with a model's whole answer, `value`, or `error`. The runtime gives a stream up before that with `stream.cancel`, when its caller no longer wants the answer.
- **Value streams.** Anything else that takes its time is answered on a stream too: a tool that runs in the extension (`tool.call`) and a tool call held for the user's word (`approval.ask`). Such a stream carries one chunk, a terminal `value`: the tool's `{ text, error? }`, or the user's answer, exactly as the page gave it (the core reads it, and runs the call only on a word that is exactly an approval, §17). On a stream the answer survives a reconnect, and the runtime can give it up like a call: it cancels the stream when the run stops or the wait runs out, which takes a held call down.
- **Patient streams.** The runtime gives up a stream that brings nothing for *Stream stalled after* (`runtime.stallMs`, 30 minutes). A held call waits on a person, so its stream is patient: silence is no stall. It ends early only when the extension stays out of reach (`runtime.lostMs`, 2 minutes) or no longer holds it.
- **The runtime asks, the extension answers.** Every request but `register` carries the relay secret.
  - *The link itself:* `register` (`up` registers a runtime: the extension mints its relay secret and says which model its loopback connection names; set up again, a runtime that shows the secret it holds keeps its registration, so it goes on answering until `up` restarts it), `hello` (on every socket: both versions, the streams to resume, the settings' revision, what the extension supplies to the core and who the backend is, §21), `ping` (the heartbeat, naming the streams the runtime reads and the runs it works on: a stream the extension no longer holds ends at once, and a run the runtime no longer names is over).
  - *A reply:* `models` (the connection's model list and its Test: whether the key is the user's loopback key), `turn.begin` (check and spend a tag, answered with the turn), `turn.commit` (the turn's record, written on the reply's message once Lumiverse has saved it), `passthrough` (an untagged request, run as it came on the writer's connection).
  - *Model calls:* `model.call` (one call of an agent, answered on a stream), and for any stream `stream.ack`, `stream.resend` and `stream.cancel`.
  - *Tools:* `tools.list` (the tools that run in the extension, as they stand for a chat: the extension's own, and those of the MCP servers the user switched on, §13 and §16), `tool.call` (runs one), `approval.ask` (holds a call for the user's word, §17).
  - *Storage:* `blob.get`, `blob.put`, `doc.get`, `doc.put`, `doc.remove`, `doc.list` (the path of every document under a prefix); and for upkeep (§20) `blob.list` (every blob stored, a page at a time) and `blob.remove`.
  - *The chat:* `chat.path` (the active path, each message with its anchor), `chat.messages` (messages by range, with their text), `chat.info` (the chat itself: its name, its character, the chat it was branched from), `chat.anchor` (a record rewritten later, as a rollback does), `chat.anchors` (every record LumiAH holds in every chat of the user's, a page at a time, for upkeep).
  - *What a run reads:* `lore.books`, `lore.entries`, `lore.activated`, `preset.blocks`, `connections.list`, `connections.get`, and `settings.get` (the settings, the user's texts, and their own definitions as stored, §13).
  - *For the pages:* `trace.push` (trace events in batches, for the live buffer), `job.changed` (a job was queued, began, was paused or resumed, or ended: for the pages' lists and the user's notices, §15), `ask.answer` (what the runtime answered to an `ask` push), `setup.connection` (what became of a `connection` push).
  - *What the lore and history tools read (§23, §24):* `recall.lore.read` and `recall.lore.activated` (the chat's books with each entry as Lumiverse keeps it, and what Lumiverse activated for a generation, with how), `recall.chat.messages` (messages with when each was sent), `recall.embedder` and `recall.embed` (the user's embedding connection, and vectors from it), `recall.memory.enabled`, `.search`, `.entity`, `.entities` and `.arcs` (Lumiverse's own memory of a chat), `recall.databanks.list`, `.documents` and `.content`, `recall.web.enabled` and `.search` (the user's own web search), and `book.read` (the chat's LumiBooks book). A runtime linked to a backend from before these falls back to the older requests, or reads the thing as not set up.
  - *The extension LumiAH is built into:* `extension.call` (one member of what it supplies to the core, run in its backend, §21).

  One thing crosses with no id, no secret and no answer: the `trace.deltas` notice, a model's answer as it arrives, for the live view. One that is lost is not sent again.
- **The extension tells the runtime,** in pushes: `chunk` (a piece of a stream); `stop` (the user pressed Stop on a run; `by` says where, in the live view or in Lumiverse); `settings` (they changed: read them again before the next run); `secret` (a new relay secret, when the user rotates it on the Runtime page); `connection` (a loopback key to put in the user's loopback connection, making the connection when there is none); and `ask` (something a page asked that the core does where it runs). Spindle gives an extension no way to make a connection, so the runtime does it with its own Lumiverse session, says what it did, and never keeps the key. It gives none to stop a reply either. A reply stopped from the live view is one Lumiverse still generates, so the runtime asks Lumiverse to stop it as its own Stop button does, and ends the reply itself when Lumiverse can't be asked or doesn't answer within *Wait for Lumiverse's Stop* (`runtime.stopAskMs`, 5 seconds).
- **What a page asks of the core is done where it belongs.** The core keeps the workspace, the jobs, the side sessions and the spend in documents in the user's storage, and a core runs in each place a chat can run (§25): in the runtime, and in the extension. What a page asks about a chat that runs in a runtime (a file read or written, a job started, a list read) is not served in the backend. The extension sends it on as an `ask` push (`{ ask, op, args }`), and the runtime does it with its core and answers with `ask.answer`: the core's own answer, or a refusal with one of the pages' error codes and words the page shows. `op` is a `group.method` of the harness from a fixed list (`src/link/work.ts`); nothing else can be reached. What a page asks about a chat that runs built in, or about no chat at all, the core in the extension does (§7), and no runtime is asked. Where a chat is set to run in a runtime and none is linked, the page is told so, with what to do.
- **The work runner** (`src/link/work.ts`) runs what isn't a reply. Each place has one: the runtime's for the chats that run there, the extension's for the chats that run built in (§7).
  - *Jobs.* The core queues a job and says so through its `jobs` port. A `now` job starts at once. An `after_reply` job starts once a reply turn of its chat has returned, however that turn ended. The core decides the rest: how many run at once, each job's budget, the day's tokens, whether its turn is still on the chat's path.
  - *Side sessions.* When a page says something in a side session, its next turn starts. One turn of a session runs at a time.
  - *Stop, say, pause.* A `stop` push ends a job's run or a side session's turn as it ends a reply's. What the user says to a run, and a pause or a resume of it (§18), arrive as asks.
  - *The hold.* While the user holds all jobs (`jobs.paused`, off by default), every running job waits at its agents' next round, and a job that begins waits at its first.
  - *After a restart.* A process that stops ends every run it had. Once it is up again (the runtime's link, or the extension itself), the runner has the core mark the jobs the restart cut off as interrupted, tells the pages of each, and takes up the ones still queued. Each place keeps its own list of the jobs it is running, so neither takes the other's for cut off.
- **An extension's members are requests.** What an extension that builds LumiAH in supplies to the core (§21) runs in its backend. So the runtime hands the core a `HarnessExtension` whose every member is an `extension.call` (`linkExtension` in `src/runtime/host.ts`). `hello` says which members the backend has; one it lacks is answered in the runtime as not supplied, with no request. A member that reads (the definitions, a claim, the writer's request) is asked again after a socket that closed under it. A hook is sent once, so the extension never hears one twice.
- **One runtime for every extension.** The runtime bundle therefore holds no extension's code: it is the same whichever extension ships it. It links to the extension its command line names (`lumiah up --extension <identifier>`; LumiAH's own when none is named), and the backend says the rest on `register` and `hello`: the name its pages show, and what to call the loopback connection. The loopback model follows from the identifier (`lumiah` for LumiAH itself, `lumiah-<identifier>` for an extension it is built into), so a user with both has two connections, and neither runtime takes the other's for its own.

## 7. Extension backend

- Registers the prompt interceptor, at the highest priority, so it sees the prompt as it will be sent. It is never registered as required: Lumiverse passes over an interceptor that fails or runs out of its time and sends the prompt as the one before left it, so nothing LumiAH does can cost a chat its reply. An interceptor can change the prompt or leave it, and no more: it can't stop the generation it works on. What LumiAH didn't make goes back to Lumiverse exactly as it came, the very messages with Lumiverse's own fields on them, so an interceptor that runs after it (a second backend made of LumiAH's code among them, §21) reads the prompt as Lumiverse made it. What it does with a prompt:
  - *On the backend's own loopback connection:* the chat runs in a runtime. It tags the turn (§2) and leaves out the messages the history cutoff hides.
  - *In a chat switched on to run built in* that no other backend answers (below): it runs the turn here (the next point), with the same cutoff.
  - *Any other prompt* it leaves exactly as it came. It holds no chat up to find out which this is: what it can't check within `tags.checkMs` counts as not LumiAH's.
- Runs the core for the chats that run built in (§25). Each user has a core here (`builtin.ts`) on an in-process host: the core's ports served by the backend's own parts, with no link between. The interceptor hands the turn to the core's first half, `prepare`, with the moment the prompt must go back by: the end of Lumiverse's wait (five minutes, as the manifest asks; less where Lumiverse says less) less `builtin.marginMs`. What `prepare` hands back goes to Lumiverse as the prompt to send: each message that came keeps its place, and the brief and the lore the main agent added go in as messages of their own, named for Lumiverse's Prompt Breakdown. When Lumiverse says the generation ended, the saved reply goes to the second half, `complete`, and the turn's record is written on the reply's message, with where the turn ran beside it (`hosted.ts`).
  - *It never costs a reply.* A turn that fails, runs out of time or is stopped from a page hands the prompt back as it came; the live view and the Sessions page say that the reply is Lumiverse's own, and why. Should the core not have returned a quarter of the margin before Lumiverse's limit, the prompt goes back without it.
  - *A generation Lumiverse stopped or failed* leaves nothing: the turn is given up (`abandon`) and no record is written.
  - *Jobs and side sessions* of these chats run here too, on the same work runner as the runtime's (§6).
  - *Local models.* Lumiverse's local-inference scheduler takes its lease for a reply when the reply's own generation starts, after every interceptor has answered. A built-in turn's calls are made before that, so they never wait behind the reply they prepare.
- Serves the link: each request of §6 is checked against the contract, authenticated by its relay secret and answered once. `tools.list` and `tool.call` go to the extension's own tools and the MCP tools; `approval.ask` to the held calls; `extension.call` to what a mounting extension supplies; `blob.list`, `blob.remove`, `doc.list`, `chat.info` and `chat.anchors` to user storage and the chat; `recall.*` and `book.read` to what the lore and history tools read (`recall.ts`, which serves the core here the same way); `job.changed` to the jobs; `ask.answer` to the asks. `hello` also says what the extension supplies to the core and who the backend is.
- Makes each model call an agent makes, the runtime's over the link or the core's here, through Lumiverse's generation API on the connection named, streaming, and reports usage as the provider gave it.
- Writes each turn's anchor when Lumiverse saves the reply.
- Keeps the live buffer: the latest run of each stream, sent to every page that has that stream's live view open. A stream is what a page follows: a chat's reply turns under the chat's id, a job's run under the job's id, a side session's turns under the session's id. A reply's run begins when its tag is spent (in a runtime) or when the interceptor takes its prompt (built in). A job's run and a side session's turn begin where they run, so their view starts from their first trace event. Every run says where it runs, and a built-in reply's says when its time before the reply ends. A run that failed, or whose reply LumiAH had no part in, says why in a sentence and, where a page can act on it, as a code beside the sentence (`cause`: the main agent's model can't call tools, a permission LumiAH needs is missing, one of the user's limits was reached, the user skipped LumiAH for the reply, the time before the reply ran out). The code is read from the run's own trace (`cause.ts`), so a stored transcript says the same.
- Passes on Stop. For a run in a runtime, Lumiverse's own Stop, and Stop on a page for any run (a reply, a job, a side session's turn), reach the runtime as a `stop` push that says where it was pressed. The run's calls under way here end with it, so a runtime out of reach doesn't keep a model running. For a run here, Lumiverse's Stop ends the turn wherever it is, and Stop on a page ends a job's run or a side session's turn. Stop on a page for a built-in reply ends LumiAH's work on it and no more: an extension can't stop Lumiverse's generation, so Lumiverse writes that reply on its own, and the live view says where to stop the reply itself. Once the main agent has handed over, there is nothing of LumiAH's left to stop.
- Keeps settings and the user's texts in user storage, and the user's own definitions with them: their agents and skills, what they switched off, and the MCP servers they switched on. One revision covers all of it, so the runtime reads whatever changed before its next run. Whether a tool's calls run or wait for the user, by tier and by tool (§17), is a setting too.
- Does what a page asks of the core in the place it belongs to (§6, `asks.ts`). About a run under way: where that run runs. About a job: where it runs while it isn't over, and where its chat runs once it is. About a side session: where the chat it is about runs. About a chat: where that chat runs. About no chat (the user's own workspace area, spend, the Agents page's lists, upkeep): the core here. What is asked about a chat that runs in a runtime goes to the runtime that chat generates on (the one whose loopback connection the chat is on), as an `ask` push, and the runtime's answer or refusal goes back to the page. A page waits `pages.askMs` for it; what takes as long as the store is big is waited for while the runtime stays linked. Where a chat is set to a runtime and that runtime isn't linked, or the one asked goes away or doesn't answer, the page gets `unavailable` in words that say what to do. The two cores share one store. Each counts the day's spend caps from what it spent itself, and two writes of one document from the two places at the same moment could lose one: both are rare, and are noted here, not locked against.
- Holds the tool calls that wait for the user's word (§17). The held calls are part of the state every page holds, so the user answers on whichever page is open. A call stops waiting when it is answered, when the runtime gives it up (its run stopped, or the core's wait ran out), or when its run is over. Nothing of it is stored: a call can only wait while its run does. What an answer "for this chat" stands for from then on is the core's to keep.
- Keeps the jobs as the pages hear of them: the jobs not yet over, from each `job.changed` (a runtime's over the link, the core's here directly), and a notice when a job finishes, fails, is interrupted by a restart of the place it ran in, leaves the chat's path, or waits on the user's word. A notice is kept in user storage until the user dismisses it, so it is there on the next page they open; past `pages.noticesKept` the oldest go first. The user's two switches over all jobs are settings: off is the core's, and the hold is `jobs.paused`, which each work runner reads (§6).
- Lists and calls MCP tools through Lumiverse (`spindle.mcp`), which holds the connections and applies its own rules on what a server may reach; LumiAH never sees where a server is or what secrets it takes. It needs the `mcp_servers` permission: without it, or on a Lumiverse with no MCP, there are no servers and no MCP tools. A server offers nothing to agents until the user switches it on for them (§16). Each tool is then named `mcp:<server>:<tool>` with the tier `external`, where `<server>` is the server's name made safe for a tool's name (lowercase letters, digits and `-`; where two names come to the same, the server made later takes a number). `mcp:<server>` in an agent definition names every tool of that server. One call may take `mcp.callMs`. A server that is on but can't be reached offers no tools and says why on the Agents page; it never takes a run's other tools away.
- Asks Lumiverse for as little as it needs. It can't work without four permissions: `interceptor` (to see a reply's prompt before it is sent), `chats` (to read a chat and switch itself on for it), `generation` (its agents' model calls, and hearing when a reply starts and ends) and `chat_mutation` (Lumiverse puts reading a chat's messages under it, not only changing them; with it LumiAH also writes each reply's record). Without any one of them no chat can be switched on, and the pages say which is missing and what it is for. Every other is optional: without one, the part it serves is quietly absent, nothing fails, and the pages list it as information, with what granting it adds.

  | Permission | Without it |
  |---|---|
  | `generation_parameters` | no chat can run in a runtime (built in needs it for nothing) |
  | `world_books` | the lore tools find no books |
  | `presets` | the agents know the preset only by the prompt it made |
  | `characters` | the world books attached to the chat's character aren't found, and guidance for a character isn't matched |
  | `personas` | the world book attached to the persona isn't found |
  | `mcp_servers` | no MCP tools |
  | `embeddings` | search is by word, not by meaning |
  | `memories` | the tools that read Lumiverse's memory aren't offered |
  | `databanks` | the databank tools aren't offered |
  | `web_search` | `web_search` isn't offered |

- Is put together by `createBackend(host, env, options)`. LumiAH's own backend gives no options. An extension that builds LumiAH in (§21) gives what it has of:
  - `identity`: who the backend is in Lumiverse. Its identifier (what its runtime links to), the name its pages and its runtime's words show, the name of its loopback connection, and where LumiAH's records sit in its entry on a message.
  - `extension`: what it supplies to the core. Its agent definitions and skills, the chats it claims, the writer's request rewritten, and its hooks around a run.
  - `tools`: its own tools, listed beside the MCP tools and run here. One that takes an MCP tool's name stands over it.
  - `anchor`: where LumiAH's record sits in the extension's own record of a message (§5).
  - `declined`: the permissions it chose not to ask Lumiverse for (LumiRPEngine asks for no `characters`). LumiAH's pages never bring those up; what they serve is absent, as above.

  Everything of a mounting extension runs in its backend; the runtime only asks (§6). A backend serves every user where the core's host serves one, so each member is the core's own with the user's id passed last.

- Answers only its own chats. With LumiAH and an extension that has it built in both installed, each has its own registry, loopback connection, records (§5) and switch. A chat switched on in one carries that backend's mark in the chat's metadata (`lumiah_chat_<identifier>`: the chat it was made on, the backend's name, the place, since when, and, in a runtime, the connection the chat had before the pin). The other backend reads the mark: it shows the chat as that one's, refuses to switch it on beside it, and leaves its prompts alone. A mark names its chat, so one copied along with a branch marks nothing there. A chat that generates on another backend's loopback connection counts as that backend's the same way.
- Takes a chat over at the user's word (`lah.chat.takeover`; the page asks them first). The other backend's mark is removed, a pin to that backend's loopback connection gives way to the connection its mark names (to none where it names none), and the chat is switched on here, built in. Nothing asks the other backend, so this works whether or not that extension is still installed: a mark left by one that was uninstalled locks no chat out.
- Keeps every account's bookkeeping its own. The interceptor's turns, verdicts and waiting records, the live buffer's runs, the frames coming in parts, the streams and the jobs the pages hear of are held per account, and an account's settings trim only its own. What bounds the worker all accounts share is fixed (`CEILINGS` in `src/link/settings.ts`): each such setting has a ceiling no account can raise past, and a total across accounts, past which the account that holds the most gives up its oldest or the newcomer is told the extension is busy. A link request that names a chat is served only for a chat of the calling account's, a mounting extension's tools and members included.
- Has no last word. Lumiverse stops an extension's worker (a restart, an update, a disable, an uninstall) with no call the extension could act on, so nothing is undone then: a chat set to a runtime stays pinned to the loopback connection, and the marks stay on the chats. What must outlive the worker is kept in the user's storage (a built-in turn that waits for its reply, §25; a runtime's turn whose record is still to come), and what a user should undo before disabling or uninstalling is in `docs/RUNTIME.md`.

The transport settings these parts read (`src/link/settings.ts`, the `transport` section of the user's settings):

| Setting | Default | What it is |
|---|---|---|
| `mcp.callMs` | 30 seconds | How long one call of an MCP tool may take. Lumiverse holds it between 1 and 120 seconds. |
| `jobs.paused` | off | The user's hold on every job. |
| `pages.noticesKept` | 200 | Notices kept until dismissed. |
| `pages.askMs` | 30 seconds | How long a page waits for the runtime to do what it asked. |
| `streams.coalesceMs`, `streams.keepMs` | 40 ms, 10 minutes | How long a stream's text waits to go with what follows it, and how long a finished stream's chunks are kept unacknowledged. A tool's call and a held call ride such streams. |
| `live.events`, `live.page`, `live.chats`, `live.lostMs` | 20,000, 500, 32, 30 seconds | Events kept of a live run, events per read, streams whose latest run is kept (one still running is never let go), and how long after its generation ended a reply that never said it ended counts as lost. |
| `runtime.stallMs`, `runtime.lostMs`, `runtime.stopAskMs` | 30 minutes, 2 minutes, 5 seconds | The runtime's own waits named in §6. |
| `link.joinMaxUnits`, `link.partStaleMs`, `link.joinFrames`, `link.joinHeldUnits` | 32 million characters, 1 minute, 8, 64 million characters | A frame too large for Lumiverse's socket crosses in parts, which are joined before any secret can be checked. The largest frame joined, how long a frame's first parts wait for the rest (they are let go on the backend's tick), and what one account may have under way over all its sessions: frames, and characters held. Past either, the frame is refused in words that name the setting. |
| `builtin.marginMs` | 15 seconds | How long before Lumiverse stops waiting for the interceptor a built-in turn must have handed its prompt back (2 seconds to 4 minutes). The main agent is told the time it has; should the core not have returned a quarter of this before the limit, the prompt goes back as it came. |

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
- **Pins.** An agent pins in the chat's two areas, `/` and `learned/`. A pin in `~/` puts the file in that agent's context in every chat, so it is the user's to set and to lift, on the Workspace page, unless a setting lets agents (off as shipped); `workspace_pin` says so when it refuses.
- **Bounds.** A path is checked and normalized; one that leaves its area is refused. Nothing reaches the host's disk. File size, file count and total size have settings.
- **The user** reads and edits every file on the page. A user's edit is a versioned write like any other, recorded as the user's.

## 12. Guidance

A guidance file is markdown an agent is given as part of its instructions, every turn.

- **Three levels:** the user's (`~/GUIDANCE.md`), a middle level (for a plain chat, the character's; an extension may name its own, such as a world's), and the chat's (`learned/GUIDANCE.md`).
- **Loaded** into every agent's system prompt in that order, under a size setting, with each level named so an agent knows whose words they are. The writer is given none (§3.2): the main agent carries what matters into its brief. A setting, off by default, puts the guidance beside the brief in the writer's request.
- **Edited** by the user on the page. An agent may edit the chat's level when a setting allows.

## 13. Agents, skills and tools as definitions

- **An agent definition:** id, name, description (what a delegating agent reads when choosing), instructions, tools (by name or family), connection, model, effort, budgets, and what it is given (the whole request, or only its task).
- **A skill:** id, name, description and a markdown body: a procedure an agent may follow. An agent's prompt lists the skills it may load, by name and description; `skill_load` returns a body. Nothing in the code decides when a skill applies.
- **A tool:** name, family, tier (read, write or external), description, parameters, and where it runs: in the runtime, or in the extension over the link (`tool.call`), which is how an extension's own tools and MCP tools run.
- **Three sources for each:** built in, an extension's, the user's. A user's definition with the id of a built-in or an extension's overrides it, and a reset restores the original. The user makes, copies, edits, switches off and deletes definitions on the page.
- **The registry** the runtime uses for a turn is the merge of the three, read at the turn's start.
- **The tools the user added.** An agent's tools may name `@added`: every tool that isn't built in (an extension's own tools, and those of the MCP servers switched on for agents), including ones added later. The main agent's default tools hold it, so an added tool is one the main agent can call with nothing else to set, and a sub-agent whose definition names such a tool is given it under the default grant (§14). The pages show it as a plain choice, never as `@added`. No built-in tool is part of it: a built-in that acts outside LumiAH (`web_search`) is given to an agent by name, by the user.

## 14. Delegation

- `delegate({agent, task, files?})` starts a registered agent as a sub-agent with its own session. Its answer is the tool's result. Several calls in one round run at once, under a setting.
- **The handle lives until the turn ends:** `agent_message({handle, text})` continues that agent, under a revision cap.
- **A depth setting** decides who may delegate: 2 as shipped, so the agent a run starts with and the agents it starts. A job that an agent starts stands one deeper than that agent (one the user starts at 0), and its agent is given tools by the same rule as a sub-agent: so the main agent's job may hand tasks on, and whoever takes them may not. A job's sub-agents are counted against a setting of the jobs' own (no limit as shipped: its allowance bounds them), not against the turn's.
- **A sub-agent's writes** are its own versioned writes.
- **A sub-agent's tools** are its definition's, never more than the agent that started it may grant: by default no tool that agent doesn't hold itself, and a setting gives every sub-agent whatever its own definition names. A definition may say for itself (`grant`): one that keeps its own tools whoever starts it is given all its definition names, even by an agent that holds none of them. That is for an agent whose tools are its own trade, which the agent that hands it tasks is deliberately not given. A user's definition of the same id decides in its place.
- Every sub-agent's session appears in the live view under the agent that started it, and is kept with the turn's transcript.

## 15. Jobs

A job is an agent run that outlives the reply.

- **Tools.** `job_start({agent, task, when})` with `when` as `now` (it runs beside the turn) or `after_reply`; `job_list`, `job_read`, `job_cancel`.
- **Nothing starts a job except an agent's `job_start` call or the user on the page.** A test fails if any other code does.
- **Limits, all settings:** jobs at once, tokens per job, time per job, tokens per day; and the user's controls: off, pause, cancel.
- **A day's limit never fails a job.** A job that runs into the jobs' tokens per day, or into the user's caps on a day's spend (§20), stops as one whose allowance ran out does (§22): its session and what it wrote are kept, and its report names the limit and where to change it. It carries on from where it stopped once the last 24 hours count less or the user has raised the limit; carried on while the limit still stands, it stops there again without a call.
- **Basis.** A job belongs to the record of the turn that started it. Its report is a blob listed with that record. Its workspace writes are versioned writes, made when they happen.
- **Off the path.** When its basis is no longer on the chat's active path at the moment it would write or report, the job stops, and its report is marked off the path. Writes it already made to the chat area stay with the path they were made on.
- **Hearing about it.** At the start of its next turn the main agent is told which jobs finished or failed since, with each report's opening and how to read the whole. The page lists every job with its state, agent, spend and report, and tells the user when one finishes or needs them.
- **A runtime restart** leaves a running job marked interrupted, with what it had done kept. The user or an agent may start it again.

## 16. MCP tools

A server the user has set up in Lumiverse appears in the tool registry once the user switches it on for agents, each tool as `mcp:<server>:<tool>` with the tier `external`. Calls go through Lumiverse on the extension's side. Switching a server on is all it takes: the main agent holds its tools from the next turn (§13), and they are called without asking unless Settings say external tools ask first (§17).

## 17. Approval

- **Settings decide for each tier,** with an override per tool: allow, or ask. Every tier's default is allow. A tool that acts outside LumiAH is one the user set up and switched on, or installed with an extension, and that was their consent; asking first is one switch away, for the tier or for one tool.
- **"Ask" holds the call** and shows a card in the live view with the tool, its arguments and the agent asking: approve once, approve for this chat, or refuse (with a reason the agent is given). A setting bounds the wait; when it runs out the call is refused and the agent is told why.
- **Approval fails closed.** What comes back from an ask is outside data: only an answer that is exactly an approval (once, or for this chat) runs the call. A refusal is one; anything else is nobody's word, the call isn't run, and the agent is told so. A host passes the user's decision on exactly as it was given.
- **"For this chat" is kept** with the chat, each tool with when the user said so. The user reads what is kept, for one chat or for all, and takes a tool out again; every run that begins after that asks about it again.

## 18. Talking to a working agent

- **Say something:** a note the main agent receives at its next round, marked as the user's.
- **Pause and resume:** holds every agent of the turn at its next round.
- **Stop** (already there) ends the turn.

## 19. Side sessions

A side session is a conversation with an agent that is not a reply in the chat: the page's own chat with the main agent, or with any agent the user picks, about a chat or about nothing in particular. It has the same tools, workspace, guidance and live view. It is kept in the store, not anchored to a message, and it never writes to the chat's messages.

## 20. Spend and upkeep

- **Spend.** Every model call that reached its connection is recorded with its agent, connection, model, tokens and cost: one that was stopped, failed or was made again too, with the runtime's estimate marked as one, since its provider reported nothing. The page shows spend by day, chat, agent and connection, and the caps in force. A cap that is reached refuses the next call in plain words that name the setting; and a cap is asked about the call about to be made, with its prompt as estimated and what the calls under way hold, so neither one large call nor several agents at once pass it unseen. A cap stops agents' work, never the writer's call of the reply the user waits for, which is made and recorded.
- **Cost.** A provider's own cost is used where it reports one. Otherwise the user's prices give it: the price under the model name the provider reported, else under the model the call asked for, else the longest priced name one of those starts with (a provider often reports a dated name). The call's usage in the trace names the price that gave the cost.
- **A cached re-read counts at what it costs.** A long run re-reads its own conversation at every call, and most providers bill a prompt token read again from their cache at about a tenth. So every limit on prompt tokens (per agent, per turn, per job, per day) counts such a token at a weight: a setting, a tenth by default, 1 to count it in full. A limit's message says what was counted against what is allowed, and the weight. The pages show the true counts; a cap shows both.
- **Upkeep.** Prompts, transcripts and the spans a compaction replaced are kept for a time that is a setting. A sweep removes blobs nothing refers to. The page shows what is stored and how big it is, and can run the sweep.
- **A chat that is deleted is forgotten.** When Lumiverse says a chat was deleted, the backend asks the core to forget it (`chats.forget`): its `learned/` area and its own area's heads, its jobs and their reports, its side sessions, its approvals, how its lore last stood and its search vectors go, and nothing of another chat's. The texts those named go with the next sweep. It is refused while a reply is being worked on in the chat.

## 21. An extension that uses LumiAH

Another extension builds LumiAH into itself (§1). What it may supply:

- **Tools,** which run in its own backend (§13). A call tells the tool who made it: the run and its kind (a turn that answers a generation, a job's run, a side session's turn), the calling agent and its definition, whether that agent is the run's main agent, and the agents over it, from the main agent down to the one that started it. So an extension tells the run's main agent from an agent it handed a task, whatever definitions the two run as.
- **A file kept for the agent that called.** An extension's tool may keep a file in LumiAH's workspace as the agent that called it (`workspace.writeAs`, with the run, the call and the agent as the call was handed them). It is the write `workspace_write` makes: versioned, under the same limits and the same guard, in that turn's change set, and named on the call's result in the live view. The chat's own area takes it only while the run is under way.
- **Agent definitions, skills and guidance levels,** as its defaults; the user's still override them.
- **A main agent** for the chats it claims, in place of LumiAH's.
- **The anchor** (§5), when it keeps its own record per message.
- **The writer's request:** it may rewrite the messages the writer is sent, to place what it prepared where the user's preset expects it.
- **Hooks on the turn:** when a turn begins, when the reply has been written, and when the turn ends.
- **Pages:** LumiAH's pages are components it mounts in its own drawer.

LumiAH's own tests include a sample extension that supplies one of each, so this surface is exercised without any real extension.

## 22. A long objective

Some work is too long for a turn and ends in no reply: learning the story of a chat that already has thousands of messages, or putting a workspace in order. It is a job the user starts on the page.

- **What the user gives:** the objective in their own words, the agent to do it (the main agent unless they pick another), and an allowance of tokens and time for this job alone.
- **A plan first.** The agent is told its allowance and asked to say, before it works, what it will do with it: where it will read closely, where a summary is enough, and what it will leave out. The plan is a file in `learned/`, which it keeps true as it goes. A smaller allowance should give a narrower plan.
- **Steering.** The user can say something to the job while it runs, and pause and resume it (§18 applies to a job as it does to a turn). A paused job stays paused across a runtime restart.
- **When the allowance runs out** the job stops with a report of what it did and what is left. The user can grant more, and it carries on from its own session. A day's limit stops it the same way, and it is carried on with nothing more granted (§15).
- **What it leaves:** files in `learned/`, among them a plain list of what it has not verified.
- **It may delegate, and start jobs of its own,** all counted against its allowance.
- **No basis record.** A job the user starts belongs to the chat, not to a turn. It writes `learned/` and `~/`, which no swipe changes. A write to the chat's own area is refused in words that say why.

## 23. A story's book

LumiBooks is another extension: it summarizes a chat's older messages into chapters and arcs, kept as entries of a world book it makes for that chat. Where a chat has one, the agents can read it as a book.

- `book_outline` gives the tree (volumes, arcs and chapters, each with the messages it spans) and the coverage: which of the chat's messages no chapter covers, and which have changed since they were summarized.
- `book_read` gives an entry's text.
- **Both are worked out by code** from the world book and the chat. Neither makes a model call.
- The tools are offered only in a chat that has a book.

## 24. Lore and history

Two things decide whether a long story holds together: the lore a reply must be faithful to, and what the chat itself established, at whatever level of detail the moment needs. The prompt Lumiverse assembles holds a part of each. The agents' work is to know which part, and to reach the rest fast. Lumiverse is the data surface: LumiAH adds no store of its own where Lumiverse already keeps one.

### 24.1 What the prompt already holds
Each turn the main agent is told, in the request itself and with no tool call:
- **Lore in the prompt:** each activated entry by id, title and size, and how it got there (a key that matched, or a vector match with its score). Lumiverse flags each world-info message of the prompt, so this is exact.
- **Lore not in the prompt:** an index of the other entries of the chat's books: id, title, keys, size. It is ordered by how well each matches the recent messages and cut at a size setting, with a count of the rest. Entries the user switched off are left out unless a setting includes them.
- **History in the prompt:** which of the chat's messages the prompt holds word for word, by number; which it doesn't; and what stands in for those (a book, §23; Lumiverse's own summary or memories blocks), each named.

Each of the three is a text the user can replace, has a size setting, and can be switched off.

### 24.2 Lore tools
- `lore_index`: every entry of the chat's books: id, title, keys, size, book, and its state (in the prompt, always on, switched off). Filters by state, book, or text in a title or key.
- `lore_search`: several queries in one call. Ranked over titles, keys and text, with titles and keys weighted (settings). Each hit comes with its best lines, its state and why it matched. Where the user has an embedding connection, matches by meaning are merged in (§24.5).
- `lore_read`: several entries whole in one call, paged.
- `lore_grep`: an exact string or a pattern.
- `lore_related`: one hop of the lore's own links: the entries that mention this entry's title or keys, and the entries it mentions.
- `lore_about`: everything the books hold on a name: the entries titled or keyed with it, then the entries that mention it.

### 24.3 The lore the writer sees
The main agent decides what lore reaches the writer, entry by entry, without retyping any of it: `write_reply` takes, beside the brief, entries to add and entries to drop.
- **An added entry's own text** goes into the writer's request where Lumiverse puts world info, beside the entries already there; where the prompt has no such place, before the brief.
- **A dropped entry's text** is taken out of the writer's request.
- Settings say whether the main agent may add and whether it may drop, and cap what it adds. The live view shows each entry added and dropped, and the exact prompt shows the result.

### 24.4 History tools
The level of detail a moment needs slides: a line of summary is enough for most of the past, and the exact words are needed for a little of it. The tools go from coarse to exact.
- `chat_outline`: the story as a table of contents with the messages each part spans. It comes from the book where the chat has one (§23); else from the arcs Lumiverse's own memory has made, where the user has that on; else from a plain skeleton worked out by code (breaks at long gaps in time, each stretch by its opening lines, who speaks and how long it is).
- `chat_about`: the trail of a name or a phrase through the chat: where it first appears, where it last appears, how often, and its most telling lines in order. "What did the chat last establish about the brass key" is one call.
- `chat_search`: several queries in one call, ranked, with hits grouped by stretch so one exchange doesn't fill the page, each with its lines of context, message number and date; filters by range and by who spoke. Matches by meaning are merged in (§24.5).
- `chat_grep`: an exact string or a pattern.
- `chat_read` and `chat_around`: the messages themselves, by range, or around one message.
- `memory_search`, `memory_entity`, `memory_arcs`: Lumiverse's Memory Cortex, where the user has it on: retrieval over the chat's memory, what it has recorded of a person or thing (facts, relations), and its arcs.
- `databank_list`, `databank_search`, `databank_read`: the user's databanks that apply to the chat.
- `web_search`: the user's own web search provider, where they have set one up. Its tier is external (§17).

A tool that rests on something the user hasn't set up is not offered.

### 24.5 Search by meaning
Where the user has an embedding connection and the setting allows, LumiAH keeps a vector for each lore entry and each chat message, in the user's storage by the text's hash, so an unchanged text is never embedded twice. New text is embedded in the background under a daily cap. `lore_search` and `chat_search` merge matches by meaning with matches by word. Without an embedding connection, search is by word and says so. The page shows how much is embedded and what it cost.

### 24.6 Speed
- Indexes are kept between turns and rebuilt only for what changed.
- One call carries several queries or several ids.
- §24.1 means the common turn needs no lookup call to know what exists.

### 24.7 The chronicle
What the story has established, kept so that no agent has to read the chat again to know it.
- **Files** under `learned/chronicle/`: the outline (parts of the story with the messages each spans), what is established (facts), open threads (promises, questions), and the cast (who is where, and in what state).
- **Every line cites the messages it rests on.** The chat tools print each message with a short citation (its number and a few characters of a hash of its text), which an agent copies.
- **`chronicle_check`** is worked out by code: it lists the lines whose messages are gone or have changed, as after a swipe or an edit. Lines that fail it are left out of what the main agent is given.
- **The chronicler** is a built-in agent. The main agent starts it as a job after a reply, as a built-in skill describes; the user can switch that off, or run it by hand.
- **The top of the chronicle is pinned** into the main agent's context under a size setting. From there it goes down the scale: outline, trail, search, the messages themselves.
- Learning an existing story (§22) builds the same files, from the book and the chat.

## 25. Two ways to run

LumiAH runs a chat's turns in one of two places. The agents, tools, sessions, workspace and pages are the same in both.

- **Built in** (the default; nothing to install). The main agent works inside Lumiverse, in the extension, while Lumiverse waits to send the prompt. When it calls `write_reply`, the extension hands Lumiverse the prompt with the brief put in and the lore added and dropped (§24.3), and **Lumiverse's own generation writes the reply**: on the chat's own connection, with the chat's own sampling, streaming as it always does. LumiAH records the turn when the reply is saved.
  - **Time.** Lumiverse gives an extension at most five minutes before a reply. The main agent is told how long it has. When the time is nearly gone it must brief the writer with what it has, and leave the rest to jobs (§15), which have no such limit.
  - **It never costs the user a reply.** If LumiAH fails or runs out of time, Lumiverse sends the prompt as it was, and the live view says why LumiAH had no part in that reply. A first half that never returns is let go when its prompt goes back, so it holds up no later reply of its chat; and when another reply is asked for in a chat while one's agents still work, the earlier turn is let go and the live view says so.
  - **The record.** The turn is completed with the text its own generation wrote (Lumiverse's own word for it where it gives one, else the swipe the turn wrote on), never the swipe the message happens to show. A turn that waits for its reply is kept in the user's storage from the moment its prompt is handed back, so a restart of the extension's worker between the two halves loses nothing without a word: where Lumiverse saved the reply the turn still gets its record, marked as written after the fact, and where no reply came the turn is let go and the live view says so. A reply that outlasts `reply.pendingMs` gets its record the same way.
  - **The agents' connection,** where the user set none, is the chat's own.
  - **What the user sees while it works:** Lumiverse shows that LumiAH is working before the reply starts, and the Live page shows every step. The reply's thinking block is the writer's own.
  - **Stop.** Lumiverse's Stop ends the turn wherever it is, and nothing of it is recorded. LumiAH's own pages can only end LumiAH's work (*Skip LumiAH for this reply*): while the main agent works, it ends that, Lumiverse writes the reply on its own, and the view says so. An interceptor can't stop the generation it works on, so once the prompt has gone back, the reply is Lumiverse's to stop.
  - **Who writes.** Built in, the reply is always Lumiverse's own generation: what the main agent hands over goes into the prompt, never out as the reply.
- **In a runtime** (§2, §6; optional). For a turn that needs more than five minutes before the reply, for having the main agent write the reply itself, and for the agent's steps in the reply's thinking block. The user starts the runtime once (`docs/RUNTIME.md`) and chooses it chat by chat.
  - **No fallback.** A chat set to a runtime is answered only there. While the runtime is down (stopped, not linked, refused for its link version), the chat's replies fail, and LumiAH doesn't work on them built in in the runtime's place. It tells the user: a toast as a reply is about to go to a runtime that isn't linked, the chat's view says the runtime isn't answering, and Home offers one tap to set the chat to run built in. Built in is the default for that reason, and the runtime a choice for the chats that need it.
  - **Disable and uninstall.** Lumiverse gives an extension no moment at either, so nothing is undone then: a chat set to a runtime stays pinned to the loopback connection, and its replies fail until the user sets it to run built in first, or gives the chat another connection afterwards (`docs/RUNTIME.md`).

A chat's jobs run where its turns run, and where a chat runs is its own switch: built in unless the user chose the runtime for it, kept while the chat is off. With LumiAH and an extension that has it built in both installed, each answers only the chats switched on in it (§7). An extension that builds LumiAH into itself gets both ways.
