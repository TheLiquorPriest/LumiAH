// Runtime → Connections (PI-BUILD-PLAN §4.3): the connections the agents call their providers on,
// which each runtime keeps on its own machine with their keys and sign-ins. The section lists them
// (name, provider, model, how each signs, which is the default), adds and edits one, tests one,
// makes one the default, removes one after saying which agents run on it, copies Lumiverse's own
// connections (under their own ids, keys typed again one by one), and signs the runtime in to
// Anthropic and OpenAI (signin.tsx). What it shows and sends is decided in connections-model.ts.
//
// A user may have several runtimes linked, each with connections of its own: every request names
// the runtime it is about (`relay`), the section says whose connections it shows and lets the user
// switch, and a list read without naming one is that of the runtime heard from last.
//
// The list is read with a request, not pushed in the state: one store for each runtime and page app
// holds it, read when a page first shows it, again when the page comes back into view or the
// runtimes linked change, and replaced by what a change answers. The pickers of Settings and Agents,
// Home, Live and the transcripts read the store of the runtime that plays the chat they are about
// where the page knows it (`ChatView.runtime`), else of the runtime heard from last
// (`useRuntimeConnections`); the section starts on the same one.
//
// A key is the one secret a page handles. Its field is a password field the page never holds the
// text of: a save reads it from the field, sends it in that one request, and empties the field at
// once; words that come back are cleaned of it. A header's value is handled the same way.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ChatView, ConnectionAuth, ConnectionsView, RelayView, RuntimeConnection, SignInProvider, SignInState, UiState } from "../../shared/ui";
import { type App, errorWords, useApp } from "./app";
import { Badge, Banner, Button, Check, Empty, Field, Seg, Select, useBusy } from "./components";
import {
  addressHelp,
  API_WORDS,
  authLabel,
  canCall,
  type ConnectionDraft,
  type CopyRow,
  copyRows,
  copyTicked,
  draftOf,
  draftProblems,
  EFFORT_CHOICES,
  formShape,
  type HeaderDraft,
  headersOf,
  inputOf,
  isSignInProvider,
  type KnownConnections,
  keysWanted,
  listedRuntime,
  lossWords,
  modelsAsk,
  moves,
  newDraft,
  NOTHING_KNOWN,
  offerOf,
  providerName,
  removeAsk,
  saveBody,
  secretsOf,
  sendable,
  SIGNIN_ACCOUNT,
  SIGNIN_NAME,
  signInLine,
  signsWords,
  testWords,
  type TypedSecrets,
  wantWords,
  wantedOn,
  withAuth,
  withoutSecrets,
  withProvider,
} from "./connections-model";
import { Icon } from "./icons";
import { barMeasured, revealInScroller } from "./scroll";
import { focusHere, SignInDialog } from "./signin";
import { createStore, type Store, useSelect } from "./store";

// ---------------------------------------------------------------- the lists, as a page app holds them

/** The ids of the user's runtimes linked now, in order. */
function linkedIds(state: UiState | null): string[] {
  return (state?.runtime.relays ?? [])
    .filter((r) => r.link === "linked")
    .map((r) => r.id)
    .sort();
}

/**
 * One runtime's connections (`relay` null: those of the user's runtime heard from last) for one page
 * app: read while a page shows them, read again when what decides whose they are changes, and
 * replaced by what a change answers.
 */
class Held {
  readonly store: Store<KnownConnections>;
  /** Pages that show something of the list now: while none does, a reason to read it again only marks it as out of date. */
  private users = 0;
  private stale = true;
  /** The read that counts: a slower answer to an earlier read is dropped. */
  private turn = 0;
  /** What of the runtimes linked decides whose list this is: any change of them for the runtime heard from last; whether it is linked, for one named. */
  private mark: string;

  constructor(
    private readonly app: App,
    private readonly relay: string | null,
  ) {
    const ids = linkedIds(app.client.state.get());
    this.mark = this.markOf(ids);
    this.store = createStore<KnownConnections>({ ...NOTHING_KNOWN, linked: this.mark !== "", runtimes: ids.length });
    app.client.state.subscribe((state) => {
      const now = linkedIds(state);
      if (now.length !== this.store.get().runtimes) this.store.update((k) => ({ ...k, runtimes: now.length }));
      const mark = this.markOf(now);
      if (mark === this.mark) return;
      this.mark = mark;
      if (this.users > 0) this.read();
      else this.stale = true;
    });
    app.client.onBack(() => {
      if (this.users > 0) this.read();
      else this.stale = true;
    });
  }

  private markOf(ids: readonly string[]): string {
    if (this.relay === null) return ids.join(" ");
    return ids.includes(this.relay) ? this.relay : "";
  }

  /** A page that shows the list is there: it is read if it may be out of date. Answers the page's leaving. */
  use(): () => void {
    this.users += 1;
    if (this.stale) this.read();
    return () => {
      this.users -= 1;
    };
  }

  /** Reads the list now. With the runtime away there is none to read: the last one read is kept for the names it gives. */
  read(): void {
    this.stale = false;
    const turn = (this.turn += 1);
    const ids = linkedIds(this.app.client.state.get());
    if (this.markOf(ids) === "") {
      this.store.update((k) => ({ ...k, linked: false, runtimes: ids.length, failed: null, reading: false }));
      return;
    }
    this.store.update((k) => ({ ...k, linked: true, runtimes: ids.length, reading: true }));
    this.app.client.request("lah.connections.list", this.relay === null ? {} : { relay: this.relay }).then(
      (view) => {
        if (turn === this.turn) this.put(view);
      },
      (error: unknown) => {
        if (turn === this.turn) this.store.update((k) => ({ ...k, failed: errorWords(error), reading: false }));
      },
    );
  }

  /** The list as a change answered it, here and in every other list of the same runtime. */
  take(view: ConnectionsView): void {
    for (const held of heldsOf(this.app).values()) if (held === this || held.store.get().view?.relay.id === view.relay.id) held.put(view);
  }

  private put(view: ConnectionsView): void {
    this.turn += 1;
    this.stale = false;
    this.store.update((k) => ({ ...k, view, linked: true, failed: null, reading: false }));
  }
}

const HELD = new WeakMap<App, Map<string, Held>>();

function heldsOf(app: App): Map<string, Held> {
  let helds = HELD.get(app);
  if (helds === undefined) {
    helds = new Map();
    HELD.set(app, helds);
  }
  return helds;
}

function heldOf(app: App, relay: string | null): Held {
  const helds = heldsOf(app);
  let held = helds.get(relay ?? "");
  if (held === undefined) {
    held = new Held(app, relay);
    helds.set(relay ?? "", held);
  }
  return held;
}

/** A runtime's connections as this page app knows them (null: the runtime heard from last's): read when a page first shows them, and kept current while it does. */
function useConnectionsOf(relay: string | null): KnownConnections {
  const held = heldOf(useApp(), relay);
  useEffect(() => held.use(), [held]);
  return useSelect(held.store, (k) => k);
}

const NO_CHATS: readonly ChatView[] = [];

/**
 * The connections the agents of a chat run on, as this page app knows them (`listedRuntime`): a
 * page about a chat names the one it shows (null: none); a page about no chat leaves it out, and
 * the chat open in Lumiverse is taken. Those of the runtime that plays that chat where the page
 * knows it, else those of the user's runtime heard from last (`chat` says which). What the pickers
 * of Settings and Agents, Home, Live and the transcripts show.
 */
export function useRuntimeConnections(chatId?: string | null): KnownConnections {
  const app = useApp();
  const open = useSelect(app.host.activeChat, (c) => c);
  // Each part selected on its own: the list of chats changes far more often than who plays this one.
  const relay = useSelect(app.client.state, (s) => listedRuntime(s?.chats ?? NO_CHATS, chatId, open).relay);
  const shown = useSelect(app.client.state, (s) => listedRuntime(s?.chats ?? NO_CHATS, chatId, open).shown);
  const known = useConnectionsOf(relay);
  return useMemo(() => (relay === null ? known : { ...known, chat: true, ...(shown ? { shown: true as const } : {}) }), [known, relay, shown]);
}

// ---------------------------------------------------------------- the way to the section

const LED = new WeakMap<App, Store<boolean>>();

function ledOf(app: App): Store<boolean> {
  let led = LED.get(app);
  if (led === undefined) {
    led = createStore(false);
    LED.set(app, led);
  }
  return led;
}

/** Opens the Runtime page at its Connections section. */
export function leadToConnections(app: App): void {
  ledOf(app).set(true);
  app.nav.update((n) => ({ ...n, page: "runtime" }));
}

/**
 * What Home and Live say while the agents have nothing to run on: no connection at all, or none
 * that is the default, with the way to the section; where several runtimes are linked, whose list
 * it is. `chatId`: the chat the page shows, whose runtime's list it is (left out: the chat open in
 * Lumiverse). Nothing while the runtime's connections aren't known (no runtime is linked, which
 * those pages say of their own).
 */
export function ConnectionsWanted(props: { chatId?: string | null }) {
  const app = useApp();
  const known = useRuntimeConnections(props.chatId);
  const want = known.view !== null && known.linked ? wantWords(known.view) : null;
  if (want === null || known.view === null) return null;
  const on = wantedOn(known);
  return (
    <div data-lah-wanted={known.view.connections.length === 0 ? "none" : "default"}>
      <Banner
        tone="warn"
        title={want.title}
        actions={
          <Button size="sm" variant="primary" icon="plug" onClick={() => leadToConnections(app)}>
            {known.view.connections.length === 0 ? "Add a connection" : "Choose the default"}
          </Button>
        }
      >
        {want.text}
        {on !== null ? <span data-lah-wanted-on>{` ${on}`}</span> : null}
      </Banner>
    </div>
  );
}

// ---------------------------------------------------------------- the section

const INTRO =
  "A connection says which provider your agents call, at which address, and with which key or sign-in. Each agent runs on the connection Settings (or its own definition) name for it; one that names none runs on the default. Connections are kept by the runtime, on the machine it runs on: a key goes there once, when you save it, and no page ever shows it again.";

const DEFAULT_WORDS =
  "The default is what every agent that names no connection runs on, and what an agent runs on when its own connection is gone. Making another one the default moves all of those agents to it from their next call; an agent that names its own connection stays on it.";

const NO_RELAYS: readonly RelayView[] = [];

/** The section as Runtime shows it: the set-up steps' pointer while no runtime is linked, else a runtime's connections, with the choice of whose where several are linked. */
export function ConnectionsSection() {
  const app = useApp();
  const relays = useSelect(app.client.state, (s) => s?.runtime.relays ?? NO_RELAYS);
  const linked = relays.filter((r) => r.link === "linked");
  // The runtime picked here, while it stays linked; else the one that plays the open chat; else the one heard from last.
  const [picked, setPicked] = useState<string | null>(null);
  const open = useSelect(app.host.activeChat, (c) => c);
  const playing = useSelect(app.client.state, (s) => listedRuntime(s?.chats ?? NO_CHATS, undefined, open).relay);
  const relay = picked !== null && linked.some((r) => r.id === picked) ? picked : playing;
  const known = useConnectionsOf(relay);
  const held = heldOf(app, relay);
  const titleId = useId();
  const box = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const led = useSelect(ledOf(app), (l) => l);
  // The shell's page bar measured: a page freshly mounted to show this section waits for it, or the section would land under the bar.
  const measured = useSelect(barMeasured(app), (m) => m);
  // Another page led here: the section comes into view and takes the keyboard's focus.
  useLayoutEffect(() => {
    if (!led || !measured) return;
    ledOf(app).set(false);
    revealInScroller(box.current, "start");
    title.current?.focus({ preventScroll: true });
  }, [led, measured]);
  const steps = (): void => revealInScroller(box.current?.closest(".lah-runtime")?.querySelector('[data-lah-section="setup"]') ?? null, "start");
  const whose = known.view?.relay.id ?? relay ?? "";
  return (
    <section ref={box} class="lah-section lah-is-flush lah-conns-section" data-lah-section="connections" aria-labelledby={titleId}>
      <div class="lah-section-head">
        <h3 id={titleId} ref={title} tabIndex={-1} class="lah-section-title">
          Connections
        </h3>
        {known.linked && known.view !== null ? (
          <Button size="sm" variant="ghost" icon="refresh" busy={known.reading} label="Read the connections again" onClick={() => held.read()}>
            Read again
          </Button>
        ) : null}
      </div>
      <div class="lah-section-body">
        {linked.length > 1 ? (
          <div class="lah-conn-pad lah-conn-whose" data-lah-whose={whose}>
            <Field label="Whose connections" help="Each runtime keeps connections of its own: an agent runs on those of the runtime its chat runs in.">
              <Select value={whose} label="Whose connections" options={linked.map((r) => ({ value: r.id, label: r.host !== null ? `${r.name}, on ${r.host}` : r.name }))} onChange={setPicked} />
            </Field>
          </div>
        ) : null}
        {!known.linked ? (
          <div class="lah-conn-pad" data-lah-connections-state="unlinked">
            <p class="lah-lead">Your connections are kept by the runtime, so they show here once one is linked. Set one up first: its steps are on this page.</p>
            <div class="lah-actions">
              <Button icon="arrow-right" onClick={steps}>
                Show the steps
              </Button>
            </div>
          </div>
        ) : known.view === null ? (
          known.failed !== null ? (
            <div class="lah-conn-pad" data-lah-connections-state="failed">
              <Banner
                tone="neg"
                title="The runtime's connections couldn't be read"
                actions={
                  <Button icon="refresh" busy={known.reading} onClick={() => held.read()}>
                    Try again
                  </Button>
                }
              >
                {known.failed}
              </Banner>
            </div>
          ) : (
            <Empty icon="hourglass">Reading the runtime's connections…</Empty>
          )
        ) : (
          <Book key={known.view.relay.id} view={known.view} failed={known.failed} held={held} />
        )}
      </div>
    </section>
  );
}

/** What is open in the section: a connection's form (a new one, or one of the list), Copy from Lumiverse, the keys the copies wait for, or a sign-in. */
type Panel = { kind: "add" } | { kind: "edit"; id: string } | { kind: "copy" } | { kind: "keys"; ids: string[] } | { kind: "signin"; provider: SignInProvider };

/** How each provider's sign-in stands, as last asked. */
type SignIns = Partial<Record<SignInProvider, SignInState>>;

const PROVIDERS: readonly SignInProvider[] = ["anthropic", "openai"];

/** A runtime's connections, with what can be done to them. Every request names that runtime. */
function Book(props: { view: ConnectionsView; failed: string | null; held: Held }) {
  const { view, held } = props;
  const relay = view.relay.id;
  const app = useApp();
  const settings = useSelect(app.client.state, (s) => s?.settings ?? null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [tests, setTests] = useState<Readonly<Record<string, { ok: boolean; text: string } | "testing">>>({});
  const [signIns, setSignIns] = useState<SignIns>({});
  const [busy, run] = useBusy();
  /** What had the focus when a panel opened, given it back when the panel closes. */
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let live = true;
    for (const provider of PROVIDERS) {
      app.client.request("lah.signin.state", { relay, provider }).then(
        (state) => {
          if (live) setSignIns((all) => ({ ...all, [provider]: state }));
        },
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [relay]);

  const open = (next: Panel): void => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanel(next);
  };
  const close = (): void => {
    setPanel(null);
    const back = opener.current;
    opener.current = null;
    // The control that opened the panel may have gone with what the panel changed.
    if (back?.isConnected) focusHere(back);
  };
  const saved = (next: ConnectionsView, c: RuntimeConnection): void => {
    held.take(next);
    close();
    app.toast(`Saved ${c.name}.`);
  };

  const test = (c: RuntimeConnection): void => {
    setTests((all) => ({ ...all, [c.id]: "testing" }));
    app.client.request("lah.connections.test", { relay, id: c.id }).then(
      (r) => setTests((all) => ({ ...all, [c.id]: testWords(r.test) })),
      (error: unknown) => setTests((all) => ({ ...all, [c.id]: { ok: false, text: errorWords(error) } })),
    );
  };
  const makeDefault = (c: RuntimeConnection): void =>
    run(async () => {
      try {
        held.take(await app.client.request("lah.connections.default", { relay, id: c.id }));
        app.toast(`${c.name} is the default connection now.`);
      } catch (error) {
        app.fail(error);
      }
    });
  const remove = (c: RuntimeConnection): void =>
    run(async () => {
      const ask = removeAsk(c, view, settings);
      if (!(await app.host.confirm({ title: ask.title, message: ask.message, confirm: ask.confirm, danger: true }))) return;
      try {
        held.take(await app.client.request("lah.connections.remove", { relay, id: c.id }));
        if (panel?.kind === "edit" && panel.id === c.id) setPanel(null);
        app.toast(`${c.name} is removed.`);
      } catch (error) {
        app.fail(error);
      }
    });
  const signOut = (provider: SignInProvider): void =>
    run(async () => {
      const users = view.connections.filter((c) => c.auth === "signin" && c.provider === provider).map((c) => c.name);
      const message = `The runtime forgets its sign-in to ${SIGNIN_ACCOUNT[provider]}.${users.length > 0 ? ` ${users.join(", ")} ${users.length === 1 ? "signs" : "sign"} in with it, and can make no call until you sign in again.` : ""}`;
      if (!(await app.host.confirm({ title: `Sign out of ${SIGNIN_NAME[provider]}?`, message, confirm: "Sign out", danger: true }))) return;
      try {
        const out = await app.client.request("lah.signin.out", { relay, provider });
        setSignIns((all) => ({ ...all, [provider]: out.state }));
        held.take(out.view);
        app.toast(`Signed out of ${SIGNIN_NAME[provider]}.`);
      } catch (error) {
        app.fail(error);
      }
    });
  /** A sign-in finished: how it stands, and the connections that sign with it, from the answer or read again. */
  const signedIn = (state: SignInState, next: ConnectionsView | null): void => {
    setSignIns((all) => ({ ...all, [state.provider]: state }));
    if (next !== null) held.take(next);
    else held.read();
    app.toast(`Signed in with ${SIGNIN_ACCOUNT[state.provider]}.`);
  };

  const want = wantWords(view);
  const adding = panel?.kind === "add";
  return (
    <div class="lah-conns" data-lah-connections-state="ready" data-lah-relay={relay}>
      <div class="lah-conn-pad">
        <p class="lah-lead lah-small">{INTRO}</p>
        {props.failed !== null ? (
          <Banner tone="warn" title="This may be out of date">
            {`The connections couldn't be read again: ${props.failed}`}
          </Banner>
        ) : null}
        {want !== null ? (
          <Banner tone="warn" title={want.title}>
            {want.text}
          </Banner>
        ) : null}
      </div>
      {adding ? <ConnectionForm view={view} existing={null} signIns={signIns} onSignedIn={signedIn} onSaved={saved} onCancel={close} /> : null}
      {/* With no connection, the warning above says so and what to do: an empty list would only say it again. */}
      {view.connections.length === 0 ? null : (
        <div class="lah-conn-list" role="list" aria-label="Your connections">
          {view.connections.map((c) =>
            panel?.kind === "edit" && panel.id === c.id ? (
              <div key={c.id} role="listitem" class="lah-conn" data-lah-connection={c.id} data-editing>
                <ConnectionForm view={view} existing={c} signIns={signIns} onSignedIn={signedIn} onSaved={saved} onCancel={close} />
              </div>
            ) : (
              <Row key={c.id} c={c} view={view} test={tests[c.id]} busy={busy} onTest={() => test(c)} onEdit={() => open({ kind: "edit", id: c.id })} onDefault={() => makeDefault(c)} onRemove={() => remove(c)} onSignIn={(provider) => open({ kind: "signin", provider })} />
            ),
          )}
        </div>
      )}
      {view.connections.length > 1 ? (
        <div class="lah-conn-pad">
          <p class="lah-field-help" data-lah-default-words>
            {DEFAULT_WORDS}
          </p>
        </div>
      ) : null}
      <div class="lah-conn-pad lah-conn-signins" data-lah-signins>
        <span class="lah-field-label">Sign-ins</span>
        <p class="lah-field-help">The runtime can call Anthropic and OpenAI with your own account rather than a key: one sign-in to each, which every connection set to sign in with that account uses.</p>
        {PROVIDERS.map((provider) => {
          const state = signIns[provider];
          return (
            <div key={provider} class="lah-conn-signin" data-lah-signin-state={provider} data-signed-in={state?.signedIn === true || undefined}>
              <div class="lah-grow">
                <span class="lah-conn-name">{SIGNIN_NAME[provider]}</span>
                <p class="lah-field-help">{state === undefined ? "Asking the runtime…" : signInLine(state)}</p>
                {state?.ended ? <p class="lah-field-help lah-warn">{`The last sign-in didn't finish: ${state.ended}`}</p> : null}
              </div>
              {state?.signedIn === true ? (
                <Button size="sm" variant="danger" icon="power" disabled={busy} onClick={() => signOut(provider)}>
                  Sign out
                </Button>
              ) : (
                <Button size="sm" icon="user" disabled={panel?.kind === "signin"} onClick={() => open({ kind: "signin", provider })}>
                  Sign in
                </Button>
              )}
            </div>
          );
        })}
        {panel?.kind === "signin" ? (
          <SignInDialog
            relay={relay}
            provider={panel.provider}
            onDone={(state, next) => {
              signedIn(state, next);
              close();
            }}
            onClose={close}
          />
        ) : null}
      </div>
      {panel?.kind === "copy" ? (
        <CopyPanel
          view={view}
          onTake={(next) => held.take(next)}
          onDone={(next, copied) => {
            held.take(next);
            const ids = keysWanted(next, copied);
            if (ids.length > 0) setPanel({ kind: "keys", ids });
            else close();
          }}
          onClose={close}
        />
      ) : null}
      {panel?.kind === "keys" ? <KeysPanel view={view} ids={panel.ids} onTake={(next) => held.take(next)} onDone={close} /> : null}
      <div class="lah-conn-pad lah-actions lah-conn-foot">
        <Button variant={view.connections.length === 0 ? "primary" : "secondary"} icon="plus" disabled={adding} onClick={() => open({ kind: "add" })}>
          Add a connection
        </Button>
        <Button icon="download" disabled={panel?.kind === "copy" || panel?.kind === "keys"} onClick={() => open({ kind: "copy" })}>
          Copy from Lumiverse
        </Button>
      </div>
    </div>
  );
}

/** One connection: what it is, how it signs, what its test said, and what can be done to it. */
function Row(props: { c: RuntimeConnection; view: ConnectionsView; test: { ok: boolean; text: string } | "testing" | undefined; busy: boolean; onTest(): void; onEdit(): void; onDefault(): void; onRemove(): void; onSignIn(provider: SignInProvider): void }) {
  const { c, view, test } = props;
  const effort = EFFORT_CHOICES.find((e) => e.value === (c.effort ?? null));
  const headers = c.headers ?? [];
  const unset = headers.filter((h) => !h.set).map((h) => h.name);
  const signIn = c.auth === "signin" && c.signedIn !== true && isSignInProvider(c.provider) ? c.provider : null;
  return (
    <div role="listitem" class="lah-conn" data-lah-connection={c.id} data-default={c.default || undefined}>
      <div class="lah-conn-head">
        <span class="lah-conn-name">{c.name}</span>
        <span class="lah-inline">
          {c.default ? <Badge tone="accent">default</Badge> : null}
          {!canCall(c) ? <Badge tone="warn">can't call yet</Badge> : null}
        </span>
      </div>
      <ul class="lah-facts">
        <li>
          <span>{`${providerName(view, c.provider)} · ${c.model ?? "no model of its own: each agent names one"}`}</span>
        </li>
        <li>
          <span>{signsWords(c)}</span>
        </li>
        {c.baseUrl !== undefined ? (
          <li>
            <span>{`At ${c.baseUrl}${c.api !== undefined ? `, speaking ${API_WORDS[c.api] ?? c.api}` : ""}`}</span>
          </li>
        ) : null}
        {c.effort !== undefined && effort !== undefined ? (
          <li>
            <span>{`Effort when an agent leaves it to the connection: ${effort.label.toLowerCase()}`}</span>
          </li>
        ) : null}
        {headers.length > 0 ? (
          <li>
            <span>{`Headers: ${headers.map((h) => h.name).join(", ")}${unset.length > 0 ? `. ${unset.join(", ")} must be typed again: ${unset.length === 1 ? "it isn't" : "they aren't"} sent until then` : ""}`}</span>
          </li>
        ) : null}
      </ul>
      {test !== undefined ? (
        <p class={test === "testing" ? "lah-field-help" : test.ok ? "lah-line lah-pos" : "lah-line lah-neg"} role="status" data-lah-test={test === "testing" ? "testing" : test.ok ? "ok" : "failed"}>
          {test === "testing" ? (
            "Making one small call…"
          ) : (
            <>
              <Icon name={test.ok ? "check" : "alert"} size={14} />
              <span>{test.text}</span>
            </>
          )}
        </p>
      ) : null}
      <div class="lah-actions">
        {signIn !== null ? (
          <Button size="sm" variant="primary" icon="user" onClick={() => props.onSignIn(signIn)}>
            Sign in
          </Button>
        ) : null}
        <Button size="sm" icon="bolt" busy={test === "testing"} onClick={props.onTest}>
          Test
        </Button>
        <Button size="sm" icon="edit" onClick={props.onEdit}>
          Edit
        </Button>
        {!c.default ? (
          <Button size="sm" icon="check" disabled={props.busy} onClick={props.onDefault}>
            Make it the default
          </Button>
        ) : null}
        <Button size="sm" variant="danger" icon="trash" disabled={props.busy} onClick={props.onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- adding and editing one

/** A header row of the form: its draft, and a number of its own, so its value field keeps what was typed while its name changes. */
interface HeaderRow extends HeaderDraft {
  row: number;
}

/** A connection's form: a new one (`existing` null) or one of the list. */
function ConnectionForm(props: { view: ConnectionsView; existing: RuntimeConnection | null; signIns: SignIns; onSaved(view: ConnectionsView, saved: RuntimeConnection): void; onSignedIn(state: SignInState, view: ConnectionsView | null): void; onCancel(): void }) {
  const { view, existing } = props;
  const relay = view.relay.id;
  const app = useApp();
  const ids = { provider: useId(), name: useId(), address: useId(), api: useId(), model: useId(), models: useId(), effort: useId(), key: useId() };
  const [draft, setDraft] = useState<ConnectionDraft>(() => (existing !== null ? draftOf(existing) : newDraft(view)));
  const [rows, setRows] = useState<HeaderRow[] | null>(null);
  /** Whether the key field holds anything now, and which header fields do: never what they hold. */
  const [keyTyped, setKeyTyped] = useState(false);
  const [valued, setValued] = useState<ReadonlySet<number>>(new Set());
  const [refused, setRefused] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [models, setModels] = useState<{ ask: string; list: { id: string; name: string }[] | null; failed: string | null } | null>(null);
  const [saving, run] = useBusy();
  const keyField = useRef<HTMLInputElement>(null);
  const valueFields = useRef(new Map<number, HTMLInputElement>());
  const nextRow = useRef(0);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => focusHere(head.current), []);

  const shape = formShape(draft, view);
  const headerDrafts = rows?.map(({ row: _row, ...h }) => h) ?? null;
  const valuedNames = new Set((rows ?? []).filter((r) => valued.has(r.row)).map((r) => r.name));
  const problems = draftProblems({ ...draft, headers: headerDrafts }, shape, valuedNames);
  const loss = lossWords(existing, { ...draft, headers: headerDrafts }, { key: keyTyped, headers: valuedNames });
  // Saving sends the connection to another server: what is stored for the old one goes unless it is typed again.
  const moving = existing !== null && moves(existing, draft);
  const ask = modelsAsk(draft, existing, shape);
  const askKey = ask === null ? null : JSON.stringify(ask);
  const shownModels = models !== null && models.ask === askKey ? models : null;
  const signIn = shape.signIn !== null ? (props.signIns[shape.signIn] ?? null) : null;
  const set = (change: Partial<ConnectionDraft>): void => setDraft((d) => ({ ...d, ...change }));

  // The models offered are read the first time the model field is used, and again for another provider or address.
  const listModels = (): void => {
    if (ask === null || askKey === null || models?.ask === askKey) return;
    setModels({ ask: askKey, list: null, failed: null });
    app.client.request("lah.connections.models", { relay, ...ask }).then(
      (r) => setModels((m) => (m?.ask === askKey ? { ask: askKey, list: r.models, failed: null } : m)),
      (error: unknown) => setModels((m) => (m?.ask === askKey ? { ask: askKey, list: null, failed: errorWords(error) } : m)),
    );
  };
  const save = (): void =>
    run(async () => {
      // The key and the headers' values are read from their fields now, go in this request alone, and leave the page with it: the fields are emptied at once, whatever the answer.
      const typed: TypedSecrets = { key: keyField.current?.value ?? "", headers: new Map((rows ?? []).map((r) => [r.name.trim(), valueFields.current.get(r.row)?.value ?? ""])) };
      if (keyField.current) keyField.current.value = "";
      for (const field of valueFields.current.values()) field.value = "";
      setKeyTyped(false);
      setValued(new Set());
      setRefused(null);
      try {
        const answer = await app.client.request("lah.connections.save", { relay, ...saveBody({ ...draft, headers: headerDrafts }, shape, typed) });
        props.onSaved(answer.view, answer.saved);
      } catch (error) {
        const words = withoutSecrets(errorWords(error), secretsOf(typed));
        setRefused(typed.key.trim() !== "" ? `${words} The key you typed wasn't kept: paste it again.` : words);
      }
    });

  const offer = shape.offer;
  const modelHelp = shownModels?.list
    ? `The model an agent uses on it when it names none. ${shownModels.list.length === 0 ? "The provider lists no models here: type the model's name." : `${shownModels.list.length} offered: start typing to pick one.`}`
    : shownModels?.failed
      ? `The models couldn't be listed (${shownModels.failed}): type the model's name.`
      : ask === null
        ? "The model an agent uses on it when it names none. Type its name: the server's own list shows here once the connection is saved."
        : "The model an agent uses on it when it names none. Pick one of the provider's, or type a name.";
  return (
    <div class="lah-conn-form" data-lah-connection-form={existing?.id ?? "new"}>
      <h4 ref={head} tabIndex={-1} class="lah-conn-form-title">
        {existing !== null ? `Edit ${existing.name}` : "A new connection"}
      </h4>
      <Field label="Provider" for={ids.provider} help={offer?.needsBaseUrl === true ? "Any server that speaks this API: a proxy, a server on your own machine, or a provider not listed here." : undefined}>
        <Select id={ids.provider} value={draft.provider} options={view.providers.map((p) => ({ value: p.id, label: p.name }))} disabled={saving} onChange={(provider) => setDraft((d) => withProvider(d, view, provider))} />
      </Field>
      <Field label="Name" for={ids.name} help="How the pages and the agents' pickers call it." error={problems.name}>
        <input id={ids.name} class="lah-input" value={draft.name} autocomplete="off" disabled={saving} aria-invalid={problems.name !== null || undefined} onInput={(event) => set({ name: event.currentTarget.value })} />
      </Field>
      {shape.auths.length > 1 ? (
        <Field label="How it signs its calls">
          <Seg<ConnectionAuth> label="How it signs its calls" value={draft.auth} options={shape.auths.map((auth) => ({ value: auth, label: authLabel(auth, draft.provider) }))} disabled={saving} onChange={(auth) => setDraft((d) => withAuth(d, auth))} />
        </Field>
      ) : null}
      {shape.address !== "none" ? (
        <Field label={shape.address === "needed" ? "The server's address" : "Base URL (optional)"} for={ids.address} help={addressHelp(shape)} error={problems.address}>
          <input id={ids.address} class="lah-input lah-mono" type="url" inputMode="url" value={draft.baseUrl} autocomplete="off" spellcheck={false} placeholder={shape.address === "needed" ? "http://127.0.0.1:8080/v1" : "Its own address"} disabled={saving} aria-invalid={problems.address !== null || undefined} onInput={(event) => set({ baseUrl: event.currentTarget.value })} />
        </Field>
      ) : null}
      {shape.apis !== null ? (
        <Field label="The API it speaks" for={ids.api} help="Most servers speak Chat Completions. Pick Responses only where the server's own documents say it speaks it.">
          <Select id={ids.api} value={draft.api === "" ? (shape.apis[0] ?? "") : draft.api} options={shape.apis.map((api) => ({ value: api, label: API_WORDS[api] ?? api }))} disabled={saving} onChange={(api) => set({ api })} />
        </Field>
      ) : null}
      <Field label="Model" for={ids.model} help={modelHelp}>
        <input id={ids.model} class="lah-input lah-mono" value={draft.model} list={ids.models} autocomplete="off" spellcheck={false} placeholder="A model's name" disabled={saving} onFocus={listModels} onInput={(event) => set({ model: event.currentTarget.value })} />
        <datalist id={ids.models}>
          {(shownModels?.list ?? []).map((m) => (
            <option key={m.id} value={m.id} label={m.name !== m.id ? m.name : undefined} />
          ))}
        </datalist>
      </Field>
      <Field label="Effort" for={ids.effort} help="How much the model thinks when an agent leaves the effort to the connection. An agent that sets its own effort keeps it.">
        <Select id={ids.effort} value={draft.effort ?? ""} options={EFFORT_CHOICES.map((e) => ({ value: e.value ?? "", label: e.label }))} disabled={saving} onChange={(value) => set({ effort: EFFORT_CHOICES.find((e) => (e.value ?? "") === value)?.value ?? null })} />
      </Field>
      {draft.auth === "key" ? (
        <Field
          label="API key"
          for={ids.key}
          help={
            existing?.key?.set === true
              ? `A key is set${existing.key.last4 !== null ? `, ending in ${existing.key.last4}` : ""}. Leave this empty to keep it, or paste another to replace it.`
              : "Paste the provider's key. It goes to the runtime once, when you save, and no page shows it again: only its last four characters."
          }
        >
          <input id={ids.key} ref={keyField} class="lah-input lah-mono" type="password" autocomplete="off" spellcheck={false} placeholder={existing?.key?.set === true ? (moving ? "Paste it again: the stored one goes with the change" : "Kept as it is") : "Paste the key"} disabled={saving || draft.clearKey} onInput={(event) => setKeyTyped(event.currentTarget.value !== "")} />
          {existing?.key?.set === true ? <Check checked={draft.clearKey} label="Take the stored key away" help="The connection keeps no key until you paste one: its calls are refused until then." disabled={saving || keyTyped} onChange={(clearKey) => set({ clearKey })} /> : null}
        </Field>
      ) : null}
      {shape.signIn !== null ? (
        <div class="lah-conn-signin" data-lah-form-signin={shape.signIn}>
          <p class="lah-grow lah-field-help">{signIn !== null ? signInLine(signIn) : `It signs in with ${SIGNIN_ACCOUNT[shape.signIn]}: one sign-in for every connection that does.`}</p>
          {signIn?.signedIn !== true && !signingIn ? (
            <Button size="sm" icon="user" onClick={() => setSigningIn(true)}>
              Sign in
            </Button>
          ) : null}
        </div>
      ) : null}
      {signingIn && shape.signIn !== null ? (
        <SignInDialog
          relay={relay}
          provider={shape.signIn}
          onDone={(state, next) => {
            setSigningIn(false);
            props.onSignedIn(state, next);
          }}
          onClose={() => setSigningIn(false)}
        />
      ) : null}
      {shape.address !== "none" ? (
        <div class="lah-conn-headers" data-lah-headers>
          {rows === null ? (
            <Button size="sm" variant="ghost" icon="list" disabled={saving} onClick={() => setRows(headersOf(existing).map((h) => ({ ...h, row: (nextRow.current += 1) })))}>
              {(existing?.headers ?? []).length > 0 ? `Headers (${(existing?.headers ?? []).length})` : "Headers, for a proxy that asks for its own"}
            </Button>
          ) : (
            <Field label="Headers" help="Sent with every call on it. A value is kept like a key: never shown again, only replaced. Leave a value empty to keep the one stored." error={problems.headers}>
              {rows.map((r) => (
                <div key={r.row} class="lah-conn-header" data-lah-header={r.name}>
                  <input
                    class="lah-input lah-mono"
                    aria-label="The header's name"
                    value={r.name}
                    autocomplete="off"
                    spellcheck={false}
                    placeholder="X-Header-Name"
                    disabled={saving || r.known}
                    onInput={(event) => {
                      const name = event.currentTarget.value;
                      setRows((all) => (all ?? []).map((x) => (x.row === r.row ? { ...x, name } : x)));
                    }}
                  />
                  <input
                    ref={(el) => {
                      if (el) valueFields.current.set(r.row, el);
                      else valueFields.current.delete(r.row);
                    }}
                    class="lah-input lah-mono"
                    type="password"
                    aria-label={`The value of ${r.name || "the header"}`}
                    autocomplete="off"
                    spellcheck={false}
                    placeholder={r.known && r.set ? (moving ? "Type it again: the stored one goes with the change" : "Kept as it is") : r.known ? "Type it again: it was dropped" : "Its value"}
                    disabled={saving}
                    onInput={(event) => {
                      const typed = event.currentTarget.value !== "";
                      setValued((all) => {
                        const next = new Set(all);
                        if (typed) next.add(r.row);
                        else next.delete(r.row);
                        return next;
                      });
                    }}
                  />
                  <Button size="sm" variant="ghost" icon="trash" label={`Take ${r.name || "this header"} away`} disabled={saving} onClick={() => setRows((all) => (all ?? []).filter((x) => x.row !== r.row))}>
                    Remove
                  </Button>
                </div>
              ))}
              <div class="lah-actions">
                <Button size="sm" icon="plus" disabled={saving} onClick={() => setRows((all) => [...(all ?? []), { name: "", known: false, set: false, row: (nextRow.current += 1) }])}>
                  Add a header
                </Button>
              </div>
            </Field>
          )}
        </div>
      ) : null}
      {loss !== null ? (
        <p class="lah-line lah-is-warn" role="alert" data-lah-loss>
          <Icon name="alert" size={14} />
          <span>{loss}</span>
        </p>
      ) : null}
      {refused !== null ? (
        <Banner tone="neg" title="Not saved">
          {refused}
        </Banner>
      ) : null}
      <div class="lah-actions">
        <Button variant="primary" icon="check" busy={saving} disabled={!sendable(problems)} onClick={save}>
          {existing !== null ? "Save" : "Add it"}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- copy from Lumiverse

/** Lumiverse's own connections, to copy: each with what it becomes, ticked where it can be copied and isn't yet. A copy keeps its id and comes without its key. */
function CopyPanel(props: { view: ConnectionsView; onTake(view: ConnectionsView): void; onDone(view: ConnectionsView, copied: string[]): void; onClose(): void }) {
  const relay = props.view.relay.id;
  const app = useApp();
  const titleId = useId();
  const head = useRef<HTMLHeadingElement>(null);
  const lumiverse = useSelect(app.client.state, (s) => s?.connections ?? null);
  const [listed, setListed] = useState<{ rows: CopyRow[] } | { failed: string } | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [said, setSaid] = useState<Readonly<Record<string, string>>>({});
  const [copying, run] = useBusy();
  /** What the copies made so far: the list as the last of them answered it, and their ids, which the keys are asked for. */
  const last = useRef(props.view);
  const copied = useRef<string[]>([]);
  useEffect(() => focusHere(head.current), []);
  useEffect(() => {
    let live = true;
    app.client.request("lah.connections.lumiverse", {}).then(
      (r) => {
        if (!live) return;
        const rows = copyRows(r.connections, new Set((lumiverse ?? []).filter((c) => c.loopback).map((c) => c.id)), props.view);
        setListed({ rows });
        setTicked(copyTicked(rows));
      },
      (error: unknown) => {
        if (live) setListed({ failed: errorWords(error) });
      },
    );
    return () => {
      live = false;
    };
  }, []);
  const rows = listed !== null && "rows" in listed ? listed.rows : [];
  const copy = (): void =>
    run(async () => {
      const failures: Record<string, string> = {};
      for (const row of rows) {
        if (!ticked.has(row.id) || row.input === null) continue;
        try {
          const answer = await app.client.request("lah.connections.save", { relay, connection: row.input, create: true });
          last.current = answer.view;
          copied.current.push(row.id);
          props.onTake(answer.view);
        } catch (error) {
          failures[row.id] = errorWords(error);
        }
      }
      setSaid(failures);
      const made = copied.current.length;
      if (made > 0) app.toast(`Copied ${made === 1 ? "one connection" : `${made} connections`}.`);
      // Where one failed, the panel stays to say why; the keys of those copied are asked for once it is left.
      if (Object.keys(failures).length === 0) props.onDone(last.current, copied.current);
      else setTicked(new Set(Object.keys(failures)));
    });
  const failed = Object.keys(said).length > 0;
  return (
    <div class="lah-conn-pad lah-conn-panel" role="group" aria-labelledby={titleId} data-lah-copy>
      <h4 id={titleId} ref={head} tabIndex={-1} class="lah-conn-form-title">
        Copy from Lumiverse
      </h4>
      <p class="lah-field-help">Each copy keeps its name, its provider, its address and its model, and the same id, so a setting that named it still does. Keys aren't copied: Lumiverse never shows one. Once copied, you are asked for each key in turn.</p>
      {listed === null ? <p class="lah-field-help">Reading Lumiverse's connections…</p> : null}
      {listed !== null && "failed" in listed ? (
        <Banner tone="neg" title="Lumiverse's connections couldn't be read">
          {listed.failed}
        </Banner>
      ) : null}
      {listed !== null && "rows" in listed && rows.length === 0 ? <p class="lah-field-help">Lumiverse has no connection to copy: the runtime's own loopback isn't one.</p> : null}
      {rows.map((row) => (
        <div key={row.id} class="lah-conn-copyrow" data-lah-copy-row={row.id}>
          <Check
            checked={ticked.has(row.id)}
            label={`${row.name} (${row.from})`}
            help={said[row.id] !== undefined ? `Not copied: ${said[row.id]}` : (row.why ?? `Becomes ${row.to}${row.input?.model ? `, ${row.input.model}` : ""}.`)}
            disabled={copying || row.input === null || row.there}
            onChange={(on) =>
              setTicked((all) => {
                const next = new Set(all);
                if (on) next.add(row.id);
                else next.delete(row.id);
                return next;
              })
            }
          />
        </div>
      ))}
      <div class="lah-actions">
        <Button variant="primary" icon="download" busy={copying} disabled={ticked.size === 0} onClick={copy}>
          {ticked.size === 1 ? "Copy it" : `Copy ${ticked.size}`}
        </Button>
        <Button variant="ghost" disabled={copying} onClick={() => (failed && copied.current.length > 0 ? props.onDone(last.current, copied.current) : props.onClose())}>
          {failed ? "Done" : "Cancel"}
        </Button>
      </div>
    </div>
  );
}

/** The keys the copies wait for, one at a time: each pasted goes to the runtime with its connection and leaves the page; a server that asks for none can say so; any may wait for later. */
function KeysPanel(props: { view: ConnectionsView; ids: string[]; onTake(view: ConnectionsView): void; onDone(): void }) {
  const relay = props.view.relay.id;
  const app = useApp();
  const titleId = useId();
  const keyId = useId();
  const head = useRef<HTMLHeadingElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [at, setAt] = useState(0);
  const [typed, setTyped] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [saving, run] = useBusy();
  const c = props.view.connections.find((x) => x.id === props.ids[at]) ?? null;
  useEffect(() => focusHere(head.current), [at]);
  const next = (): void => {
    setRefused(null);
    if (at + 1 >= props.ids.length) props.onDone();
    else setAt(at + 1);
  };
  const save = (auth: "key" | "none"): void =>
    run(async () => {
      if (c === null) return;
      // The key leaves the page with this request: the field is emptied at once, whatever the answer.
      const key = auth === "key" ? (field.current?.value ?? "") : "";
      if (field.current) field.current.value = "";
      setTyped(false);
      try {
        const answer = await app.client.request("lah.connections.save", auth === "key" ? { relay, connection: inputOf(c), key: key.trim() } : { relay, connection: { ...inputOf(c), auth: "none" } });
        props.onTake(answer.view);
        next();
      } catch (error) {
        setRefused(`${withoutSecrets(errorWords(error), [key])}${key.trim() !== "" ? " The key you typed wasn't kept: paste it again." : ""}`);
      }
    });
  if (c === null) return null;
  const none = offerOf(props.view, c.provider)?.auth.includes("none") === true;
  return (
    <div class="lah-conn-pad lah-conn-panel" role="group" aria-labelledby={titleId} data-lah-keys={c.id}>
      <h4 id={titleId} ref={head} tabIndex={-1} class="lah-conn-form-title">
        {`The key for ${c.name}${props.ids.length > 1 ? ` (${at + 1} of ${props.ids.length})` : ""}`}
      </h4>
      <p class="lah-field-help">{`${providerName(props.view, c.provider)}${c.baseUrl !== undefined ? ` at ${c.baseUrl}` : ""}. Paste its key: it goes to the runtime once, and no page shows it again.`}</p>
      <label class="lah-field-label" for={keyId}>
        API key
      </label>
      <input
        id={keyId}
        ref={field}
        class="lah-input lah-mono"
        type="password"
        autocomplete="off"
        spellcheck={false}
        placeholder="Paste the key"
        disabled={saving}
        onInput={(event) => setTyped(event.currentTarget.value.trim() !== "")}
        onKeyDown={(event) => {
          if (event.key === "Enter" && typed) save("key");
        }}
      />
      {refused !== null ? (
        <Banner tone="neg" title="Not saved">
          {refused}
        </Banner>
      ) : null}
      <div class="lah-actions">
        <Button variant="primary" icon="key" busy={saving} disabled={!typed} onClick={() => save("key")}>
          Save the key
        </Button>
        {none ? (
          <Button disabled={saving} onClick={() => save("none")}>
            It needs no key
          </Button>
        ) : null}
        <Button variant="ghost" disabled={saving} onClick={next}>
          {at + 1 >= props.ids.length ? "Later" : "Later: the next one"}
        </Button>
      </div>
    </div>
  );
}
