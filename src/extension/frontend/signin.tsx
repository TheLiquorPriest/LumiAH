// Signing the runtime in to Anthropic or OpenAI (PI-BUILD-PLAN §4.3), a dialog within Runtime →
// Connections. The runtime has no browser of its own, so the sign-in happens wherever the user's
// browser is: the dialog says first what happens (for OpenAI, that it sends the browser to an
// address on the browser's own machine, which loads only where the runtime runs there too), then
// begins the flow and shows what the runtime says of it before its address (for Anthropic, how
// requests on this sign-in are sent), the address to open, and a field for what comes back (the
// code Anthropic shows; the address OpenAI sent the browser to). While an OpenAI flow is open it
// asks the runtime now and then whether the flow finished by itself. Escape, or Cancel, ends it.
//
// What the user pastes is sent once, in the request that finishes the flow, and the field is
// emptied as it goes.

import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ConnectionsView, SignInProvider, SignInStart, SignInState } from "../../shared/ui";
import { errorWords, useApp } from "./app";
import { Banner, Button, CopyLine } from "./components";
import { beforeWords, openable, pasteWords, SIGNIN_ACCOUNT, SIGNIN_NAME, withoutSecrets } from "./connections-model";
import { Icon } from "./icons";
import { revealInScroller } from "./scroll";

/** Gives an element the keyboard's focus and brings it into view within the pages' own scroller, never scrolling the host around it (`focus` alone would). */
export function focusHere(el: HTMLElement | null): void {
  if (el === null) return;
  el.focus({ preventScroll: true });
  revealInScroller(el, "nearest");
}

/** How often an open OpenAI flow is asked whether it finished by itself, in milliseconds: often enough that the dialog follows the browser within a moment, seldom enough to cost nothing. The page's own pace; it bounds nothing, so it is no setting. */
const LOOK_AGAIN_MS = 3000;

type Phase = { at: "before" } | { at: "starting" } | { at: "open"; start: SignInStart } | { at: "finishing"; start: SignInStart };

/**
 * A sign-in of the runtime `relay`, from what to know before it starts to signed in. `onDone`
 * hears the sign-in as it then stands, and the connections as the runtime then has them where its
 * answer carried them (null where the flow finished by itself, and they must be read again);
 * `onClose` hears that it was left.
 */
export function SignInDialog(props: { relay: string; provider: SignInProvider; onDone(state: SignInState, view: ConnectionsView | null): void; onClose(): void }) {
  const { provider, relay } = props;
  const app = useApp();
  const titleId = useId();
  const pasteId = useId();
  const [phase, setPhase] = useState<Phase>({ at: "before" });
  const [problem, setProblem] = useState<string | null>(null);
  const [pasted, setPasted] = useState(false);
  const paste = useRef<HTMLInputElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const name = SIGNIN_NAME[provider];
  const words = pasteWords(provider);
  const flow = phase.at === "open" || phase.at === "finishing" ? phase.start.flow : null;

  // The dialog takes the keyboard's focus as it opens, so a keyboard user starts where it does.
  useEffect(() => focusHere(head.current), []);

  // An OpenAI flow can finish by itself, where the runtime runs on the browser's machine: the runtime is asked now and then, and its word that a flow ended without a sign-in is shown.
  useEffect(() => {
    if (flow === null || provider !== "openai") return;
    let live = true;
    const look = (): void => {
      app.client.request("lah.signin.state", { relay, provider }).then(
        (state) => {
          if (!live) return;
          if (state.signedIn && state.flow === null) props.onDone(state, null);
          else if (state.flow !== flow && state.ended !== null) {
            setProblem(state.ended);
            setPhase({ at: "before" });
          }
        },
        () => undefined,
      );
    };
    const timer = setInterval(look, LOOK_AGAIN_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [flow]);

  const begin = (): void => {
    setProblem(null);
    setPhase({ at: "starting" });
    app.client.request("lah.signin.start", { relay, provider }).then(
      (start) => setPhase({ at: "open", start }),
      (error: unknown) => {
        setProblem(errorWords(error));
        setPhase({ at: "before" });
      },
    );
  };

  const finish = (): void => {
    if (phase.at !== "open") return;
    const field = paste.current;
    const code = field?.value.trim() ?? "";
    if (code === "") return;
    // What was pasted goes in this request alone: the field is emptied as it goes.
    if (field) field.value = "";
    setPasted(false);
    setProblem(null);
    setPhase({ at: "finishing", start: phase.start });
    app.client.request("lah.signin.finish", { relay, flow: phase.start.flow, code }).then(
      (done) => props.onDone(done.state, done.view),
      (error: unknown) => {
        setProblem(withoutSecrets(errorWords(error), [code]));
        setPhase({ at: "open", start: phase.start });
      },
    );
  };

  const close = (): void => {
    // A flow left open would hold OpenAI's port until it expires: it is ended with the dialog.
    if (flow !== null) app.client.request("lah.signin.cancel", { relay, flow }).catch(() => undefined);
    props.onClose();
  };

  return (
    <div
      class="lah-signin"
      role="dialog"
      aria-labelledby={titleId}
      data-lah-signin={provider}
      data-phase={phase.at}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div class="lah-signin-head">
        <h4 id={titleId} ref={head} tabIndex={-1} class="lah-signin-title">{`Sign in with ${SIGNIN_ACCOUNT[provider]}`}</h4>
      </div>
      {problem !== null ? <Banner tone="neg" title="The sign-in didn't go through">{problem}</Banner> : null}
      {phase.at === "before" || phase.at === "starting" ? (
        <>
          <p class="lah-lead">{beforeWords(provider)}</p>
          <div class="lah-actions">
            <Button variant="primary" icon="user" busy={phase.at === "starting"} onClick={begin}>
              {problem !== null ? "Begin again" : `Begin signing in to ${name}`}
            </Button>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <Banner tone="info" title="Before you open the address">
            {phase.start.note}
          </Banner>
          <ol class="lah-ol lah-signin-steps">
            <li>
              <span>{`Open this address and sign in to ${SIGNIN_ACCOUNT[provider]}:`}</span>
              <CopyLine id={`signin-${provider}`} label={`${name}'s sign-in address`} text={phase.start.url} />
              {openable(phase.start.url) ? (
                <a class="lah-btn lah-is-secondary lah-signin-open" href={phase.start.url} target="_blank" rel="noopener noreferrer">
                  <Icon name="external" size={16} />
                  <span>{`Open ${name}'s page`}</span>
                </a>
              ) : null}
            </li>
            <li>
              <label class="lah-field-label" for={pasteId}>
                {words.label}
              </label>
              <span class="lah-field-help">{words.help}</span>
              <div class="lah-signin-paste">
                <input
                  id={pasteId}
                  ref={paste}
                  class="lah-input lah-mono"
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder={words.placeholder}
                  disabled={phase.at === "finishing"}
                  onInput={(event) => setPasted(event.currentTarget.value.trim() !== "")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") finish();
                  }}
                />
                <Button variant="primary" icon="check" busy={phase.at === "finishing"} disabled={!pasted} onClick={finish}>
                  Finish signing in
                </Button>
              </div>
            </li>
          </ol>
          {provider === "openai" ? <p class="lah-field-help">Where the runtime runs on this machine, the sign-in finishes by itself once you have signed in, and this closes.</p> : null}
          <div class="lah-actions">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
