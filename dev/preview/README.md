# The LumiAH preview

LumiAH's own pages, running in a browser with no Lumiverse behind them. A stand-in for Lumiverse's drawer holds the pages, and a stand-in backend answers every message the real one would, from an invented story (a harbour town; Mara, Joss, Ilse, Brann, Okoro). No model is called, nothing is read from a real chat, and nothing you do here is kept: reload and it starts over.

It is for looking at the pages and walking through them: as a first-time user, on a phone's width, in a state that is hard to reach for real (a failed turn, a missing permission, a runtime gone quiet).

## Start it

```sh
bun dev/preview/serve.ts          # http://127.0.0.1:7895/
bun dev/preview/serve.ts 7900     # or on a port you name
```

Open the address it prints. The page is built again on every reload, so a saved change shows when you reload.

## What you see

- **On the left, a small chat.** It stands in for the chat open in Lumiverse. Type a message and send it: the stand-in plays a reply, and LumiAH's pages show the agents working on it.
- **Under the chat, the preview's own controls** (they are not part of LumiAH): which chat is open, which state the install is in, and buttons that make something happen (a reply whose agent asks first, a runtime linking, a lost push, light or dark, touch or mouse).
- **On the right, LumiAH's drawer tab**, as Lumiverse shows it. Everything in it is the real frontend.

## To walk it as a first-time user

Start from a new install, on a phone's width with touch:

```
http://127.0.0.1:7895/?scenario=fresh&pointer=coarse
```

and make the window about 360 px wide (or use the browser's device toolbar). Then do what the first screen asks: switch LumiAH on for the chat, allow what Lumiverse asks, send a message.

## What the address can ask for

| Parameter | Values | What it does |
| --- | --- | --- |
| `page` | `home` (default), `live`, `sessions`, `jobs`, `talk`, `lore`, `chronicle`, `workspace`, `guidance`, `agents`, `skills`, `tools`, `settings`, `spend`, `upkeep`, `runtime` | The page that opens. |
| `scenario` | `ready` (default), `fresh`, `trouble` | Set up, with chats answered by a linked runtime; a new install with nothing granted or switched on; a permission missing, a runtime gone quiet and one refused. |
| `chat` | `chat-mara` (default), `chat-brann`, `chat-okoro`, `chat-ilse`, `none` | The chat open in the stand-in Lumiverse. `chat-mara` and `chat-brann` are answered by the runtime, and `chat-brann` is long, with no chronicle yet; `chat-okoro`'s connection was changed since it was switched on, so its replies don't reach LumiAH; `chat-ilse` is one LumiAH doesn't answer. |
| `turn` | `done` (default), `failed`, `long`, `worked`, `running`, `working`, `none` | The open chat's latest turn. `worked` has sub-agents, file writes, an approval and a job; `running` starts one as the page opens; `working` starts one that holds a tool call for your word. |
| `pointer` | `coarse`, `fine` (left out: your device's own) | Touch or mouse: touch makes everything pressed taller. |
| `theme` | `dark` (default), `light` | The stand-in Lumiverse's theme. |
| `drawer` | `wide` (default), `default`, a width in px | The drawer's width on a desktop. |
| `showcase` | `1` | For the README's pictures: `chat-mara`'s story opens learned to its end, so Chronicle shows a whole chronicle with every line cited. |
| `settings` | `real` (default), `sample` | LumiAH's own settings and texts, or a small made-up section with every kind of control. |
| `grant` | `none` | This Lumiverse has no way for a page to ask for permissions: Home says where to grant them by hand. |
| `fail` | request types, comma-separated (for example `lah.lore.get`) | Those requests fail, to see what each page says and offers when they do. |
| `delay` | milliseconds (default 120) | How long the stand-in takes to answer. |
| `open` | a turn's index | Sessions opens that turn. |
| `section` | a settings path (for example `core.recall.meaning`) | Settings opens that section. |

`window.__lah` in the browser's console holds the stand-in backend, the stand-in host and the app's teardown, to drive by hand. `window.__lah.backend.finishSignIn("openai")` finishes an open OpenAI sign-in as if the browser ran on the runtime's own machine, so Runtime → Connections can be watched noticing it by itself.

Runtime → Connections answers from a stand-in of the runtime's own book: in `ready` the runtime holds three connections (one signed in to an Anthropic account, one on a local server that asks for no key); in `fresh` it holds none once a runtime is linked (the preview's own "link a runtime" button), so the first steps can be walked. A key typed there is never kept by the stand-in: only that one is set and its last four characters. A sign-in takes any code of the right shape (Anthropic: `something#something`; OpenAI: an address with `code=` in it).

## What it is not

It proves how the pages look and behave against the contract in `src/shared/ui.ts`. It does not prove the real backend answers that contract, or that a model does anything: those are the runtime's and the harness's own tests.
