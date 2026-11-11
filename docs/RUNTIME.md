# The runtime

The runtime is optional. LumiAH works without it: a chat you switch LumiAH on for runs **built in**, inside Lumiverse, with nothing to install. There the main agent works while Lumiverse waits to send the prompt, and Lumiverse's own generation writes the reply. Lumiverse gives an extension at most five minutes for that.

The runtime is the second place a chat can run, for what built in can't do: a turn that needs longer than five minutes before the reply, the main agent writing the reply itself, and the agents' steps in the reply's thinking block. You choose it chat by chat, on LumiAH's first screen; every other chat stays built in. A chat you set to the runtime is answered only there: it has no fallback (see *When the runtime is down*), which is why built in is the default. An extension that has LumiAH built into it may play its chats only in the runtime (LumiRPEngine does): such a chat has no built-in way at all (see *A chat that plays only in the runtime*).

It is a process that runs beside Lumiverse, serves the loopback connection (`POST /v1/chat/completions`, `GET /v1/models`, model `lumiah`) and keeps a link to the LumiAH extension, through which it reaches everything of Lumiverse's: your connections, your chats, lore and presets, and your storage. It is one file, `dist/lumiah.js`, which ships with the extension and runs on Bun.

Replies are not all it runs. The jobs and side sessions of the chats that run in it run in it too, so the pages that show those chats' work need it linked (see *Jobs, side sessions and held calls*). What belongs to a chat that runs built in, and what belongs to no chat (your own workspace area, spend, the Agents page), needs no runtime.

It runs on the machine Lumiverse runs on, as the same account, and listens on `127.0.0.1` only, unless you tell it otherwise (read *Listening on another address* before you do).

## Install and run

Install LumiAH in Lumiverse (Extensions tab), then open **LumiAH → Runtime**. The page shows two lines with this server's own paths filled in: `<bun>` is the Bun Lumiverse runs on, and `<LumiAH's folder>` is where Lumiverse installed the extension. Run them on the machine Lumiverse runs on, as the account Lumiverse runs as.

On Linux, as a service (recommended; it starts again after a reboot or a crash):

```
<bun> <LumiAH's folder>/dist/lumiah.js up --url <the address you open Lumiverse at> --systemd
```

In the foreground, on any system (it stops when you close the terminal):

```
<bun> <LumiAH's folder>/dist/lumiah.js up --url <the address you open Lumiverse at>
```

On macOS and Windows, run the foreground line once to set the runtime up, then have the system keep it running (*Keep it running on macOS*, *Keep it running on Windows*).

`up` asks for your Lumiverse username and password once (or reads `LUMIVERSE_USERNAME` and `LUMIVERSE_PASSWORD`), signs in, registers the runtime with the extension, and starts serving. It never stores the password: it keeps the session Lumiverse gave it.

| Option | What it does | Default |
| --- | --- | --- |
| `--url <address>` | Lumiverse's address. Use the `https` address when Lumiverse is on another machine. | the address in the runtime's config, when it has one |
| `--port <n>` | The port the loopback endpoint listens on. | the first port from 7871 to 7899 that is free and that no other runtime set up on the machine holds |
| `--name <name>` | The runtime's name: one runtime per account and name. | your Lumiverse username; for another extension's runtime, `<username>-<identifier>` |
| `--systemd` | Installs and starts a systemd user service (see below). | off |
| `--memory <size>` | The service's memory cap, as systemd reads one (`768M`, `2G`). | `1G` |
| `--username <name>` | The Lumiverse account to sign in as. | asked for |
| `--allow-http` | Accepts sending the session to another machine over plain http. | off |
| `--listen <host>` | The address the loopback endpoint listens on. On any other than the default, your loopback key and every prompt cross the network in clear http: see *Listening on another address*. | `127.0.0.1` |
| `--bun <path>` | The Bun the service runs under (an absolute path). | the Bun this line runs under |
| `--extension <identifier>` | The extension the runtime links to, when LumiAH is built into another one (see *Beside an extension that includes LumiAH*). | LumiAH itself; set up again, the one the runtime linked to before |

Other commands: `lumiah status` (how the runtime and its link are doing), `lumiah login` (signs it in again when its session has ended), `lumiah down` (stops and removes the systemd service), `lumiah serve --name <name>` (what a service runs). Run each as the start line runs `up`: `<bun> <the runtime's file> status --name <name>`.

Its config is one file per runtime under `~/.config/lumiah/` (or `$XDG_CONFIG_HOME/lumiah/`; on Windows `C:\Users\<you>\.config\lumiah\`), readable by your account only. `up` prints its path.

## Check that it is linked

- **LumiAH → Runtime** shows the runtime as *linked*.
- `lumiah status` says `It answers: link to LumiAH up` and ends with exit code 0. Otherwise it says what is wrong: not running, its session ended, its link refused.
- In Lumiverse's Connections, **Test** on the loopback connection answers with its model.

## Listening on another address

By default the loopback endpoint listens on `127.0.0.1`: only programs on the same machine reach it, and nothing sent to it leaves the machine. `--listen <host>` makes it listen on another address, for a Lumiverse that can't reach the runtime's own loopback address. Know what that means before you use it; `up` says so too when it is given one.

- **The endpoint speaks plain http.** Your loopback key and every prompt and reply cross the network in clear between Lumiverse and the runtime. Whoever can read that traffic reads your chats, and holds the key that lets them send the runtime requests as your Lumiverse does.
- **So it belongs behind something that encrypts, or on a private network.** A tunnel between the two machines (SSH, WireGuard), a reverse proxy that serves HTTPS in front of the runtime, or a network only your own machines are on. Not the open internet as it is. With the tunnel's end or the proxy on the runtime's own machine, the runtime can stay on `127.0.0.1` and needs no `--listen` at all; the connection's address in Lumiverse is then the tunnel's or the proxy's.
- **Whatever reaches the port can send it requests.** Each needs your loopback key: one with no key, or with a key that isn't of a loopback key's form, is refused before any of its body is read, and whether a key is yours is checked by the extension before anything runs. Each must also be addressed to the runtime itself: its `Host` header names the address and port the runtime listens on, unless that address is a wildcard (`0.0.0.0`, `::`), which answers under any name. A reverse proxy has to send that `Host`, not its own; a tunnel keeps it when both its ends use the runtime's port. Nothing else stands between the network and the runtime.
- **`GET /healthz` says only that the runtime is up** there (`{"up": true}`). How its link is and how many replies it is writing would tell anyone who reaches the port when you are writing and what is wrong with your setup, and no key is asked for it. So those are told only to `lumiah status` and `up`, which show that they hold the runtime's config. On `127.0.0.1` it tells whoever asks, since only that machine can.

## Then, in Lumiverse

1. **LumiAH → Runtime** shows the runtime as linked.
2. **Mint the loopback key.** The linked runtime puts it in a connection named *LumiAH* (provider Custom, model `lumiah`, address `http://127.0.0.1:<port>/v1`), making that connection when you have none. With no runtime linked, the page shows the key once and you paste it into the connection's API key yourself.
3. **Switch LumiAH on for a chat, and choose the runtime for it.** That pins the chat to the loopback connection; switching it off, or setting it back to run built in, puts back the connection the chat had.
4. In **LumiAH → Settings → Agents**, pick the connection each agent uses. It must not be the loopback connection: a call on it would come back to the runtime. An agent with none set runs on the connection the chat was on before it was set to the runtime, else on the connection selected in Lumiverse, else on your default connection, never on the loopback; with none of these, its reply fails and says so.

A reply in that chat is now answered by the runtime. A chat that runs built in keeps its own connection and never reaches the runtime; a chat LumiAH isn't switched on for is untouched.

## The systemd unit

`--systemd` writes a user unit, `~/.config/systemd/user/lumiah-<name>.service`, enables it, and turns on lingering for your account so it runs without you logged in. It copies the runtime to `~/.local/share/lumiah/` first, so updating the extension never changes a running service under it. The unit it writes:

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

`MemoryMax` is the cap: past it systemd stops the runtime and starts it again, so a runaway turn can't take the machine's memory. Raise it with `up --memory 2G --systemd` when long chats need more.

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
| Port | the first free one from 7871 | the next: a port another runtime set up on the machine holds is passed over, even while that runtime is stopped |
| Loopback connection | *LumiAH*, model `lumiah` | named by the extension, model `lumiah-<identifier>` |
| Registration and loopback key | kept by LumiAH | kept by the extension |

Each of the two answers only the chats on its own loopback connection. A connection that names the other one's model is never taken for its own, whatever its address, and a key opens only the runtime of the extension that minted it. Switch a chat on in the pages of the extension that should answer it.

With several runtimes set up on the machine, `lumiah status`, `login` and `down` need `--name`; the update and sign-in lines on each Runtime page carry it, and the extension's update line carries `--extension <identifier>` as its start lines do. `up` with no `--name` means the one runtime set up there for its extension. It refuses to set a runtime up under the name of one that links to another extension, and `--port` refuses a port another runtime set up there holds: give the new one its own.

## Update

On Linux, update LumiAH in Lumiverse (Extensions → LumiAH → Update). The Runtime page then shows the runtime's build as differing from the extension's, with its update line:

```
<bun> <LumiAH's folder>/dist/lumiah.js up --name <name> --systemd
```

Run it. `up` reads the address from the runtime's config and keeps the runtime's registration, so the runtime that is running goes on answering with the secret it has. It replaces the stable copy, waits for the replies under way to finish (as long as *Wait before restart* in Settings allows: 5 minutes unless you changed it), and only then restarts the service.

On macOS and Windows, update LumiAH in Lumiverse, then, while no reply is being written, copy the new runtime over the old one and restart it. Its config and registration stay as they are.

```
cp "<LumiAH's folder>/dist/lumiah.js" ~/.local/share/lumiah/lumiah.js
launchctl kickstart -k gui/$(id -u)/lumiah.<name>
```

```powershell
Stop-ScheduledTask -TaskName "lumiah-<name>"
Copy-Item "<LumiAH's folder>\dist\lumiah.js" "$HOME\.local\share\lumiah\lumiah.js"
Start-ScheduledTask -TaskName "lumiah-<name>"
```

Given another address for Lumiverse (`--url`) or another account, `up` doesn't show the secret the runtime holds, which was minted for the address and the account it was set up with. It then registers the runtime anew, which ends the running runtime's link at once: so there it waits for the replies under way before it registers, and again before it restarts the service.

The link is versioned. When the two ends speak different link versions, the runtime's hello is refused in words that say which side to update and how, on the Runtime page, in the runtime's log, and in the reply that fails meanwhile.

## Three secrets, three jobs

| Secret | Who holds it | What it protects, and what it doesn't | Where it is stored |
| --- | --- | --- | --- |
| **The Lumiverse session** | the runtime | Your whole account: whoever holds it is you to Lumiverse. The runtime uses it to open the event socket the link travels, to make or update the loopback connection, and to ask Lumiverse to stop a reply. Lumiverse checks it; the extension never sees it. It is not narrowed to LumiAH, so keep the config file to yourself. | The runtime's config file, as the session token. The password is never stored. |
| **The relay secret** | the runtime | Tells the extension that a link request comes from a runtime your account registered, and not from a page or from another runtime. It does not keep out something else signed in as you: registering asks for your session and no secret, and answers with a new one. Under a name already taken it takes that runtime's place, unless it shows the secret that runtime holds (as `up` does when it sets the same runtime up again), and then the registration stands. So it is no second lock behind the session. Every runtime registered shows on the Runtime page. | The runtime's config; the extension keeps only its SHA-256. **Rotate** on the Runtime page sends the runtime a new one over the link. **Forget** makes it register again. |
| **The loopback key** | Lumiverse (in the loopback connection) | Proves a request on the loopback endpoint comes from your Lumiverse's connection, so another program on the machine can't use the endpoint. A request with no key, or with one that isn't of a loopback key's form, is refused before its body is read; whether the key is yours is the extension's to say, before anything runs. It says nothing of which chat or reply a request is for: the tag does that. | Lumiverse's secrets, as the connection's API key; the extension keeps only its SHA-256. Shown once when minted; minting again replaces it at once. |

Not yet: registering a runtime with a one-time code shown on the Runtime page, so that a session alone could not register one.

Each turn also carries a **tag**: the extension's prompt interceptor puts a single-use token in the request, tied to the chat and the generation, and the runtime shows it to the extension to begin the turn. A tag admits one request. A request with no tag is no turn: the runtime passes it to the writer's connection as it came, whole or not at all.

## A request with no tag

A request on the loopback connection with no tag is no reply LumiAH answers: Lumiverse made it for something else (an impersonation, a quiet call of another extension, a feature of Lumiverse's that happens to use the loopback connection). The runtime passes it to the writer's connection through Lumiverse and answers with what comes back, streamed or whole as it was asked, tool calls included. No agent runs.

It goes whole or not at all. Lumiverse's generation call carries it, and has a place for these, which go on as they came:

| In the request | Reaches the writer's connection as |
| --- | --- |
| `system`, `developer`, `user` and `assistant` messages with their text | the same; a `developer` message as a system message |
| a message's `name` | its name |
| `prefix: true` (or `partial: true`) on an assistant message | the mark that the model continues that message |
| an image, audio or video as its data: `image_url` or `video_url` with a base64 `data:` URL, `input_audio` | the image, the audio, the video |
| an assistant's `tool_calls` (function calls) and the `tool` messages after them | the calls, and each result with its call |
| an assistant's `reasoning_content` (or `reasoning`) and `reasoning_details` | the model's reasoning, as it gave it |
| `cache_control` on a message or a part | the same cache breakpoint |
| `tools` that are functions, `strict` included | the same tools |
| every other field of the body (`temperature`, `max_tokens`, `stop`, …; `tool_choice` when there are tools to choose from) | the call's parameters, as given |

Lumiverse hands these to the writer's provider, which sends on what its own API takes; a parameter the request doesn't set is the writer's connection's own. The request's `model` and `stream` are the runtime's to answer by: the writer's connection answers with its own model, and the runtime streams the answer or not as it was asked.

What can't be carried refuses the request. It is never dropped: a prompt sent on without one of its parts would mean something else, and nothing would say so. The runtime answers `400` in words that name the message and what in it can't go on, and sends nothing to the writer's connection. That is so for:

- an image, audio or video **given by its address** (`https://…`): Lumiverse takes media only as its data, and the runtime downloads nothing. Send it as a base64 `data:` URL.
- a **`file`** part, whether it holds the file's data or a provider's id for it: Lumiverse's call carries images, audio and video, and no other file.
- a `data:` URL that isn't base64, an image's `detail` other than `auto`, audio without its format.
- a part of any other kind (`refusal`, …), and a message whose role is none of `system`, `developer`, `user`, `assistant` and `tool` (`function`).
- a tool call that isn't a function call or whose arguments aren't a JSON object, and a tool that isn't a function.
- any other field of a message, a part, a tool call or a tool that holds something (`audio`, `function_call`, …). A field that is absent, null or empty holds nothing and is passed over; so is the `name` on a `tool` message, which repeats its call's.

## Jobs, side sessions and held calls

**Jobs.** A job is an agent run that outlives the reply. It runs where its chat runs: in the runtime for a chat that runs there, inside Lumiverse for a chat that runs built in. One started to run now starts at once. One started to run after the reply starts once a reply in its chat has returned: the reply that started it, or the chat's next one for a job you started yourself. Whether jobs run at all, how many at once and what each may spend are under Jobs in Settings. *Hold all jobs* in Settings (off by default) makes every running job wait at its agents' next round, and a job that begins wait at its first, until you switch it off.

**A restart interrupts a running job.** A job lives in the process that runs it. When the runtime restarts (an update, a crash, the memory cap), a job that was running in it is cut off; a job of a built-in chat is cut off the same way when the extension or Lumiverse restarts. Once the runtime has linked again (or the extension is back) the job is marked *interrupted* and you get a notice that says so; what it had written to the workspace is kept. Start it again from the Jobs page, or let an agent do it. A job that was still waiting is taken up again. `up` waits for replies under way before it restarts a service, not for jobs.

**Side sessions.** A side session's turns run where the chat it is about runs (one about no chat runs built in), one at a time for each session. The Live page follows a job or a side session's turn as it follows a reply. Stop ends one where it runs: no generation of Lumiverse's is behind it, so Lumiverse isn't asked.

**Held calls.** A tool call that waits for your word (Approval in Settings) is held by the extension and shown on every page of yours. The runtime waits with it for as long as *Wait for your word* allows. A person may take a while, so silence there is no stalled call; any other call with nothing heard for *Stream stalled after* is given up. A held call stops waiting when you answer, when its run stops, when the extension restarts, or when the extension stays out of the runtime's reach longer than *Extension lost after*.

**Pages that need the runtime.** Only what belongs to a chat that runs in the runtime: that chat's workspace area and guidance, its jobs and its side sessions. Each such request goes to the runtime that chat generates on (when you have several, the one whose connection the chat is on) and waits *Runtime wait* for it. With that runtime not linked the page says so and what to do: start the runtime again, or set the chat to run built in. Nothing is lost, and it works again once the runtime links. Everything else needs no runtime: Live, Sessions, Settings, Runtime, the Agents page, spend, upkeep, your own workspace area, and every page of a chat that runs built in.

| Setting | Default | What it does |
| --- | --- | --- |
| *Hold all jobs* | off | Every job waits until it is switched off again. |
| *Runtime wait* | 30 seconds | How long a page waits for the runtime to do what it asked about a chat that runs there. |
| *Notices kept* | 200 | How many notices of jobs (finished, failed, interrupted, waiting on you) are kept until you dismiss them. |
| *Stream stalled after* | 30 minutes | A call with nothing from the extension for this long is given up. A held call is not. |
| *Extension lost after* | 2 minutes | How long the extension may stay out of the runtime's reach before a call or a reply ends. |
| *Wait for Lumiverse's Stop* | 5 seconds | How long Lumiverse may take to answer when the runtime asks it to stop a reply (see *Stop in the Live page*). |

## When the runtime is down

The runtime way has no fallback. A chat you set to run in the runtime is answered only there: while the runtime is down (stopped, crashed, not linked, or refused because its version and the extension's differ), that chat's replies fail. LumiAH does not answer them built in in the runtime's place, and it moves no chat by itself. That is why built in is the default, and the runtime something you choose for the chats that need it.

What LumiAH does is tell you:

- **Before a reply goes.** When a reply is about to go to a runtime that isn't linked, Lumiverse shows a notice: "LumiAH's runtime isn't answering, so this reply may fail. On LumiAH's Home, set this chat to Built in, or start the runtime."
- **On LumiAH's Home.** The chat says its runtime isn't answering, and offers one tap to run it built in. The chat then gets back the connection it had, and its next reply is worked on inside Lumiverse.
- **In the failed reply,** where the runtime is still up to say it (its link was refused, or the extension is out of its reach): why, and that nothing answers in its place. Where the runtime's process is gone, the failure is Lumiverse's own, that of a connection that doesn't answer.

Start the runtime again (`systemctl --user start lumiah-<name>.service`; on macOS, `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/lumiah.<name>.plist` if you unloaded it, since launchd restarts one that stopped by itself; on Windows, `Start-ScheduledTask -TaskName "lumiah-<name>"`; or its start line) and the chat is answered there again, with nothing to set.

**A restart mid-reply** (an update, or its service stopping it) ends the reply under way with "The runtime is restarting. Press Retry in a moment."; what it had already written stays in the chat. A crash gives no time for that: the reply fails in Lumiverse's own words. Either way the chat's next reply goes to the runtime as soon as it is back.

**A dropped link mends itself.** When Lumiverse restarts or the network drops the runtime's socket, the runtime links again by itself: after a second, then waiting longer after each failure, up to 30 seconds between tries (*First reconnect wait* and *Longest reconnect wait* in Settings).

### A chat that plays only in the runtime

An extension that has LumiAH built into it may play a chat only in the runtime. Such a chat has no built-in way:

- Its pages offer no choice of place: switching it on pins it to the loopback connection by itself, even while the runtime is down, as long as a loopback connection exists. With none yet, it is refused in words that say to start a runtime and mint its key first.
- It is never worked on built in, though it was switched on built in before the extension said so: such a chat reads as off until it is switched on again.
- With the runtime down, the notice before a reply says: "<extension> plays this chat only in your runtime, which isn't answering, so this reply will fail. Start the runtime (its line is on <extension>'s Runtime page), then send your message again." Its page says the same, with the way to the Runtime page and no way to run it built in. The reply fails.
- The extension's own pages read the same state from its backend (`runtimeState`): whether the runtime is linked, and what to do when it isn't.

## Before you disable or uninstall LumiAH

Lumiverse gives an extension no moment at disable or uninstall, so LumiAH can undo nothing then. A chat set to run in the runtime stays pinned to the loopback connection, and with the extension gone its replies fail. So first set each such chat to run built in, or switch LumiAH off for it, on LumiAH's Home: either puts back the connection the chat had. If the extension is already gone, pick another connection for the chat in Lumiverse. Then stop the runtime: `lumiah down --name <name>`.

A chat that runs built in needs none of this: it is on its own connection, and without LumiAH Lumiverse writes its replies alone.

## When it doesn't link

Work down this list; each step says what to look at.

1. **Is it running?** `lumiah status`, or `systemctl --user status lumiah-<name>.service` (macOS: `launchctl print gui/$(id -u)/lumiah.<name>`; Windows: `Get-ScheduledTask -TaskName "lumiah-<name>"`). Not running: `journalctl --user -u lumiah-<name>.service -n 50` says why (the last lines are the runtime's own words; on macOS, its log file; on Windows, run its line yourself).
2. **Is LumiAH running in Lumiverse?** Extensions tab: installed, enabled, running. The Runtime page's **Issues** list names any permission LumiAH wasn't granted; grant them there.
3. **Has its session ended?** The Runtime page and `lumiah status` say so. Sign it in again: `lumiah login --name <name>` (the page shows the line), then it reconnects by itself.
4. **Do the versions differ?** The Runtime page shows the runtime as *refused*, with which side to update. Update that side (see Update).
5. **Was it forgotten or registered twice?** A runtime the extension doesn't know is refused: run its start line again, which registers it anew.
6. **Is Lumiverse behind a proxy?** The proxy must pass WebSocket upgrades on `/api/ws`; the link travels that socket. `lumiah status` reports a socket that never opens.
7. **Does Lumiverse reach the runtime?** In Connections, press **Test** on the *LumiAH* connection. It calls `GET /v1/models` on the runtime: a refusal names the cause (the key, the link, the version). The connection's address must be the one the Runtime page shows (`http://127.0.0.1:<port>/v1`); in a container, the runtime must run inside the same one as Lumiverse.
8. **Do replies wait forever on a local model?** With Lumiverse's local-inference scheduler on, the runtime's address must be among its excluded origins, or a turn waits on its own calls. The runtime adds itself; the Runtime page shows *missing* when it couldn't, and then you add `http://127.0.0.1:<port>` there yourself.

A reply the runtime fails says why in the chat, in the reply's place: what stopped it and what to do. With the runtime's process gone there is nobody to say it, and the failure is Lumiverse's own (see *When the runtime is down*).

**Stop in the Live page.** Lumiverse gives an extension no way to stop a reply, so the runtime asks it with your session, as Lumiverse's own Stop button does (`POST /api/v1/generate/stop`): Lumiverse closes the request, keeps what was written and shows the reply as stopped, not as failed. When it can't be asked (the runtime's session has ended, Lumiverse doesn't answer within *Wait for Lumiverse's Stop* in Settings, or it no longer runs that generation), the runtime ends the reply as a finished one with whatever was written, and LumiAH deletes the empty message a new reply leaves; the runtime's log says why. The Live page says where a reply was stopped: there, or in Lumiverse. A chat that runs built in has no runtime to ask: there, Stop in the Live page ends LumiAH's own work on the reply, Lumiverse writes the reply on its own, and the page says so; to stop the reply itself, press Stop in Lumiverse.

**Stop in a reply written passage by passage.** Where the agents write the reply themselves, releasing it a passage at a time or handing it to another agent whose answer streams in, Stop (in Lumiverse or in the Live page) ends the turn wherever it is. Each passage already released stays in the chat, nothing more is sent after Stop, and the extension that plays the chat is told exactly what had been released.
