// Runtime (DESIGN §8): whether a runtime is linked and which build it is; first-time setup, a step
// at a time; each runtime registered, with what it said of itself and the line that mends what is
// wrong; the lines that start one; the loopback key; the loopback connection; and which chats LumiAH
// answers. One column on a phone, two where there is room.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { chatAnswered, type ChatView, type LinkState, type RelayView, type SchedulerView, type SetupStepId, startLine, type UiState } from "../../../shared/ui";
import { useApp } from "../app";
import { chatLabel, useChatView } from "../chat";
import { Badge, Banner, Button, CopyLine, Disclosure, Section, Switch, type Tone, useBusy } from "../components";
import { ago, counted, dateTime } from "../format";
import { Icon } from "../icons";
import { useSelect } from "../store";

const LINK_TONE: Readonly<Record<LinkState, Tone>> = { linked: "pos", quiet: "warn", refused: "neg", down: "neutral" };
const LINK_WORDS: Readonly<Record<LinkState, string>> = { linked: "linked", quiet: "quiet", refused: "refused", down: "not running" };

const SCHEDULER_WORDS: Readonly<Record<SchedulerView, string>> = {
  excluded: "Its address is kept out of your local-inference scheduler.",
  missing: "Its address is missing from your local-inference scheduler's exclusions, and it couldn't add it. Before turning the scheduler on, add it there (Lumiverse → Settings → Inference scheduler): a turn would otherwise wait on its own calls.",
  unavailable: "This Lumiverse has no local-inference scheduler, so there is nothing to keep it out of.",
  unknown: "It hasn't checked your local-inference scheduler yet.",
};

/** What a runtime's Lumiverse session is like. */
function sessionWords(r: RelayView): string {
  if (r.session.valid === false) return "Its Lumiverse session has ended: sign it in again.";
  if (r.session.valid === null || r.session.endsAt === null) return "It couldn't ask Lumiverse about its session yet.";
  return `Its Lumiverse session lasts until ${dateTime(r.session.endsAt)}; it renews it while it runs.`;
}

/** One runtime: how it stands, what it said of itself, and the line or button that mends what is wrong. */
function Relay(props: { relay: RelayView; build: string; now: number; busy: boolean; onRotate(): void; onForget(): void }) {
  const r = props.relay;
  const signIn = r.session.valid === false || ((r.link === "quiet" || r.link === "down") && r.seenAt !== null);
  return (
    <div class="lah-relay" data-lah-relay={r.name} data-link={r.link}>
      <div class="lah-relay-head">
        <span class="lah-relay-name">{r.name}</span>
        <span class="lah-inline">
          {r.turns > 0 ? <Badge tone="accent">{`answering ${counted(r.turns, "turn")}`}</Badge> : null}
          {r.update ? <Badge tone="warn">update</Badge> : null}
          <Badge tone={LINK_TONE[r.link]}>{LINK_WORDS[r.link]}</Badge>
        </span>
      </div>
      {r.problem !== null ? <Banner tone={r.link === "refused" ? "neg" : "warn"}>{r.problem}</Banner> : null}
      <ul class="lah-facts">
        <li>
          <span>{r.seenAt === null ? `Not heard from since the extension started (registered ${dateTime(r.registeredAt)}).` : `Last heard ${ago(props.now, r.seenAt)}.`}</span>
        </li>
        <li>
          <span>{r.url === null ? "Where Lumiverse reaches it shows once it has said hello." : `Lumiverse reaches it at ${r.url}${r.host ? `, on ${r.host}` : ""}.`}</span>
        </li>
        <li>
          <span>{r.build === null ? "How it runs shows once it has said hello." : r.unit !== null ? `Runs as the service ${r.unit}: it survives logout and reboot.` : "Runs in the foreground: it stops when its terminal closes."}</span>
        </li>
        {r.build !== null ? (
          <li>
            <span>{r.update ? `Build ${r.build}; LumiAH is ${props.build}.` : `Build ${r.build}, the same as LumiAH's.`}</span>
          </li>
        ) : null}
        {r.build !== null ? (
          <li>
            <span>{SCHEDULER_WORDS[r.scheduler]}</span>
          </li>
        ) : null}
        {r.build !== null ? (
          <li>
            <span>{sessionWords(r)}</span>
          </li>
        ) : null}
      </ul>
      {r.update && r.lines.update !== null ? <CopyLine id={`update-${r.name}`} label="Update and restart it" text={r.lines.update} help="Its build differs from this LumiAH's: run this on the machine it runs on." /> : null}
      {signIn && r.lines.login !== null ? <CopyLine id={`login-${r.name}`} label="Sign it in again" text={r.lines.login} help="It has gone quiet, or its Lumiverse session has ended: run this on the machine it runs on." /> : null}
      <div class="lah-actions">
        <Button size="sm" icon="key" disabled={props.busy || r.link !== "linked"} onClick={props.onRotate}>
          Rotate its secret
        </Button>
        <Button size="sm" variant="danger" icon="trash" disabled={props.busy} onClick={props.onForget}>
          Forget it
        </Button>
      </div>
    </div>
  );
}

/** A chat and the switch that says whether LumiAH answers it. */
function ChatRow(props: { chat: ChatView; open: boolean; busy: boolean; onSwitch(on: boolean): void; onLive(): void }) {
  const { chat } = props;
  const answered = chatAnswered(chat);
  const on = chat.connection ? chat.connection.name : "no connection LumiAH can see";
  const words = answered ? (chat.on ? `LumiAH answers it: it is pinned to ${on}${chat.since !== null ? ` since ${dateTime(chat.since)}` : ""}.` : `LumiAH answers it: it generates on ${on}, a loopback connection, though LumiAH didn't pin it there.`) : chat.on ? null : `LumiAH doesn't answer it: it generates on ${on}.`;
  return (
    <div class="lah-chatrow" data-lah-chat={chat.chatId} data-answered={answered}>
      <Switch checked={chat.on} disabled={props.busy} label={<strong>{`${chatLabel(chat)}${props.open ? " (the open chat)" : ""}`}</strong>} help={chat.on ? "On: pinned to the loopback connection" : "Off"} onChange={props.onSwitch} />
      {words !== null ? <span class="lah-chatrow-sub">{words}</span> : null}
      {chat.on && !answered ? (
        <Banner tone="warn" title="Switched on, but off the loopback">
          {`It generates on ${on}, which isn't the loopback, so its replies don't reach LumiAH. Switch it off and on again to pin it back.`}
        </Banner>
      ) : null}
      {answered ? (
        <div class="lah-actions">
          <Button size="sm" variant="ghost" icon="pulse" onClick={props.onLive}>
            Show it in Live
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const STEP_TITLE: Readonly<Record<SetupStepId, string>> = {
  runtime: "Start a runtime beside Lumiverse",
  key: "Mint your loopback key",
  connection: "Have the loopback connection",
  chat: "Switch LumiAH on for a chat",
  reply: "Get a reply",
};

/** The steps a manual loopback connection takes: what goes in each field of Lumiverse's connection form. */
function ConnectionSteps(props: { state: UiState }) {
  const url = props.state.runtime.relays.find((r) => r.url !== null)?.url ?? null;
  return (
    <ol class="lah-ol" data-lah-connection-steps>
      <li>In Lumiverse, open Connections and add one with the provider Custom (OpenAI-compatible).</li>
      <li>{url !== null ? <CopyLine id="base" label="Base URL" text={url} /> : "Base URL: the address the runtime printed when it started (http://127.0.0.1:<its port>/v1 on this server)."}</li>
      <li>API key: your loopback key.</li>
      <li>
        <CopyLine id="model" label="Model" text={props.state.runtime.model} />
      </li>
      <li>Save it. Its Test lists {props.state.runtime.model} once the key checks out.</li>
    </ol>
  );
}

export function RuntimePage() {
  const app = useApp();
  const state = useSelect(app.client.state, (s) => s);
  const active = useSelect(app.host.activeChat, (c) => c);
  const asked = useChatView(active);
  // The key just minted, shown this once where it was asked for: in the setup's step, or on the key's own card.
  const [minted, setMinted] = useState<{ key: string; connection: { id: string; name: string } | null; from: "step" | "card" } | null>(null);
  const [switched, setSwitched] = useState<ChatView | null>(null);
  const [busy, run] = useBusy();
  if (state === null) return null;
  const now = app.now();
  const { runtime, setup, key } = state;
  const linked = runtime.relays.filter((r) => r.link === "linked");
  const loopbacks = state.connections.filter((c) => c.loopback);
  // The open chat as last switched here, until the state or the next read of it says the same.
  const open = active === null ? null : (state.chats.find((c) => c.chatId === active) ?? (switched !== null && switched.chatId === active ? switched : asked));
  const others = state.chats.filter((c) => c.chatId !== active);
  const firstTodo = setup.steps.find((s) => !s.done)?.id ?? null;
  const allDone = firstTodo === null;

  const mint = (from: "step" | "card"): void =>
    run(async () => {
      if (key.set) {
        const agreed = await app.host.confirm({ title: "Rotate your loopback key?", message: linked.length > 0 ? "The old key stops working at once. Your linked runtime puts the new one in the loopback connection, so replies go on." : "The old key stops working at once, and no runtime is linked to put the new one in the loopback connection: you paste it there yourself.", confirm: "Rotate the key" });
        if (!agreed) return;
      }
      try {
        const result = await app.client.request("lah.key", { op: "mint" });
        app.client.patch({ key: result.view });
        setMinted(result.key !== null ? { key: result.key, connection: result.connection, from } : null);
      } catch (error) {
        app.fail(error);
      }
    });
  const forgetKey = (): void =>
    run(async () => {
      const agreed = await app.host.confirm({ title: "Forget your loopback key?", message: "The loopback connection stops working until you mint a key again, so LumiAH answers no chat.", confirm: "Forget the key", danger: true });
      if (!agreed) return;
      try {
        const result = await app.client.request("lah.key", { op: "forget" });
        app.client.patch({ key: result.view });
        setMinted(null);
      } catch (error) {
        app.fail(error);
      }
    });
  const relay = (op: "rotate" | "forget", r: RelayView): void =>
    run(async () => {
      const agreed = await app.host.confirm(
        op === "rotate"
          ? { title: `Rotate the secret of ${r.name}?`, message: "The runtime takes the new secret over its link, and the old one stops working. Nothing else changes.", confirm: "Rotate" }
          : { title: `Forget the runtime ${r.name}?`, message: "It can no longer reach LumiAH until it registers again with its start line. A turn it is answering is lost.", confirm: "Forget it", danger: true },
      );
      if (!agreed) return;
      try {
        const result = await app.client.request("lah.relay", { op, relay: r.id });
        app.client.patch({ runtime: result.runtime });
        app.toast(op === "rotate" ? `${r.name} has a new secret.` : `${r.name} is forgotten.`);
      } catch (error) {
        app.fail(error);
      }
    });
  const switchChat = (chat: { chatId: string }, on: boolean): void =>
    run(async () => {
      try {
        const result = await app.client.request("lah.chat.set", { chatId: chat.chatId, on });
        setSwitched(result.chat);
        app.toast(on ? `LumiAH answers ${chatLabel(result.chat)} from its next reply.` : `${chatLabel(result.chat)} is back on ${result.chat.connection?.name ?? "its own connection"}.`);
      } catch (error) {
        app.fail(error);
      }
    });
  const showLive = (chatId: string): void => app.nav.set({ page: "live", chatId: chatId === active ? null : chatId });

  const startLines = (
    <>
      {runtime.start.service !== null ? <CopyLine id="start-service" label="As a service" text={startLine(runtime.start.service, app.host.origin)} help="Run it once in a terminal on the machine Lumiverse runs on. It signs in as you, registers with LumiAH and installs a service that survives logout and reboot." /> : null}
      {runtime.start.foreground !== null ? <CopyLine id="start-foreground" label="In the foreground" text={startLine(runtime.start.foreground, app.host.origin)} help="The same runtime, running until you close the terminal: handy to try it first." /> : null}
      {runtime.start.missing.length > 0 ? (
        <Banner tone="info" title="What this page couldn't fill in">
          <ul class="lah-facts">
            {runtime.start.missing.map((m) => (
              <li key={m}>
                <span>{m}</span>
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
    </>
  );
  const mintedNote = minted ? (
    <div class="lah-stack" data-lah-minted>
      <Banner tone={minted.connection ? "pos" : "warn"} title={minted.connection ? `The new key is in ${minted.connection.name}` : "Your new key, shown this once"}>
        {minted.connection ? "Your linked runtime put it in the loopback connection, so there is nothing to paste. It shows here this once, should you want it elsewhere." : "Copy it into the loopback connection's API key now. LumiAH keeps only its fingerprint, so minting again is the only way to get a key again."}
      </Banner>
      <CopyLine id="key" label="Loopback key" text={minted.key} />
      <div class="lah-actions">
        <Button size="sm" variant="ghost" icon="close" onClick={() => setMinted(null)}>
          I have it: hide it
        </Button>
      </div>
    </div>
  ) : null;
  const stepBody = (id: SetupStepId): ComponentChildren => {
    switch (id) {
      case "runtime":
        return (
          <>
            <p class="lah-lead">The runtime is a small process on the machine Lumiverse runs on. It serves the loopback connection and runs the agents.</p>
            {startLines}
          </>
        );
      case "key":
        return (
          <>
            <p class="lah-lead">The key proves a reply request comes from your Lumiverse. {linked.length > 0 ? "Your linked runtime puts it in the loopback connection for you, making that connection when there is none." : "No runtime is linked yet, so you would paste it into the connection yourself: do step 1 first and nothing needs pasting."}</p>
            <div class="lah-actions">
              <Button variant="primary" icon="key" busy={busy} onClick={() => mint("step")}>
                {key.set ? "Rotate the key" : "Mint the key"}
              </Button>
            </div>
            {minted?.from === "step" ? mintedNote : null}
          </>
        );
      case "connection":
        return (
          <>
            <p class="lah-lead">{linked.length > 0 ? "Minting the key in step 2 makes it. Lumiverse can't make a connection for an extension, so the runtime does it as you. Or make it by hand:" : "A connection of yours that points at the runtime. With a runtime linked, minting the key makes it; by hand:"}</p>
            <ConnectionSteps state={state} />
          </>
        );
      case "chat":
        return (
          <>
            <p class="lah-lead">LumiAH answers a chat whose connection is the loopback. Switching it on pins the chat to that connection; switching it off gives the chat back the connection it had.</p>
            {open ? <ChatRow chat={open} open busy={busy} onSwitch={(on) => switchChat(open, on)} onLive={() => showLive(open.chatId)} /> : <p class="lah-lead">{active === null ? "Open a chat in Lumiverse, and its switch shows here." : "Reading the open chat…"}</p>}
          </>
        );
      case "reply":
        return (
          <>
            <p class="lah-lead">Send a message in that chat. The main agent works, the reply streams into the chat, and Live shows every step as it happens.</p>
            <div class="lah-actions">
              <Button icon="pulse" onClick={() => app.nav.update((n) => ({ ...n, page: "live" }))}>
                Open Live
              </Button>
            </div>
          </>
        );
    }
  };
  const steps = (
    <ol class="lah-steps" data-lah-setup>
      {setup.steps.map((s, i) => {
        const at = s.done ? "done" : s.id === firstTodo ? "now" : "todo";
        return (
          <li key={s.id} class="lah-step" data-lah-step={s.id} data-state={at}>
            <span class="lah-step-mark" aria-hidden="true">
              {s.done ? <Icon name="check" size={16} /> : i + 1}
            </span>
            <div class="lah-step-body">
              <span class="lah-step-title">
                {STEP_TITLE[s.id]} <span class="lah-sr">{s.done ? "(done)" : at === "now" ? "(next)" : "(to do)"}</span>
              </span>
              {at === "now" ? stepBody(s.id) : null}
              {at === "done" && s.id === "key" && minted?.from === "step" ? mintedNote : null}
            </div>
          </li>
        );
      })}
    </ol>
  );

  return (
    <div class="lah-runtime" data-lah-view="runtime">
      <div class="lah-runtime-col lah-runtime-wide">
        {runtime.issues.map((issue) => (
          <Banner key={issue} tone="neg" title="LumiAH can't answer">
            {issue}
          </Banner>
        ))}
        {linked.length > 0 ? (
          <Banner tone="pos" title={linked.length === 1 ? `Linked to ${linked[0]?.name ?? "a runtime"}` : `Linked to ${linked.length} runtimes`}>
            {`LumiAH build ${runtime.build}, link version ${runtime.link}.${linked.some((r) => r.update) ? " A runtime's build differs: its update line is below." : ""}`}
          </Banner>
        ) : (
          <Banner tone="warn" title="No runtime is linked">
            {runtime.relays.length === 0 ? "None has registered, so LumiAH answers no chat yet. Start one with the line under first-time setup." : "Every runtime registered has gone quiet or was refused, so LumiAH answers no chat. Each says what it needs below."} {`LumiAH build ${runtime.build}, link version ${runtime.link}.`}
          </Banner>
        )}
      </div>
      <div class="lah-runtime-col">
        <Section title="First-time setup" flush id="setup">
          {allDone ? (
            <div style={{ padding: "0 var(--lah-s3)" }}>
              <Disclosure summary="Done: a runtime is linked, the key and the connection are there, and a chat has been answered">{steps}</Disclosure>
            </div>
          ) : (
            steps
          )}
        </Section>
        <Section title="Runtimes" flush id="runtimes">
          {runtime.relays.length === 0 ? (
            <p class="lah-lead" style={{ padding: "var(--lah-s3)" }}>
              None has registered yet.
            </p>
          ) : (
            runtime.relays.map((r) => <Relay key={r.id} relay={r} build={runtime.build} now={now} busy={busy} onRotate={() => relay("rotate", r)} onForget={() => relay("forget", r)} />)
          )}
        </Section>
        {firstTodo === "runtime" ? null : (
          <Section title="Start another, or start it again" id="start">
            <Disclosure summary="The lines that start a runtime for this server">{startLines}</Disclosure>
          </Section>
        )}
      </div>
      <div class="lah-runtime-col">
        <Section title="Your loopback key" id="key">
          <p data-lah-key={key.set ? "set" : "none"}>{key.set ? `Fingerprint ${key.print ?? "unknown"}${key.at !== null ? `, made ${dateTime(key.at)}` : ""}.` : "No key yet."}</p>
          <p class="lah-lead lah-small">The key proves a reply request comes from your Lumiverse. LumiAH keeps only its fingerprint, never the key.</p>
          <div class="lah-actions">
            <Button variant={key.set ? "secondary" : "primary"} icon="key" busy={busy} onClick={() => mint("card")}>
              {key.set ? "Rotate the key" : "Mint the key"}
            </Button>
            {key.set ? (
              <Button variant="danger" icon="trash" disabled={busy} onClick={forgetKey}>
                Forget it
              </Button>
            ) : null}
          </div>
          {minted?.from === "card" ? mintedNote : null}
        </Section>
        <Section title="The loopback connection" id="connection">
          <p data-lah-loopbacks={loopbacks.length}>{loopbacks.length === 0 ? "None of your connections is the loopback yet." : `LumiAH takes ${loopbacks.map((c) => c.name).join(", ")} as the loopback.`}</p>
          <p class="lah-lead lah-small">A chat on it is answered by LumiAH. The agents themselves run on the connections named in Settings, never on the loopback: a call there would come back to the runtime.</p>
          <Disclosure summary="Make it by hand" defaultOpen={loopbacks.length === 0 && linked.length === 0 && firstTodo !== "connection"}>
            <ConnectionSteps state={state} />
          </Disclosure>
        </Section>
        <Section title="Chats LumiAH answers" flush id="chats">
          {open ? <ChatRow chat={open} open busy={busy} onSwitch={(on) => switchChat(open, on)} onLive={() => showLive(open.chatId)} /> : null}
          {others.map((c) => (
            <ChatRow key={c.chatId} chat={c} open={false} busy={busy} onSwitch={(on) => switchChat(c, on)} onLive={() => showLive(c.chatId)} />
          ))}
          {open === null && others.length === 0 ? (
            <p class="lah-lead" style={{ padding: "var(--lah-s3)" }}>
              {active === null ? "No chat is switched on. Open a chat in Lumiverse, and its switch shows here." : "Reading the open chat…"}
            </p>
          ) : null}
        </Section>
      </div>
    </div>
  );
}
