# The runtime

The runtime is the process that runs LumiAH's agents. It runs beside Lumiverse, serves the loopback connection (`POST /v1/chat/completions`, `GET /v1/models`, model `lumiah`) and keeps a link to the LumiAH extension, through which it reaches everything of Lumiverse's: your connections, your chats, lore and presets, and your storage. It is one file, `dist/lumiah.js`, which ships with the extension and runs on Bun.

It runs on the machine Lumiverse runs on, as the same account, and listens on `127.0.0.1` only.

## Install and run

Install LumiAH in Lumiverse (Extensions tab), then open **LumiAH → Runtime**. The page shows two lines with this server's own paths filled in; copy one into a terminal on the machine Lumiverse runs on.

As a service (recommended; it starts again after a reboot):

```
<bun> <LumiAH's folder>/dist/lumiah.js up --url <the address you open Lumiverse at> --systemd
```

In the foreground (it stops when you close the terminal):

```
<bun> <LumiAH's folder>/dist/lumiah.js up --url <the address you open Lumiverse at>
```

`up` asks for your Lumiverse username and password once (or reads `LUMIVERSE_USERNAME` and `LUMIVERSE_PASSWORD`), signs in, registers the runtime with the extension, and starts serving. It never stores the password: it keeps the session Lumiverse gave it.

| Option | What it does | Default |
| --- | --- | --- |
| `--url <address>` | Lumiverse's address. Use the `https` address when Lumiverse is on another machine. | the address in the runtime's config, when it has one |
| `--port <n>` | The port the loopback endpoint listens on. | the first free port from 7871 to 7899 |
| `--name <name>` | The runtime's name: one runtime per account and name. | your Lumiverse username |
| `--systemd` | Installs and starts a systemd user service (see below). | off |
| `--memory <size>` | The service's memory cap, as systemd reads one (`768M`, `2G`). | `1G` |
| `--username <name>` | The Lumiverse account to sign in as. | asked for |
| `--allow-http` | Accepts sending the session to another machine over plain http. | off |
| `--listen <host>` | The address the loopback endpoint listens on. | `127.0.0.1` |
| `--bun <path>` | The Bun the service runs under (an absolute path). | the Bun this line runs under |

Other commands: `lumiah status` (how the runtime and its link are doing), `lumiah login` (signs it in again when its session has ended), `lumiah down` (stops and removes the service), `lumiah serve --config <file>` (what the service runs).

Its config is one file per runtime under `~/.config/lumiah/` (or `$XDG_CONFIG_HOME/lumiah/`), readable by your account only.

## Then, in Lumiverse

1. **LumiAH → Runtime** shows the runtime as linked.
2. **Mint the loopback key.** The linked runtime puts it in a connection named *LumiAH* (provider Custom, model `lumiah`, address `http://127.0.0.1:<port>/v1`), making that connection when you have none. With no runtime linked, the page shows the key once and you paste it into the connection's API key yourself.
3. **Switch LumiAH on for a chat.** That pins the chat to the loopback connection; switching it off puts back the connection the chat had.
4. In **LumiAH → Settings → Agents**, pick the connection each agent uses. It must not be the loopback connection: a call on it would come back to the runtime.

A reply in that chat is now answered by LumiAH. Any chat on another connection is untouched.

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

## Update

Update LumiAH in Lumiverse (Extensions → LumiAH → Update). The Runtime page then shows the runtime's build as differing from the extension's, with its update line:

```
<bun> <LumiAH's folder>/dist/lumiah.js up --name <name> --systemd
```

Run it. `up` reads the address from the runtime's config, waits for replies under way to finish, replaces the stable copy and restarts the service.

The link is versioned. When the two ends speak different link versions, the runtime's hello is refused in words that say which side to update, on the Runtime page and in the runtime's log.

## Three secrets, three jobs

| Secret | Who holds it | What it protects | Where it is stored |
| --- | --- | --- | --- |
| **The Lumiverse session** | the runtime | Lets the runtime reach Lumiverse as you: open the event socket the link travels, and make or update the loopback connection. Lumiverse checks it; the extension never sees it. | The runtime's config file, as the session token. The password is never stored. |
| **The relay secret** | the runtime | Proves to the extension that a link request comes from this runtime, so nothing else signed in as you can read your chats or spend your connections through the link. Minted when the runtime registers. | The runtime's config; the extension keeps only its SHA-256. **Rotate** on the Runtime page sends the runtime a new one over the link. **Forget** makes it register again. |
| **The loopback key** | Lumiverse (in the loopback connection) | Proves a completion request comes from your Lumiverse, so another program on the machine can't use the endpoint. A request without it is refused before anything runs. | Lumiverse's secrets, as the connection's API key; the extension keeps only its SHA-256. Shown once when minted; minting again replaces it at once. |

Each turn also carries a **tag**: the extension's prompt interceptor puts a single-use token in the request, tied to the chat and the generation, and the runtime shows it to the extension to begin the turn. A tag admits one request. A request with no tag is no turn: the runtime passes it to the writer's connection as it came.

## When it doesn't link

Work down this list; each step says what to look at.

1. **Is it running?** `lumiah status`, or `systemctl --user status lumiah-<name>.service`. Not running: `journalctl --user -u lumiah-<name>.service -n 50` says why (the last lines are the runtime's own words).
2. **Is LumiAH running in Lumiverse?** Extensions tab: installed, enabled, running. The Runtime page's **Issues** list names any permission LumiAH wasn't granted; grant them there.
3. **Has its session ended?** The Runtime page and `lumiah status` say so. Sign it in again: `lumiah login --name <name>` (the page shows the line), then it reconnects by itself.
4. **Do the versions differ?** The Runtime page shows the runtime as *refused*, with which side to update. Update that side (see Update).
5. **Was it forgotten or registered twice?** A runtime the extension doesn't know is refused: run its start line again, which registers it anew.
6. **Is Lumiverse behind a proxy?** The proxy must pass WebSocket upgrades on `/api/ws`; the link travels that socket. `lumiah status` reports a socket that never opens.
7. **Does Lumiverse reach the runtime?** In Connections, press **Test** on the *LumiAH* connection. It calls `GET /v1/models` on the runtime: a refusal names the cause (the key, the link, the version). The connection's address must be the one the Runtime page shows (`http://127.0.0.1:<port>/v1`); in a container, the runtime must run inside the same one as Lumiverse.
8. **Do replies wait forever on a local model?** With Lumiverse's local-inference scheduler on, the runtime's address must be among its excluded origins, or a turn waits on its own calls. The runtime adds itself; the Runtime page shows *missing* when it couldn't, and then you add `http://127.0.0.1:<port>` there yourself.

A reply that fails says why in the chat, in the reply's place: what stopped it and what to do.
