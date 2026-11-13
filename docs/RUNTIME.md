# The runtime

LumiAH needs its runtime. It is a process that runs beside Lumiverse, on Bun, and every chat you switch LumiAH on for is answered there. The main agent, the writer and every other agent run in it, and their model calls go from it straight to your providers, on connections it keeps itself. It serves the loopback connection Lumiverse calls for a reply (`POST /v1/chat/completions`, `GET /v1/models`, model `lumiah`), keeps the agents' workspace, sessions and jobs on its own disk with a copy in LumiAH's storage in Lumiverse, reads your chats and world books from Lumiverse as you and keeps them in its memory, and keeps a link to the LumiAH extension, through which it reaches your presets and the rest of what LumiAH does in Lumiverse. It is one file, `dist/lumiah.js`, which ships with the extension, and it updates itself from there.

It runs on the machine Lumiverse runs on, as the same account, and listens on `127.0.0.1` only, unless you tell it otherwise (read *Listening on another address* before you do).

**Coming from LumiAH's `main` branch, or a build before this one.** Built-in mode, where a chat ran inside Lumiverse with nothing to install, is gone from this branch; `main` still has it for now. A chat switched on to run built in reads as off here: start the runtime, then switch it on again. The agents no longer run on Lumiverse's connections, but on the runtime's own (see *Connections*: *Copy from Lumiverse* brings yours over, without their keys). And a runtime set up before this build takes the update to it by its update line once more; from then on it updates itself (see *Update*).

## Install and run

Install LumiAH in Lumiverse (Extensions tab), then open **LumiAH → Runtime**. The page shows two lines with this server's own paths filled in: `<bun>` is the Bun Lumiverse runs on, and `<LumiAH's folder>` is where Lumiverse installed the extension. Run them on the machine Lumiverse runs on, as the account Lumiverse runs as.

On Linux, as a service (recommended; it starts again after a reboot or a crash, and it is held to its memory limit):

```
<bun> <LumiAH's folder>/dist/lumiah.js up --url <the address you open Lumiverse at> --systemd
```

In the foreground, on any system (it stops when you close the terminal):

```
<bun> <LumiAH's folder>/dist/lumiah.js up --url <the address you open Lumiverse at>
```

On macOS and Windows, run the foreground line once to set the runtime up, then have the system keep it running (*Keep it running on macOS*, *Keep it running on Windows*).

`up` asks for your Lumiverse username and password once (or reads `LUMIVERSE_USERNAME` and `LUMIVERSE_PASSWORD`), signs in, registers the runtime with the extension, and starts serving. It never stores the password: it keeps the session Lumiverse gave it. It records the file it was run from: the runtime takes its updates from that file alone.

| Option | What it does | Default |
| --- | --- | --- |
| `--url <address>` | Lumiverse's address. Use the `https` address when Lumiverse is on another machine. | the address in the runtime's config, when it has one |
| `--port <n>` | The port the loopback endpoint listens on. | the first port from 7871 to 7899 that is free and that no other runtime set up on the machine holds |
| `--name <name>` | The runtime's name: one runtime per account and name. | your Lumiverse username; for another extension's runtime, `<username>-<identifier>` |
| `--systemd` | Installs and starts a systemd user service (Linux only; see below). | off |
| `--memory <size>` | The runtime's memory limit, as systemd reads a size (`768M`, `2G`), or `infinity`; at least `256M`. Set up again, the runtime keeps the limit it had unless you give another; one whose config was written before limits were kept there keeps the one its systemd unit holds. Only a systemd service holds it to the limit (see *Memory*). | `1G` |
| `--username <name>` | The Lumiverse account to sign in as. | asked for |
| `--allow-http` | Accepts sending the session to another machine over plain http. | off |
| `--listen <host>` | The address the loopback endpoint listens on. On any other than the default, your loopback key and every prompt cross the network in clear http: see *Listening on another address*. | `127.0.0.1` |
| `--bun <path>` | The Bun the service runs under (an absolute path). The unit and the config record it by its real path, every link in it resolved. | the Bun this line runs under |
| `--extension <identifier>` | The extension the runtime links to, when LumiAH is built into another one (see *Beside an extension that includes LumiAH*). | LumiAH itself; set up again, the one the runtime linked to before |

Other commands: `lumiah status` (how the runtime and its link are doing), `lumiah login` (signs it in again when its session has ended), `lumiah down` (stops and removes the systemd service; the config stays), `lumiah serve --name <name>` (what a service runs). Run each as the start line runs `up`: `<bun> <the runtime's file> status --name <name>`.

**It runs only what no other account can change.** Before it does anything, each command looks at the runtime's file, the Bun it runs on, the Bun `--bun` names and the folder its config is in, and at every folder above them. One that another account (root aside) could change would let that account choose the code that runs as you: the command refuses, and names it.

## Its files

| What | Where | Who may read it |
| --- | --- | --- |
| Its config: the Lumiverse session, the relay secret, the limits it last read, its memory limit, whether it updates itself, the file it was set up from, and its systemd unit | `~/.config/lumiah/<name>.json` (under `$XDG_CONFIG_HOME/lumiah/` where that is set; on Windows `C:\Users\<you>\.config\lumiah\`) | you alone |
| The copy of the runtime a service runs | `~/.local/share/lumiah/lumiah.js` (under `$XDG_DATA_HOME/lumiah/` where that is set); for another extension's runtime, `~/.local/share/lumiah/<identifier>/lumiah.js` | everyone (it is code, and holds no secret) |
| Its own folder | `~/.local/share/lumiah/runtimes/<name>/` | you alone |

In its own folder:

- `connections.json`: your connections, their headers with their values, and which one is the default.
- `secrets.json`: their keys, your sign-in tokens, and an id for this installation that OpenAI's sign-in asks for. Nothing of it leaves the runtime except with the calls it is for.
- `store/`: what the agents keep (the workspace, sessions, transcripts, jobs, spend, search vectors), the working copy of LumiAH's storage in Lumiverse. What the storage doesn't hold yet waits here, and goes there as soon as it can.
- `waiting.json`: only while a second copy of the runtime waits for the first to stop (see *Update*).

The folder and every file in it are made yours alone (`0700` and `0600`); the files of your connections and keys are made so again whenever the runtime finds them otherwise. `up` prints the config's path. On Windows these modes don't apply: the files are as private as your user folder is.

**One runtime at a time keeps a `store/` for your account and an extension.** LumiAH decides which: the first runtime that links; the same one again after a restart or a reconnect; another only once that one has been silent longer than *Quiet after* (Settings → Timeouts → Waiting for the runtime, 2 minutes), and at once when it stops cleanly. Any other runtime of yours for the same extension keeps no copy and reads and saves straight in LumiAH's storage, which is slower and just as correct; the Runtime page says which runtime keeps it, and why another doesn't. A runtime that lost it while it was away first sends LumiAH's storage what it saved and hadn't sent there, and keeps a copy again only after it restarts. Of two runtimes' saves of one file, the later stands: a change one runtime made before another saved the same file is dropped, and its log and the Runtime page name it. Each side tells the time by its own clock, so a machine's clock set back or forward between a change and its sending can misjudge that one save. LumiAH keeps that order while its part in Lumiverse runs: started again, it knows of no save made before, and takes a change as it comes. The order needs the runtime and LumiAH both on this build or later; with either one older, the save that arrives last stands. A runtime folder copied to another machine, or restored from a backup, is found out when it links, and its copy is thrown away for LumiAH's storage; only a backup made in the last 10 seconds before the runtime crashed can pass for current.

## Check that it is linked

- **LumiAH → Runtime** shows the runtime as *linked*.
- `lumiah status` says `It answers: link to LumiAH up` and ends with exit code 0. Otherwise it says what is wrong: not running, stopping, its session ended, its link refused.
- In Lumiverse's Connections, **Test** on the loopback connection answers with its model.

## Then, in Lumiverse

1. **LumiAH → Runtime** shows the runtime as linked.
2. **Mint the loopback key.** The linked runtime puts it in a connection named *LumiAH* (provider Custom, model `lumiah`, address `http://127.0.0.1:<port>/v1`), making that connection when you have none. With no runtime linked, the page shows the key once and you paste it into the connection's API key yourself.
3. **Add a connection** for the agents, on the same page under *Connections*: a provider and your key, a sign-in to your Claude or ChatGPT account, or a proxy or a server of your own by its address. Or press *Copy from Lumiverse*. The first one you add is the default.
4. **Switch LumiAH on for a chat** (Home). That pins the chat to the loopback connection; switching it off puts back the connection the chat had.
5. In **LumiAH → Settings → Agents**, pick the connection, model and effort of any agent that shouldn't run on the default.

A reply in that chat is now answered by the runtime. A chat LumiAH isn't switched on for is untouched.

## Connections

The agents call their models on the runtime's own connections, kept in the runtime's folder on the machine it runs on. Lumiverse's own connections aren't used for agents: the loopback connection is only Lumiverse's way in to the runtime. You keep them on **LumiAH → Runtime**, under *Connections*.

**A connection** is a provider, how its calls are signed, an address, a model and an effort:

- **Provider.** Anthropic, OpenAI, Google Gemini, OpenRouter, DeepSeek, xAI, Groq or Mistral; or, for any server that speaks one of their APIs (a proxy, a model server on your own machine, a provider not listed here), *OpenAI-compatible* (Chat Completions, or Responses where the server's own documents say it speaks it) or *Anthropic-compatible*.
- **How its calls are signed.** Your key; a sign-in to your account (Anthropic and OpenAI, below); or nothing, for a compatible server that asks for no key.
- **Address.** Leave it empty for the provider's own. Fill it in for a proxy or a server of your own; a compatible server needs one. A sign-in connection takes none. It holds no name or password, and nothing after `?` or `#`.
- **Model and effort.** The model its calls name when an agent names none, and how much it thinks when an agent leaves the effort to the connection. An agent that sets its own keeps it.
- **Headers,** sent with every call on it, for a proxy that wants them. A value may be any length; one that holds a secret should be 8 characters or longer (see below).

**A key** goes to the runtime once, when you save it: from the page through LumiAH in Lumiverse to the runtime, as any key you type into Lumiverse passes through Lumiverse, and nothing on the way keeps it. No page shows it again: the page shows only that one is set, and its last four characters for a key of 12 characters or more. A header's value is never shown either, only the header's name and whether it has a value. Change a connection's provider, or its address to another server, and the connection forgets its key unless you type it again in the same save, and forgets every header value you don't type again, key or not: what was given for one server never goes to another. The form says so before you save.

**What a server says back** reaches a Test, a reply's error, the Live page, a transcript or the log only cleaned of every key and header value of 8 characters or more that the runtime holds: some servers repeat a key they refuse. A shorter text can't be told apart from ordinary words, so it isn't looked for, and stays in what a server says. So a save refuses a key shorter than 8 characters (for a server of your own that takes any key, choose *No key*), while a header's value may be any length: put a secret in a header only as 8 characters or more. Nothing stored changes when the runtime reads it: a shorter key saved before the runtime asked for 8 characters is used as it is, and isn't taken out either.

**Test** makes one short call on the connection (no thinking, waiting *Provider wait*, a minute as shipped) and says how long it took and which model answered, or the provider's own words. **Remove** asks first, and names the agents that run on it.

**What stays with the connection.** A call or a list of models never follows a redirect, so a key and headers go only to the address they were given for: when a server moves, give the connection its new address. A Gemini connection is the exception, since pi-ai gives Google's library no way to refuse a redirect. What the providers' own libraries would read for themselves from the runtime's environment (`ANTHROPIC_API_KEY`, `OPENAI_BASE_URL`, extra headers, an organization or a project, Vertex AI in place of Gemini, and the like) is taken out of it when the runtime starts, and its log names what it took: a call is signed and steered by its connection alone. The machine's own network settings (`HTTPS_PROXY`, `NO_PROXY`, extra certificates) still apply, as they do to every program on it.

**A silent answer.** A model's answer that has begun and then gets nothing at all from its server for *Silent answer ends after* (5 minutes as shipped) is ended and made again, as a dropped stream is. Before an answer begins nothing is cut short: a model may be reading a long prompt, or thinking unseen.

**The default** is what every agent that names no connection runs on, and what an agent runs on when its own connection is gone (removed, or one of Lumiverse's from before), with the default's own model: a model Settings chose for the gone connection isn't sent to another. Live names the connection each agent's calls went on, and the model, and where Settings name one the runtime doesn't have, it says so once, with the agents that name it, so you can pick another for them. Make another one the default and those agents move to it from their next call; an agent that names its own connection stays on it. With connections but no default, an agent that names none stops before its first call and says so. With no connection at all, a reply is refused before any work, in words that say where to add one, and Home and Live say so with a button to the section.

**Sign-in.** One sign-in per provider for each runtime:

- **Anthropic**, with your Claude account. The page shows Anthropic's address and a note: requests on this sign-in go to Anthropic the way Claude Code sends them (the runtime puts Claude Code's own line first in the system prompt, and writes the names of tools that share a name with one of Claude Code's the way Claude Code writes them). Open the address, sign in, and paste back the code Anthropic shows you. A known limit: the text you paste holds both the code and the proof it is redeemed with, so whoever sees that text in the minutes it is good can finish the sign-in. Don't share it.
- **OpenAI**, with your ChatGPT account. After you sign in, your browser goes to an address starting `http://127.0.0.1:1455/`. Where the browser runs on the runtime's own machine, that finishes the sign-in by itself. Elsewhere that page doesn't open: copy the whole address from the browser's address bar and paste it on the page. The runtime listens on port 1455 while the sign-in is open, so another program's sign-in holding that port (the Codex command line, say) makes it fail until the port is free. A known limit: while it listens, any program on the runtime's machine can end the sign-in by calling that address, with words of its own that the page then shows as OpenAI's.

A sign-in stays open for *Sign-in stays open* (Timeouts → A model call; ten minutes as shipped). One that ends without signing you in (you cancelled it, it was left open too long or replaced, the provider refused it, the port was taken) says why on the page for ten minutes; one left open too long names that setting. Its token is renewed by itself; the page says until when the current one holds. When a renewal fails, the connection's calls fail with words that ask you to sign in again.

**Copy from Lumiverse** lists your Lumiverse connections (never a loopback connection) and makes a runtime connection of each you tick, under the same id, with its name, provider, address and model, so a setting that named it still does. Keys aren't copied (Lumiverse never shows one): you are asked for each in turn. A Custom connection and the providers that speak OpenAI's API become OpenAI-compatible at their address; Bedrock and Vertex AI connections can't be copied.

**Several runtimes.** Each keeps connections of its own. The section has *Whose connections* to switch between them, and an agent runs on the connections of the runtime its chat runs in. The pickers on Settings and Agents list the connections of the runtime that plays the open chat, else of the runtime heard from last, and say whose. Where there is no connection, Home's and Live's notice speaks of the runtime of the chat it shows, and names it when you have several. A transcript names the connection each agent's calls went on by the name it had when the agent started (in a transcript kept before this build, as the chat's runtime lists it), and Spend as your runtime heard from last lists it; a connection that isn't listed shows by its id.

**Prompt cache.** *Kept for* (Settings → Prompt caching) says how long a provider keeps an agent's prompt in its cache: not at all, a few minutes (as shipped), or about an hour where the provider offers it. The provider places its own cache breakpoints.

**Cost.** A provider that reports what a call cost gives its bill. Otherwise the cost is your Prices', else the provider's published price where the runtime knows it: an estimate, marked ≈, never a bill.

### What the runtime's model calls can't do

The agents' calls used to go through Lumiverse's own generation, on Lumiverse's connections. Calling providers from the runtime can't do all it did:

- A call can't carry audio or video, nor an image in a system message or in one of the model's own messages: the runtime's calls carry text and images only, an image only in a user's message, and a call holding any of these is refused in words that say so.
- A request with no tag (see *A request with no tag*) can't carry a speaker's name, a prefix for the model to continue (except as the last message, on Anthropic's API, to a Claude model before 4.6 that isn't thinking), or a tool choice other than letting the model choose or call none: such a request is refused.
- An agent's call that ends with an assistant's message, on an API in OpenAI's dialect, has the model start a new message rather than continue that one.
- Cache breakpoints set by hand are gone: the core's own, and a request's `cache_control`. The provider places its own.
- A provider's refusal, content filter or "sensitive" stop fails the call, where Lumiverse gave back an empty answer with that reason.
- Lumiverse's connection profiles don't apply: their preset parameters, their reasoning settings and their filtering of parameters by provider. The runtime's connections and its own list of what each provider takes do.
- Bedrock, Vertex AI, Azure and GitHub Copilot aren't offered; any other provider is reached as OpenAI-compatible at its address.
- One sign-in per provider for each runtime.
- A sign-in renewal that fails says only that it failed: you are asked to sign in again even when the provider was merely out of reach.
- On the Claude models that manage their own effort, "the provider's default" effort is high.
- An older Claude model that thinks within a budget, given an answer room under 2,048 tokens, may write past that room.
- Lumiverse's local-inference scheduler no longer orders the agents' calls to a local model with its own generations: they reach the server from the runtime directly.

## Memory

The runtime's memory limit is kept in its config: `1G` until you give another, with `up --memory` or on the Runtime page. What holds the runtime to it depends on how it runs:

- **Under its systemd service** (Linux, `--systemd`): the unit's `MemoryMax`. Past it, systemd stops the runtime and starts it again, so a runaway turn can't take the machine's memory. A new limit on the Runtime page is written into the unit and read by systemd at once; it holds once the runtime restarts, which the page offers.
- **Anywhere else** (in the foreground, under launchd on macOS, under Task Scheduler on Windows): nothing. The limit is kept and shown, and the page says nothing holds the runtime to it. In a container, the container's own limit does (`mem_limit` in its compose service).

A limit is a size as systemd reads one (`768M`, `2G`, `1T`), or `infinity` for none; at least `256M`, below which the runtime couldn't start.

## The systemd unit

`--systemd` writes a user unit, `~/.config/systemd/user/lumiah-<name>.service`, enables it, and turns on lingering for your account so it runs without you logged in. It copies the runtime to `~/.local/share/lumiah/` first, so updating the extension never changes a running service under it: the runtime updates that copy itself (see *Update*). The unit it writes:

```ini
# Written by `lumiah up --systemd`: LumiAH's runtime. `lumiah down --name <name>` removes it.
[Unit]
Description=LumiAH runtime (<name>)
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=<bun> <home>/.local/share/lumiah/lumiah.js serve --config <home>/.config/lumiah/<name>.json
Restart=always
RestartSec=2
MemoryMax=1G

[Install]
WantedBy=default.target
```

`MemoryMax` is the memory limit (see *Memory*).

It is a service of your own account. `up --systemd` as root is refused: run it as the account Lumiverse runs as (`sudo -u <account> …`).

```
systemctl --user status lumiah-<name>.service
journalctl --user -u lumiah-<name>.service -f
```

## Keep it running on macOS

launchd starts it when you log in and starts it again whenever it stops. First run the foreground line once: it signs in, registers the runtime and saves its config. Stop it with Ctrl-C. Then:

1. Copy the runtime where an update of the extension won't change it under the service:

   ```
   mkdir -p ~/.local/share/lumiah
   cp "<LumiAH's folder>/dist/lumiah.js" ~/.local/share/lumiah/lumiah.js
   ```

2. Save this as `~/Library/LaunchAgents/lumiah.<name>.plist`. Put your own Bun, home folder and runtime name where the example has `<bun>`, `<home>` and `<name>` (`up` printed the name; launchd reads no `~`, so write the home folder in full):

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key>
     <string>lumiah.<name></string>
     <key>ProgramArguments</key>
     <array>
       <string><bun></string>
       <string><home>/.local/share/lumiah/lumiah.js</string>
       <string>serve</string>
       <string>--name</string>
       <string><name></string>
     </array>
     <key>RunAtLoad</key>
     <true/>
     <key>KeepAlive</key>
     <true/>
     <key>StandardErrorPath</key>
     <string><home>/Library/Logs/lumiah-<name>.log</string>
   </dict>
   </plist>
   ```

3. Load it, which starts it:

   ```
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/lumiah.<name>.plist
   ```

Its words go to the log file the plist names. Restart it with `launchctl kickstart -k gui/$(id -u)/lumiah.<name>`; stop and unload it with `launchctl bootout gui/$(id -u)/lumiah.<name>`.

It updates itself: it writes each new build over `~/.local/share/lumiah/lumiah.js` and restarts in place, as the same process, so launchd goes on watching it.

## Keep it running on Windows

Task Scheduler starts it when you sign in to Windows and starts it again if it fails. First run the foreground line once, in PowerShell: it signs in, registers the runtime and saves its config. Stop it with Ctrl+C. Then, in PowerShell, with your own `<bun>`, `<LumiAH's folder>` and runtime name (`up` printed it):

```powershell
New-Item -ItemType Directory -Force "$HOME\.local\share\lumiah" | Out-Null
Copy-Item "<LumiAH's folder>\dist\lumiah.js" "$HOME\.local\share\lumiah\lumiah.js"
$action = New-ScheduledTaskAction -Execute "<bun>" -Argument "`"$HOME\.local\share\lumiah\lumiah.js`" serve --name <name>"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "lumiah-<name>" -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName "lumiah-<name>"
```

It runs while you are signed in, as Lumiverse on Windows usually does. Stop it with `Stop-ScheduledTask -TaskName "lumiah-<name>"`, and remove it with `Unregister-ScheduledTask -TaskName "lumiah-<name>" -Confirm:$false`. Task Scheduler keeps no log of its words: to read them, stop the task and run its line yourself, `& "<bun>" "$HOME\.local\share\lumiah\lumiah.js" serve --name <name>`.

It updates itself, but Windows can't restart a process in place: the runtime writes the new build over `$HOME\.local\share\lumiah\lumiah.js`, starts it as a new process, and ends. Task Scheduler restarts a task only when it fails, and this one ended well, so it doesn't watch the runtime that now serves, and the Runtime page says so. The runtime still serves, and still updates itself. At your next sign-in, Task Scheduler starts its own copy, which finds the runtime serving, waits for it to stop, and serves after it; the page shows that waiting copy. To have the runtime watched again at once, end the one that serves and start the task:

```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort <port> -State Listen).OwningProcess
Start-ScheduledTask -TaskName "lumiah-<name>"
```

This road hasn't yet been run on a Windows machine.

## On macOS and Windows, in short

- There is no systemd: `--systemd` is refused, and you keep the runtime running yourself (launchd, Task Scheduler, above).
- Nothing holds the runtime to its memory limit (see *Memory*).
- It updates itself on both: in place on macOS; as a new process on Windows, which Task Scheduler then doesn't watch.
- On Windows the files' modes (*Its files*) don't apply: they are as private as your user folder is.

## Beside an extension that includes LumiAH

Another extension can have LumiAH built into it. It ships the same runtime, `dist/lumiah.js`, in its own folder, and its own Runtime page shows its own lines. They carry one more option, which names the extension the runtime links to:

```
<bun> <the extension's folder>/dist/lumiah.js up --url <the address you open Lumiverse at> --extension <identifier> --systemd
```

You can have LumiAH and such an extension installed together, each with a runtime of its own on the same machine. With `--extension` a runtime has everything of its own:

| | LumiAH's runtime | The extension's runtime |
| --- | --- | --- |
| Name (the default of `--name`) | `<username>` | `<username>-<identifier>` |
| Config | `~/.config/lumiah/<username>.json` | `~/.config/lumiah/<username>-<identifier>.json` |
| Unit | `lumiah-<username>.service` | `lumiah-<username>-<identifier>.service` |
| Installed copy | `~/.local/share/lumiah/lumiah.js` | `~/.local/share/lumiah/<identifier>/lumiah.js` |
| Its own folder (connections, keys, store) | `~/.local/share/lumiah/runtimes/<username>/` | `~/.local/share/lumiah/runtimes/<username>-<identifier>/` |
| Port | the first free one from 7871 | the next: a port another runtime set up on the machine holds is passed over, even while that runtime is stopped |
| Loopback connection | *LumiAH*, model `lumiah` | named by the extension, model `lumiah-<identifier>` |
| Registration and loopback key | kept by LumiAH | kept by the extension |

Each of the two answers only the chats on its own loopback connection. A connection that names the other one's model is never taken for its own, whatever its address, and a key opens only the runtime of the extension that minted it. Switch a chat on in the pages of the extension that should answer it. Each runtime has its own connections for its agents: add them on each Runtime page.

**Who leads the replies of its chats.** Such an extension may answer a chat its own way and name the agent that leads that chat's replies in place of LumiAH's main agent. Its Agents page says how it goes for the chat open in Lumiverse: that agent is marked *leads this chat's replies* (*leads this chat's replies: switched off* while it is off), and the Main agent, with the Writer where the extension's agents release the reply themselves, *no part in this chat's replies*; a conversation or a job you start with either still runs. Nothing stands in for the agent it names. While that agent is switched off or missing, or the extension doesn't give its agents within *Wait for the extension* (10 seconds as shipped, under Timeouts → Tools and approvals in its Settings), the reply doesn't start, and says why and what to do: switch the agent on, try again, or give the extension longer. So it is when the extension doesn't say in that time whether it answers the chat at all: no reply, job or conversation about that chat starts, since run as one of LumiAH's own the chat could be answered wrongly. Where only the extension's agents and skills are late, a reply that needs none of them goes on, and Live says they are missing and why.

With several runtimes set up on the machine, `lumiah status`, `login` and `down` need `--name`; the update and sign-in lines on each Runtime page carry it, and the extension's update line carries `--extension <identifier>` as its start lines do. `up` with no `--name` means the one runtime set up there for its extension. It refuses to set a runtime up under the name of one that links to another extension, and `--port` refuses a port another runtime set up there holds: give the new one its own.

## Update

The runtime updates itself from the extension. Update LumiAH in Lumiverse (Extensions → LumiAH → Update): the extension then offers its new runtime to each runtime of yours that says hello on another build, and each takes it:

- **only from the file it was set up from** (the `dist/lumiah.js` its `up` line ran), and only when that file is the very build the extension offers. It writes the new build beside the copy its service runs, checks that it starts (with the Bun that will run it), puts it in that copy's place, and restarts onto it: through systemd under its service, else in place (on Windows, as a new process: see *Keep it running on Windows*). A runtime that runs straight from the extension's file has nothing to copy: it restarts.
- **by itself,** once nothing is under way: no reply, no request from Lumiverse, no job, no side session's answer. Meanwhile the Runtime page shows the update waiting, and why. One of these that begins while the new build is checked still waits: the update is taken once the runtime is idle again.
- **at once,** with *Update now* on the Runtime page. The page says first what it will end, and afterwards what it ended (see *Restarts*).
- **only from *Update now*,** while *Updates by itself* is off on the Runtime page.

A new build that can't start (one built for a newer Bun than the one that runs the runtime, say) never takes the place of the build that runs: the runtime stays on its build, and the page says why. Update Bun, or the extension, and it is offered again. A build is given *New build's start check* (Timeouts → Waiting for the runtime; 30 seconds as shipped) to say its version; one that says none in that time is taken as one that can't start, in words that name that setting. A copy that couldn't be written is offered again at the runtime's next hello, and the page shows the line that does it by hand meanwhile.

A runtime set up from another file (on another machine, or from a copy of the extension's file) doesn't take the extension's offer, and the page says why: copy the extension's new `dist/lumiah.js` to it and run its `up` line again there.

**The first update from a build before this one.** A runtime set up before it could update itself doesn't know which file to take updates from, and its build doesn't take offers. Its update line, on the Runtime page with the reason, does it this one time. On Linux, run it:

```
<bun> <LumiAH's folder>/dist/lumiah.js up --name <name> --systemd
```

(without `--systemd` for a runtime that runs in the foreground: stop that one first). `up` reads the address from the runtime's config and keeps the runtime's registration, so the runtime that is running goes on answering with the secret it has. It replaces the service's copy, waits for the replies under way to finish (as long as *Wait before restart* in Settings allows: 5 minutes unless you changed it), and only then restarts the service.

On macOS and Windows, stop the runtime, run the foreground line once (it records where updates come from, then serves: stop it with Ctrl-C), copy the new runtime over the old one, and start it again:

```
launchctl bootout gui/$(id -u)/lumiah.<name>
<bun> "<LumiAH's folder>/dist/lumiah.js" up --name <name>
cp "<LumiAH's folder>/dist/lumiah.js" ~/.local/share/lumiah/lumiah.js
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/lumiah.<name>.plist
```

```powershell
Stop-ScheduledTask -TaskName "lumiah-<name>"
& "<bun>" "<LumiAH's folder>\dist\lumiah.js" up --name <name>
Copy-Item "<LumiAH's folder>\dist\lumiah.js" "$HOME\.local\share\lumiah\lumiah.js"
Start-ScheduledTask -TaskName "lumiah-<name>"
```

From then on it updates itself.

Given another address for Lumiverse (`--url`) or another account, `up` doesn't show the secret the runtime holds, which was minted for the address and the account it was set up with. It then registers the runtime anew, which ends the running runtime's link at once: so there it waits for the replies under way before it registers, and again before it restarts the service.

The link is versioned. When the two ends speak different link versions, the runtime's hello is refused in words that say which side to update and how, on the Runtime page, in the runtime's log, and in the reply that fails meanwhile. The extension offers its runtime then too, so a runtime that updates itself mends it.

## Restarts

A restart (an update, a new memory limit, its service stopping it) ends what is under way, as Stop does:

- **A reply** ends with "The runtime is restarting. Press Retry in a moment."; what it had already written stays in the chat. Nothing resumes it: press Retry once the runtime is back.
- **A job** that was running is cut off. Once the runtime has linked again it is marked *interrupted*, and you get a notice that says so; what it had written to the workspace is kept. Start it again from the Jobs page, or let an agent do it. A job that was still waiting is taken up again by itself.
- **A side session's answer** ends the same way: say it again.
- **A held call,** waiting for your word, ends with its run.
- **What the agents saved** is on the runtime's disk: whatever LumiAH's storage in Lumiverse didn't have yet goes there when the runtime is back.

An update by itself waits until none of these is under way; *Update now* doesn't. `up` waits for the replies under way before it restarts a service, not for jobs. A crash gives no time for any of it: the reply fails in Lumiverse's own words, and the runtime's service (where it has one) starts it again.

## Listening on another address

By default the loopback endpoint listens on `127.0.0.1`: only programs on the same machine reach it, and nothing sent to it leaves the machine. `--listen <host>` makes it listen on another address, for a Lumiverse that can't reach the runtime's own loopback address. Know what that means before you use it; `up` says so too when it is given one.

- **The endpoint speaks plain http.** Your loopback key and every prompt and reply cross the network in clear between Lumiverse and the runtime. Whoever can read that traffic reads your chats, and holds the key that lets them send the runtime requests as your Lumiverse does.
- **So it belongs behind something that encrypts, or on a private network.** A tunnel between the two machines (SSH, WireGuard), a reverse proxy that serves HTTPS in front of the runtime, or a network only your own machines are on. Not the open internet as it is. With the tunnel's end or the proxy on the runtime's own machine, the runtime can stay on `127.0.0.1` and needs no `--listen` at all; the connection's address in Lumiverse is then the tunnel's or the proxy's.
- **Whatever reaches the port can send it requests.** Each needs your loopback key: one with no key, or with a key that isn't of a loopback key's form, is refused before any of its body is read, and whether a key is yours is checked by the extension before anything runs. Each must also be addressed to the runtime itself: its `Host` header names the address and port the runtime listens on, unless that address is a wildcard (`0.0.0.0`, `::`), which answers under any name. A reverse proxy has to send that `Host`, not its own; a tunnel keeps it when both its ends use the runtime's port. Nothing else stands between the network and the runtime.
- **`GET /healthz` says only that the runtime is up** there (`{"up": true}`). How its link is and how many replies it is writing would tell anyone who reaches the port when you are writing and what is wrong with your setup, and no key is asked for it. So those are told only to `lumiah status` and `up`, which prove that they hold the runtime's config with a proof good once, for a minute. On `127.0.0.1` it tells whoever asks there: any program on that machine, and, where LumiAH holds `cors_proxy`, any user signed in to your Lumiverse, who can have Lumiverse's proxy ask it under LumiAH's grant, though the proxy hands back only images, audio and fonts, so they don't read the answer.

## Secrets

| Secret | Who holds it | What it protects, and what it doesn't | Where it is stored |
| --- | --- | --- | --- |
| **The Lumiverse session** | the runtime | Your whole account: whoever holds it is you to Lumiverse. The runtime uses it to open the event socket the link travels, to make or update the loopback connection, and to ask Lumiverse to stop a reply. Lumiverse checks it; the extension never sees it. It is not narrowed to LumiAH, so keep the config file to yourself. | The runtime's config file, as the session token. The password is never stored. |
| **The relay secret** | the runtime | Tells the extension that a link request comes from a runtime your account registered, and not from a page or from another runtime; on the faster road (see *The faster road for pages*) it is what a page's request carries to the runtime, sent only to an address that has proved it holds it. It does not keep out something else signed in as you: registering asks for your session and no secret, and answers with a new one. Under a name already taken it takes that runtime's place, unless it shows the secret that runtime holds (as `up` does when it sets the same runtime up again), and then the registration stands. So it is no second lock behind the session. Every runtime registered shows on the Runtime page. | The runtime's config; the extension stores only its SHA-256, and holds the secret itself in memory alone, while the runtime is linked. **Rotate** on the Runtime page sends the runtime a new one over the link. **Forget** makes it register again. |
| **The loopback key** | Lumiverse (in the loopback connection) | Proves a request on the loopback endpoint comes from your Lumiverse's connection, so another program on the machine can't use the endpoint. A request with no key, or with one that isn't of a loopback key's form, is refused before its body is read; whether the key is yours is the extension's to say, before anything runs. It says nothing of which chat or reply a request is for: the tag does that. | Lumiverse's secrets, as the connection's API key; the extension keeps only its SHA-256. Shown once when minted; minting again replaces it at once. |
| **Your providers' keys and sign-ins** | the runtime | Your accounts at the providers the agents call. Each goes only with the calls of the connection it was given for. A key you type crosses Lumiverse once, in its save, on its way to the runtime, and nothing on the way keeps it; after that neither the extension nor a page sees one: a page sees whether a key is set and its last four characters, whether a header has a value, and whether a sign-in holds. | The runtime's own folder: keys and sign-ins in `secrets.json`, header values in `connections.json`. Remove a connection, or sign out, on the Runtime page; delete the folder to forget them all. |

Not yet: registering a runtime with a one-time code shown on the Runtime page, so that a session alone could not register one.

Each turn also carries a **tag**: the extension's prompt interceptor puts a single-use token in the request, tied to the chat and the generation, and the runtime shows it to the extension to begin the turn. A tag admits one request. A request with no tag is no turn: the runtime passes it on as it came, whole or not at all.

## A request with no tag

A request on the loopback connection with no tag is no reply LumiAH answers: Lumiverse made it for something else (an impersonation, a quiet call of another extension, a feature of Lumiverse's that happens to use the loopback connection). Once the extension says its key is your loopback key, the runtime sends it to the writer's connection (Settings → Agents → Writer), else to its default connection, and answers with what comes back, streamed or whole as it was asked, tool calls included. No agent runs.

It goes whole or not at all. These go on as they came:

| In the request | Reaches the writer's connection as |
| --- | --- |
| `system`, `developer`, `user` and `assistant` messages with their text | the same; a `developer` message as a system message |
| an image in a `user` message, as its data: `image_url` with a base64 `data:` URL | the image |
| an assistant's `tool_calls` (function calls) and the `tool` messages after them, each a text | the calls, and each result with its call |
| an assistant's `reasoning_content` (or `reasoning`) and `reasoning_details` | the model's reasoning, as it gave it |
| `tools` that are functions, `strict` included | the same tools |
| `max_tokens` (or `max_completion_tokens`), the sampling parameters (`temperature`, `top_p`, `top_k`, `min_p`, the penalties, `seed`, `stop`), `reasoning_effort` (or OpenRouter's `reasoning.effort`; `none` is no thinking), `parallel_tool_calls`, and `tool_choice` of `auto` or `none` | the call's room, sampling, effort and tool choice, each where the provider's API takes it |
| every other field of the body | the same, on a connection that speaks OpenAI's Chat Completions; another API takes what it has a place for |
| `prefix: true` (or `partial: true`) on the last message, an assistant's | the mark that the model continues it, on a connection that speaks Anthropic's API, to a Claude model before 4.6 that isn't asked to think |

The request's `model` and `stream` are the runtime's to answer by: the connection answers with its own model, and the runtime streams the answer or not as it was asked. A `cache_control` mark is passed over: the provider places its own cache breakpoints. So is a `tool_choice` in a request that offers no tools. An assistant's message given last without the mark goes as it is: on Anthropic's API that makes it a prefix the model continues (which Anthropic refuses to Claude 4.6 and later), and elsewhere a message the model wrote before.

**What is refused before anything starts.** A refused request sends nothing to the connection, and no answer has begun: Lumiverse gets one error, in OpenAI's shape, whose words say what is wrong and what to do.

| Status | When |
| --- | --- |
| `401` | It carries no key, or a key that isn't of a loopback key's form (refused before its body is read), or a key the extension says isn't your loopback key (refused before anything of your connections is told). |
| `413` | Its body is larger than *Largest request* (Settings → Transport → Runtime). |
| `400` | Its body isn't JSON or holds no messages, or it holds what the runtime's model calls can't carry (below). |
| `503` | The runtime can't reach LumiAH, and no wait would mend it: its link is refused (LumiAH doesn't know the runtime, or the two speak different link versions), its Lumiverse session has ended, or LumiAH isn't installed or has crashed. Or the runtime has no connection to send the request to (`no_connection`, in words that say where to add one). |
| `504` | A wait ran out, and the words name which and where it is changed: the runtime's link didn't come up within *Model list wait*, or LumiAH didn't answer about the key within *Request wait*, or, where your settings had to be read again for the writer's connection, the link didn't come up within *Extension lost after*. All three are under LumiAH's Settings → Timeouts → The link. |

What can't be carried refuses the request. It is never dropped: a prompt sent on without one of its parts would mean something else, and nothing would say so. The words name the message, by its place in the request, and what in it can't go on. That is so for:

- an image, audio or video **given by its address** (`https://…`): the runtime downloads nothing. Send an image as a base64 `data:` URL.
- **audio or video,** whatever way it is given: the runtime's calls carry text and images only.
- an **image in a `system` or an `assistant` message**: the runtime's calls carry an image only in a user's message.
- a **`file`** part, whether it holds the file's data or a provider's id for it.
- a message's **`name`**.
- a **`tool` message that holds more than text**: the runtime passes a tool's result on as one text.
- **`prefix: true`** on any message but the last, or on a last message the writer's connection can't continue: only Anthropic's API continues a message, and Anthropic refuses that to Claude 4.6 and later, and to an earlier model while it thinks (send `reasoning_effort: "none"` with the request, or set the connection's effort to off).
- a **`tool_choice`** other than `auto` or `none` (a call required, a function named), in a request that offers tools.
- a `data:` URL that isn't base64, an image's `detail` other than `auto`.
- a part of any other kind (`refusal`, …), and a message whose role is none of `system`, `developer`, `user`, `assistant` and `tool` (`function`).
- a tool call that isn't a function call or whose arguments aren't a JSON object, and a tool that isn't a function.
- any other field of a message, a part, a tool call or a tool that holds something (`audio`, `function_call`, …). A field that is absent, null or empty holds nothing and is passed over; so is the `name` on a `tool` message, which repeats its call's.

## Jobs, side sessions and held calls

**Jobs.** A job is an agent run that outlives the reply, and it runs in the runtime. One started to run now starts at once. One started to run after the reply starts once a reply in its chat has returned: the reply that started it, or the chat's next one for a job you started yourself. Whether jobs run at all, how many at once and what each may spend are under Jobs in Settings. *Hold all jobs* in Settings (off by default) makes every running job wait at its agents' next round, and a job that begins wait at its first, until you switch it off. A restart interrupts a running job (see *Restarts*).

**Side sessions.** A side session's turns run in the runtime too, one at a time for each session. The Live page follows a job or a side session's turn as it follows a reply. Stop ends one where it runs: no generation of Lumiverse's is behind it, so Lumiverse isn't asked.

**Held calls.** A tool call that waits for your word (Approval in Settings) is held by the extension and shown on every page of yours. The runtime waits with it for as long as *Wait for your word* allows. A person may take a while, so silence there is no stalled call; a tool's run in the extension with nothing heard for *Stream stalled after* is given up. A held call stops waiting when you answer, when its run stops, when the extension restarts, or when the extension stays out of the runtime's reach longer than *Extension lost after*.

**Pages that need the runtime.** Everything the agents keep lives in the runtime: the workspace and guidance, jobs, side sessions, spend, upkeep, and the lists on the Agents page. A page's request about a chat goes to the runtime that chat generates on (when you have several, the one whose connection the chat is on), one about no chat to the runtime heard from last, and each waits *Runtime wait* for it. With none linked the page says so and what to do; nothing is lost, and it works again once the runtime links. Live, Sessions, Settings and the Runtime page itself work without it. Sessions, a transcript and a call's prompt read LumiAH's storage in Lumiverse: while a runtime is linked they first wait *Wait for the runtime's saves* for it to send what it saved, and they say so where it hadn't.

| Setting | Default | What it does |
| --- | --- | --- |
| *Hold all jobs* | off | Every job waits until it is switched off again. |
| *Runtime wait* | 30 seconds | How long a page waits for the runtime to do what it asked. |
| *Wait for the runtime's saves* | 5 seconds | How long Sessions, a transcript or a call's prompt waits for the runtime to send what it saved to LumiAH's storage, before it shows what the storage holds. |
| *Storage wait* | 1 minute | How long the runtime waits for LumiAH's storage to take what it saved, wherever something waits on it (a reply's record, a page that reads it, the runtime stopping). Past it that goes on; nothing is lost. A runtime LumiAH no longer knows (forgotten, or registered anew by `up`) waits for none of it: what it saved stays on its disk for the runtime started next on its folder. |
| *Notices kept* | 200 | How many notices of jobs (finished, failed, interrupted, waiting on you) are kept until you dismiss them. |
| *Stream stalled after* | 30 minutes | A tool's run in the extension with nothing from it for this long is given up. A held call is not. |
| *Extension lost after* | 2 minutes | How long the extension may stay out of the runtime's reach before a call or a reply ends. |
| *Wait for Lumiverse's Stop* | 5 seconds | How long Lumiverse may take to answer when the runtime asks it to stop a reply (see *Stop in the Live page*). |

The waits among these, and every other wait, are also on one page: see *Timeouts*.

## The faster road for pages

A page's request to the runtime travels LumiAH's link, the same socket that carries the runtime's replies, jobs and tools, so a large reply or job can hold it up. Grant LumiAH the permission `cors_proxy` (Extensions → LumiAH → Permissions; only an owner or an admin of the Lumiverse instance can, and an update of LumiAH never grants it), and pages reach a runtime on Lumiverse's own machine through Lumiverse's own proxy instead. Everything works without it, and the Runtime page says what granting it does while it isn't granted.

- **When the road is taken.** The runtime listens on a loopback address (`127.0.0.1` unless you said otherwise), and LumiAH has checked, since the runtime last linked, that the proxy reaches that very runtime: it asks there for a proof made with the runtime's secret, and sends no secret to get it. A runtime on another machine fails the check (unless a tunnel brings it to Lumiverse's machine), and its pages' requests go over the link. Each runtime's row on the Runtime page says which road pages take to it, and why not the faster one.
- **What goes over the link all the same.** A request that may wait longer than 30 seconds, which is all Lumiverse's proxy waits (so with *Runtime wait* above 30 seconds every request takes the link), and an answer larger than the proxy carries (25 MiB). A request the proxy doesn't answer within *Proxy road wait* (10 seconds) is sent over the link as well, and whichever answers first is taken; one the road fails goes over the link. The runtime does each request once, whichever road brings it. After a failure the road rests for two minutes, then is checked again.
- **Another account on the same machine** can reach the runtime's port, as any program there can. It can ask `GET /healthz` how the runtime is: on `127.0.0.1` the runtime tells whoever asks how its link is and how many replies and requests it is answering (see *Listening on another address*). It can ask the road for proofs, which serve nothing else. It can't have a reply written or a request passed on without your loopback key, and it can't ask the road anything without the runtime's secret, or learn that secret from the runtime. LumiAH sends the secret only to an address that has proved it holds it already, and your runtime holds its port while it runs, and as it stops, until its link has closed: from the moment it begins to stop it answers nothing there but the road's probe and `GET /healthz` (which then says it is stopping), and LumiAH, refused, asks over the link instead. The one opening left: where the runtime's process ends without stopping (it crashed, or was killed), or in the moment between its link closing at the end of a stop and Lumiverse noticing that, a program that took the port at once could be sent a request that carries the secret. A page in a browser can't drive the runtime itself: the runtime refuses any request a browser sends. But where LumiAH holds `cors_proxy`, any user signed in to your Lumiverse can have Lumiverse's proxy send a request to a loopback address under LumiAH's grant (Lumiverse answers that itself, before LumiAH sees it, and hands back only images, audio and fonts): nothing of a runtime's is read or changed that way, but its port can be reached, and made to work, by another signed-in user.

## Timeouts

Every wait you can meet is on one page, **LumiAH → Settings → Timeouts**, each with the control Settings gives it and its default beside it, in five groups:

- *Waiting for the runtime*: how long a page, a reply or a key waits for your runtime, and how long a new build of it has to start before it updates (*Runtime wait*, *Proxy road wait*, *Quiet after*, *New build's start check*, …).
- *The link*: how long the runtime and LumiAH wait for each other, and how long the runtime waits for Lumiverse (*Request wait*, *Lumiverse wait*, *Extension lost after*, …).
- *Tools and approvals*: a tool call, your word on one, and what an agent started (*Call time*, *Wait for your word*, *Wait for the extension*, *Wait for jobs due*).
- *A model call*: an agent's calls, the agent, a turn or a job, a model's answer gone silent, a connection's Test, a sign-in (*Time per call*, *Silent answer ends after*, *Provider wait*, *Sign-in stays open*, …).
- *The copy and the store*: the runtime's copy of your chats and lore, and what the runtime saved reaching LumiAH's storage and Lumiverse (*Chat data wait*, *Storage wait*, *Wait for the runtime's saves*, …).

A wait that runs out says so in words that name its setting and where it is, such as *Runtime wait (LumiAH's Settings → Timeouts → Waiting for the runtime)*. So does every other limit an agent meets, by where Settings show it: a clipped tool result names *Tool results clipped past (LumiAH's Settings → The agent loop)*, an agent stopped at its rounds *Tool rounds per agent (LumiAH's Settings → Agents → Main agent → Budget)*. In an extension that includes LumiAH, they name the place that extension shows LumiAH's Settings in.

While the runtime's link is down, what it asks LumiAH waits for the link to come up: the requests of a reply, a job, a side session, a tool call or a held call wait *Extension lost after*, and the connection's model list and the key check of a request with no tag wait *Model list wait*. Once sent, each request waits *Request wait* for its answer. All three are under *The link*, and the words of a wait that ran out say which it was.

## Timings

*Timings* on the Runtime page show where the time goes between LumiAH and its runtimes. For each kind of request and each road: how many crossed and how many weren't answered; the median, the 95th percentile and the slowest time; how much of it was waiting, on the way and in queues, and how much the other end's own work; the largest each way; and the slowest of the latest. LumiAH keeps what its pages and tools asked a runtime, and each runtime what it asked LumiAH over the link: each its latest 2,000, in memory only, and never what crossed, only sizes and times.

## When the runtime is down

Nothing answers in its place. While the runtime is down (stopped, crashed, not linked, or refused because its version and the extension's differ), the replies of every chat LumiAH is switched on for fail, and LumiAH moves no chat by itself. What it does is tell you:

- **Before a reply goes.** Lumiverse shows a notice: "LumiAH's runtime isn't answering, so this reply will fail. Start the runtime (its line is on LumiAH's Runtime page), then send your message again."
- **On LumiAH's Home.** The chat says its runtime isn't answering, with the way to the Runtime page.
- **In the failed reply,** where the runtime is still up to say it (its link was refused, or the extension is out of its reach): why, and that nothing answers in its place. Where the runtime's process is gone, the failure is Lumiverse's own, that of a connection that doesn't answer.

Start the runtime again (`systemctl --user start lumiah-<name>.service`; on macOS, `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/lumiah.<name>.plist` if you unloaded it, since launchd restarts one that stopped by itself; on Windows, `Start-ScheduledTask -TaskName "lumiah-<name>"`; or its start line) and the chat is answered there again, with nothing to set.

**A dropped link mends itself.** When Lumiverse restarts or the network drops the runtime's socket, the runtime links again by itself: after a second, then waiting longer after each failure, up to 30 seconds between tries (*First reconnect wait* and *Longest reconnect wait* in Settings). When the extension's worker restarts, it asks its runtimes to say hello at once.

An extension that has LumiAH built into it reads the same state for its own pages (`runtimeState`): whether the runtime is linked, and what to do when it isn't.

## Your chats and lore in the runtime

The runtime keeps a copy of the chats and world books its agents read, in its memory, and reads them from Lumiverse itself, as you: over Lumiverse's own routes, or from its database file where the instance's operator allows it (see *The database reader*). So a chat and its lore don't cross LumiAH's link each time an agent reads them. Lumiverse's events, which LumiAH hands on, keep the copy current; and before a run uses a chat, the runtime checks it against Lumiverse, so a message you sent a moment ago is in it. One reply's reads of its chat and lore cross the link 6 times with the copy and 7 without, for a chat of 20 messages as for one of 2,000, and with the copy none of the 6 carries a message, a book or a list of books: only what LumiAH alone keeps or hears does (the chat's own facts, its LumiBooks book, the lore Lumiverse activated for the reply).

- **What it can't see over Lumiverse's routes:** a change Lumiverse makes without telling of it, to a message before the newest (your messages renamed in bulk when you rename a persona, say, or an extension writing its own entry on an older message), until the chat is read again whole. The database reader sees it. Some changes to a world book's entries come with no event either, so over the routes a book in use is read again whole once a second has passed since its last read.
- **It answers only what it can vouch for.** Anything else goes to LumiAH in Lumiverse: a chat it hasn't read yet while Lumiverse doesn't answer, a read that failed or took longer than *Chat data wait* (15 seconds), what LumiAH itself wasn't granted to read, a chat larger than all the copy may keep, a record the runtime has just written until the copy holds it. Lumiverse's routes are no interface Lumiverse promises to keep, so an answer of theirs that isn't the one the runtime expects (a "not found" among them) says nothing of the chat or the book: LumiAH answers that read, the page says which route answered what, and a route that answers so for three different chats or books in a row is asked nothing for a minute. When the runtime's sign-in to Lumiverse has ended, every read goes to LumiAH, and the page asks you to sign the runtime in again.
- **Its room.** *Chat data kept* (Settings → Transport → Runtime) bounds what it keeps: 32 million characters across chats and books as shipped, the one used least recently let go first. It counts against the runtime's memory (see *Memory*). At 0 it keeps nothing, and every read goes to LumiAH.
- **What the page shows.** Under each linked runtime on the Runtime page, *Chat data* says where its agents' reads are answered and why, what the copy reads from and why, what it holds (each chat and book, when and why it was last read, what its last check could and couldn't see), what it keeps beside its room and the runtime's memory limit, the reads it sent to LumiAH and why, and Lumiverse's events it heard, with any lost on the way (it then reads again what it holds).

## The database reader

For whoever runs the Lumiverse instance.

A runtime on Lumiverse's own machine can read your chats and lore straight from Lumiverse's database file, rather than over Lumiverse's routes. It sees what the routes can't (a change made with no event to an older message), and it is off until you switch it on.

**The switch.** *Read Lumiverse's database directly*, under *Chat data* on the Runtime page, is shown to the instance's operator alone, and only the operator can turn it: LumiAH asks Lumiverse who you are at every use (each time a runtime says hello, each page request, each ping of a runtime that was given the file). It is for the operator's own runtimes; no other account's runtime is ever given the file. The file is `lumiverse.db` in Lumiverse's data folder, which LumiAH works out from where Lumiverse installed it (`<data folder>/extensions/<identifier>/repo/`), and nothing a page sends can change it. Its path is no secret: every user's Runtime page shows where LumiAH's runtime file is, and the database's path follows from that by this rule. Where Lumiverse installed LumiAH anywhere else, the path can't be told, and the switch can't be turned on. Switched off, the runtime is told at once and reads over Lumiverse's routes from then on.

**What it is.** A read-only reader of `lumiverse.db` in Lumiverse's data folder, through Bun's own SQLite. It reads four tables (chats, messages, world books, world book entries), and of those only the rows of the runtime's own user: no secret, no setting, no character, no other user.

**What it never does.** It never writes to the database, never checkpoints it, never changes its journal mode, never attaches another file, never creates or deletes a file. As every reader of a database in WAL mode does, it writes its own read marks into `lumiverse.db-shm`; nothing else in the folder changes. Its statements are short, a page of 1,000 rows at most, and it holds nothing between them, so Lumiverse's checkpoints go on as before.

**What it needs.**

- The same machine and the same local disk as Lumiverse: the shared memory a WAL database is read through doesn't work across machines or over a network share. A runtime takes itself to be on Lumiverse's machine only where it reaches Lumiverse at a loopback address (`127.0.0.1`, `::1`, `localhost`): one set up with any other address never opens the file, whatever the switch says, and its *Chat data* says why. On another machine the same path could hold an old copy of Lumiverse's data, which would answer as current. A runtime on Lumiverse's machine that was set up with another address reads the file once you set it up with the loopback one, `lumiah up --url http://127.0.0.1:<Lumiverse's port>` (with `--name`, where you named it): that registers the runtime anew, as any other address for Lumiverse does (see *Update*).
- An account that can read `lumiverse.db`, `lumiverse.db-wal` and `lumiverse.db-shm`, and look in their folder. Best, the account Lumiverse runs as. Another account needs read access only, never write access to the folder: it then reads through a private index of the WAL, more slowly.
- Lumiverse running. While it is stopped (on Linux its last connection removes the `-wal` and `-shm` files), each of its reads fails, in words that say so.

**When it turns itself off.** When Lumiverse's database isn't what it was built to read (an update of Lumiverse renamed or retyped a column it reads, or a table is missing), when there is no file where it looks, or when it may not read the file, it turns itself off and says why on the page, and the runtime reads over Lumiverse's routes. It stays off until the runtime starts again, or until you switch it off and on; a build of LumiAH that knows the new schema reads again.

**Known limit.** A message's or an entry's text rewritten to one of the same length in bytes, with no event and no new revision, isn't seen until the chat or the book is read again.

## Before you disable or uninstall LumiAH

Lumiverse gives an extension no moment at disable or uninstall, so LumiAH can undo nothing then. A chat LumiAH is switched on for stays pinned to the loopback connection, and with the extension gone its replies fail. So first switch LumiAH off for each such chat on LumiAH's Home: that puts back the connection the chat had. If the extension is already gone, pick another connection for the chat in Lumiverse. Then stop the runtime: `lumiah down --name <name>` for a service, or stop it as you started it.

Your connections, keys and sign-ins stay in the runtime's own folder (`~/.local/share/lumiah/runtimes/<name>/`) and its Lumiverse session in its config (`~/.config/lumiah/<name>.json`) until you delete them.

## When it doesn't link

Work down this list; each step says what to look at.

1. **Is it running?** `lumiah status`, or `systemctl --user status lumiah-<name>.service` (macOS: `launchctl print gui/$(id -u)/lumiah.<name>`; Windows: `Get-ScheduledTask -TaskName "lumiah-<name>"`). Not running: `journalctl --user -u lumiah-<name>.service -n 50` says why (the last lines are the runtime's own words; on macOS, its log file; on Windows, run its line yourself).
2. **Is LumiAH running in Lumiverse?** Extensions tab: installed, enabled, running. The Runtime page's **Issues** list names any permission LumiAH wasn't granted; grant them there.
3. **Has its session ended?** The Runtime page and `lumiah status` say so. Sign it in again: `lumiah login --name <name>` (the page shows the line), then it reconnects by itself.
4. **Do the versions differ?** The Runtime page shows the runtime as *refused*, with which side to update. Update that side (see *Update*).
5. **Was it forgotten or registered twice?** A runtime the extension doesn't know is refused: run its start line again, which registers it anew.
6. **Is Lumiverse behind a proxy?** The proxy must pass WebSocket upgrades on `/api/ws`; the link travels that socket. `lumiah status` reports a socket that never opens.
7. **Does Lumiverse reach the runtime?** In Connections, press **Test** on the *LumiAH* connection. It calls `GET /v1/models` on the runtime: a refusal names the cause (the key, the link, the version). The connection's address must be the one the Runtime page shows (`http://127.0.0.1:<port>/v1`); in a container, the runtime must run inside the same one as Lumiverse.
8. **Do Lumiverse's local models wait while LumiAH answers?** With Lumiverse's local-inference scheduler on, the runtime's address must be among its excluded origins, or a reply the runtime answers holds the scheduler for as long as its agents work. `up` adds it; the Runtime page shows *missing* when it couldn't, and then you add `http://127.0.0.1:<port>` there yourself (Settings → Inference scheduler → Excluded origins).

A reply the runtime fails says why in the chat, in the reply's place: what stopped it and what to do. With the runtime's process gone there is nobody to say it, and the failure is Lumiverse's own (see *When the runtime is down*).

**Stop in the Live page.** Lumiverse gives an extension no way to stop a reply, so the runtime asks it with your session, as Lumiverse's own Stop button does (`POST /api/v1/generate/stop`): Lumiverse closes the request, keeps what was written and shows the reply as stopped, not as failed. When it can't be asked (the runtime's session has ended, Lumiverse doesn't answer within *Wait for Lumiverse's Stop* in Settings, or it no longer runs that generation), the runtime ends the reply as a finished one with whatever was written, and LumiAH deletes the empty message a new reply leaves; the runtime's log says why. The Live page says where a reply was stopped: there, or in Lumiverse.

**Stop in a reply the agents write.** Where the agents write the reply themselves, a turn releases it once, whole: in one release by the agent that leads, or as the answer of another agent it hands the reply to, which streams in as it is written. Stop (in Lumiverse or in the Live page) ends the turn wherever it is. What was already released stays in the chat, nothing more is sent after Stop, and the extension that plays the chat is told exactly what had been released.
