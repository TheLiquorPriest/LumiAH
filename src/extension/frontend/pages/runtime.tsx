// Runtime (DESIGN §25): LumiAH answers chats in its runtime, a program the user starts beside
// Lumiverse, so this page shows its three steps until they are done, each runtime registered with
// what it said of itself and the line that mends what is wrong, the lines that start one, the
// loopback key, the loopback connection, and the chats LumiAH answers. One column on a phone, two
// where there is room. What stands where is decided in setup-model.ts.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { type ChatView, type LinkState, type RelayView, type SchedulerView, startLine, type UiState } from "../../../shared/ui";
import { useApp } from "../app";
import { chatLabel, useChatView } from "../chat";
import { Badge, Banner, Button, CopyLine, Disclosure, Section, type Tone, useBusy } from "../components";
import { ago, counted, dateTime } from "../format";
import { type RuntimeStepId, runtimeSteps, runtimeTrouble } from "../setup-model";
import { ChatSwitch, Step } from "../setup-parts";
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
  const read = useChatView(active);
  // The key just minted, shown this once where it was asked for: in the runtime's step, or on the key's own card.
  const [minted, setMinted] = useState<{ key: string; connection: { id: string; name: string } | null; from: "step" | "card" } | null>(null);
  const [switched, setSwitched] = useState<ChatView | null>(null);
  const [busy, run] = useBusy();
  if (state === null) return null;
  const now = app.now();
  const { runtime, key } = state;
  const linked = runtime.relays.filter((r) => r.link === "linked");
  const loopbacks = state.connections.filter((c) => c.loopback);
  // The open chat as last switched here, until the state or the next read of it says the same.
  const open = active === null ? null : (state.chats.find((c) => c.chatId === active) ?? (switched !== null && switched.chatId === active ? switched : read));
  const others = state.chats.filter((c) => c.chatId !== active);
  // An extension that switches its chats on in its own pages (LumiRPEngine) is named: whose chats and whose runtime these are.
  const switchedBy = runtime.switchedBy;
  const who = switchedBy ?? "LumiAH";
  const steps = runtimeSteps(state);
  const stepsDone = steps.every((s) => s.at === "done");
  const trouble = runtimeTrouble(state);

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
      const agreed = await app.host.confirm({ title: "Forget your loopback key?", message: "The loopback connection stops working until you mint a key again, so no chat's replies reach your runtime.", confirm: "Forget the key", danger: true });
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
  const showLive = (chatId: string): void => app.nav.update((n) => ({ ...n, page: "live", chatId: chatId === active ? null : chatId }));

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
  const stepBody = (id: RuntimeStepId): ComponentChildren => {
    switch (id) {
      case "start":
        return (
          <>
            <p class="lah-lead">The runtime is a small program on the machine Lumiverse runs on. It runs the agents there, with no limit on how long a turn takes.</p>
            {startLines}
          </>
        );
      case "key":
        return (
          <>
            <p class="lah-lead">The loopback key proves a request for a reply comes from your Lumiverse. {linked.length > 0 ? "Your linked runtime puts it where it belongs, so there is nothing to paste." : "No runtime is linked yet, so you would paste it yourself: do step 1 first and nothing needs pasting."}</p>
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
            <p class="lah-lead">The loopback connection is a connection of yours in Lumiverse that points at the runtime: a chat that runs in the runtime generates on it. {linked.length > 0 ? "Minting the key in step 2 makes it. Or make it by hand:" : "With a runtime linked, minting the key makes it. By hand:"}</p>
            <ConnectionSteps state={state} />
          </>
        );
    }
  };
  const stepList = (
    <ol class="lah-steps" data-lah-setup="runtime">
      {steps.map((s, i) => (
        <Step key={s.id} id={s.id} number={i + 1} at={s.at} title={s.title}>
          {s.at === "now" ? stepBody(s.id) : null}
          {s.at === "done" && s.id === "key" && minted?.from === "step" ? mintedNote : null}
        </Step>
      ))}
    </ol>
  );
  const chatRow = (chat: ChatView, isOpen: boolean): ComponentChildren => (
    <div key={chat.chatId} class="lah-chatrow">
      <ChatSwitch chat={chat} open={isOpen} title={isOpen ? `${chatLabel(chat)} (the open chat)` : chatLabel(chat)} onChanged={setSwitched}>
        {chat.on ? (
          <div class="lah-actions">
            <Button variant="ghost" icon="pulse" onClick={() => showLive(chat.chatId)}>
              Show it in Live
            </Button>
          </div>
        ) : null}
      </ChatSwitch>
    </div>
  );

  return (
    <div class="lah-runtime" data-lah-view="runtime" data-lah-runtime={stepsDone ? "ready" : "steps"}>
      <div class="lah-runtime-col lah-runtime-wide">
        {runtime.issues.map((issue) => (
          <Banner key={issue} tone="neg" title={`${who} can't work as it should`}>
            {issue}
          </Banner>
        ))}
        {runtime.ready ? (
          <Banner tone="pos" title={linked.length === 1 ? `A runtime is ready: ${linked[0]?.name ?? "linked"}` : `${linked.length} runtimes are ready`}>
            {`Every chat switched on is answered there. ${who} build ${runtime.build}, link version ${runtime.link}.${linked.some((r) => r.update) ? " A runtime's build differs: its update line is below." : ""}`}
          </Banner>
        ) : trouble !== null && (runtime.relays.length > 0 || state.chats.some((c) => c.on)) ? (
          <Banner tone="warn" title="Your runtime isn't ready">
            {`${trouble} Each runtime below says what it needs.`}
          </Banner>
        ) : (
          <Banner tone="info" title="Setting up the runtime">
            {`Three steps, below. ${who} answers no chat until they are done. ${who} build ${runtime.build}, link version ${runtime.link}.`}
          </Banner>
        )}
      </div>
      <div class="lah-runtime-col">
        {!stepsDone ? (
          <Section title="Set up a runtime" flush id="setup">
            {stepList}
          </Section>
        ) : null}
        <Section title={switchedBy !== undefined ? `Which chats ${switchedBy} plays` : "Which chats LumiAH answers"} flush id="chats">
          <ul class="lah-facts lah-runtime-places" data-lah-places>
            <li>
              <span>{switchedBy !== undefined ? `${switchedBy} switches its chats on in its own pages. A chat switched on is pinned to the runtime's connection, and the runtime prepares each of its replies.` : "A chat switched on is pinned to the runtime's connection, and the runtime prepares each of its replies."}</span>
            </li>
          </ul>
          {open ? chatRow(open, true) : null}
          {others.map((c) => chatRow(c, false))}
          {open === null && others.length === 0 ? (
            <p class="lah-lead" style={{ padding: "var(--lah-s3)" }}>
              {active === null ? (switchedBy !== undefined ? `No chat is switched on. Switch one on in ${switchedBy}'s own pages.` : "No chat is switched on. Open a chat in Lumiverse, and its switch shows here and on Home.") : "Reading the open chat…"}
            </p>
          ) : null}
        </Section>
      </div>
      <div class="lah-runtime-col">
        <Section title="Runtimes" flush id="runtimes">
          {runtime.relays.length === 0 ? (
            <p class="lah-lead" style={{ padding: "var(--lah-s3)" }}>
              None has registered yet. One shows here once its start line has run.
            </p>
          ) : (
            runtime.relays.map((r) => <Relay key={r.id} relay={r} build={runtime.build} now={now} busy={busy} onRotate={() => relay("rotate", r)} onForget={() => relay("forget", r)} />)
          )}
        </Section>
        {steps[0]?.at === "now" ? null : (
          <Section title="Start another, or start it again" id="start">
            <Disclosure summary="The lines that start a runtime for this server">{startLines}</Disclosure>
          </Section>
        )}
        <Section title="Your loopback key" id="key">
          <p data-lah-key={key.set ? "set" : "none"}>{key.set ? `Fingerprint ${key.print ?? "unknown"}${key.at !== null ? `, made ${dateTime(key.at)}` : ""}.` : "No key yet."}</p>
          <p class="lah-lead lah-small">{`The key proves a request for a reply comes from your Lumiverse. ${who} keeps only its fingerprint, never the key.`}</p>
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
          <p data-lah-loopbacks={loopbacks.length}>{loopbacks.length === 0 ? "None of your connections is the loopback yet." : `${who} takes ${loopbacks.map((c) => c.name).join(", ")} as the loopback.`}</p>
          <p class="lah-lead lah-small">A chat switched on generates on it. The agents themselves never run on the loopback, since a call there would come back to the runtime: each runs on the connection Settings name for it, else on the one its chat was on before it was pinned here, else on the connection selected in Lumiverse, else on your default connection.</p>
          <Disclosure summary="Make it by hand" defaultOpen={loopbacks.length === 0 && linked.length === 0 && steps.find((s) => s.id === "connection")?.at !== "now"}>
            <ConnectionSteps state={state} />
          </Disclosure>
        </Section>
        {stepsDone ? (
          <Section title="Set up a runtime" id="setup">
            <Disclosure summary="Done: a runtime is linked, and the key and the connection are there">{stepList}</Disclosure>
          </Section>
        ) : null}
      </div>
    </div>
  );
}
