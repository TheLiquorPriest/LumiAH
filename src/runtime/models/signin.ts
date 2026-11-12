// Signing the runtime in to Anthropic and to OpenAI through pi-ai's own flows, on the path a page
// can finish: the runtime has no browser of its own, so the page shows the flow's address, the user
// signs in wherever their browser is, and pastes back what the provider gave them. For Anthropic
// that is the code its page shows (its copy-code login); for OpenAI, the address its sign-in sent
// the browser to, which fails to open unless the browser runs on the runtime's own machine, where
// pi-ai's callback catches it and the flow finishes by itself.
//
// One flow at a time for each provider (OpenAI's callback listens on one fixed port), and a flow
// left open expires. The tokens a flow gets are kept with the book's secrets (book.ts), and pi-ai
// renews them by itself as calls need them.

import type { AuthInteraction, MutableModels } from "@earendil-works/pi-ai";
import type { Book } from "./book";
import type { SignInProvider } from "./kinds";
import { isSignInProvider } from "./kinds";
import { errorWords, failureWords, redact } from "./words";

/** How long a flow stays open: about as long as a provider's sign-in page keeps a code good, after which finishing it could only fail. */
export const SIGN_IN_MS = 10 * 60_000;

/** What a page shows to start a sign-in: the flow to finish, the address to open, and what to know first. */
export interface SignInStart {
  flow: string;
  url: string;
  note: string;
}

export interface SignInState {
  provider: SignInProvider;
  signedIn: boolean;
  /** The flow open for it, if one is. */
  flow: string | null;
}

export interface SignIn {
  start(provider: SignInProvider): Promise<SignInStart>;
  /** Finishes a flow with what the user pasted; resolves once the runtime is signed in, or rejects with why not. */
  finish(flow: string, code: string): Promise<SignInState>;
  cancel(flow: string): Promise<void>;
  /** Signs the runtime out of a provider: its tokens are forgotten. */
  out(provider: SignInProvider): Promise<void>;
  state(provider: SignInProvider): Promise<SignInState>;
}

export interface SignInDeps {
  pi: MutableModels;
  book: Book;
  id(): string;
  uuid(): string;
  log(text: string): void;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  signInMs: number;
}

/** The provider's name in words. */
const NAMES: Readonly<Record<SignInProvider, string>> = { anthropic: "Anthropic", openai: "OpenAI" };

/** What a user should know before they sign in. Anthropic's says how requests on it are sent, which pi-ai does because the sign-in requires it. */
const NOTES: Readonly<Record<SignInProvider, string>> = {
  anthropic:
    "Requests on this sign-in go to Anthropic the way Claude Code sends them: the runtime puts Claude Code's own line first in the system prompt, and writes the names of tools that share a name with one of Claude Code's the way Claude Code writes them. Open the address, sign in to your Claude account, then paste here the code Anthropic shows you.",
  openai:
    "Open the address and sign in with your ChatGPT account. Your browser then goes to an address starting with http://127.0.0.1:1455/. Where that page doesn't open, copy the whole address from the browser's address bar and paste it here. Where the browser runs on the runtime's own machine, the sign-in finishes by itself.",
};

/** The name pi-ai's OpenAI sign-in introduces the runtime by on OpenAI's page. */
const AGENT_NAME = "LumiAH";

/** Anthropic's token exchange says what went wrong inside a long report (its address, the request, a stack): its status and body are what a user can act on. */
const EXCHANGE_FAILURE = /status=(\d{3}); url=[^;]*; body=([\s\S]*?)(?:; stack=|$)/;

/** A failed sign-in's words: the provider's status and message where the flow reported them, with no secret in them. */
function failure(error: unknown, secrets: Iterable<string>): string {
  const text = errorWords(error);
  const exchange = EXCHANGE_FAILURE.exec(text);
  const words = exchange ? failureWords(`${exchange[1]}: ${exchange[2]}`) : failureWords(text.split("; stack=")[0] ?? text);
  return redact(words, secrets);
}

interface Flow {
  id: string;
  provider: SignInProvider;
  stop: AbortController;
  /** What the user pastes, for the flow's prompt for it. */
  pasted: PromiseWithResolvers<string>;
  /** The flow's end: signed in, or why not. */
  done: Promise<void>;
  timer: unknown;
}

export function createSignIn(deps: SignInDeps): SignIn & { close(): void } {
  const flows = new Map<string, Flow>();

  const openFlow = (provider: SignInProvider): Flow | undefined => [...flows.values()].find((f) => f.provider === provider);

  /** Ends a flow: its prompt and its flow are stopped with `why`, and it is no longer open. */
  const end = (flow: Flow, why: string): void => {
    if (flows.get(flow.id) !== flow) return;
    flows.delete(flow.id);
    deps.clearTimeout(flow.timer);
    const reason = new Error(why);
    flow.pasted.reject(reason);
    flow.stop.abort(reason);
  };

  const stateOf = async (provider: SignInProvider): Promise<SignInState> => ({ provider, signedIn: (await deps.book.signin(provider)) !== undefined, flow: openFlow(provider)?.id ?? null });

  return {
    async start(provider) {
      if (!isSignInProvider(provider)) throw new Error(`The runtime can sign in to Anthropic and to OpenAI, not to "${String(provider)}".`);
      const earlier = openFlow(provider);
      if (earlier !== undefined) end(earlier, "A new sign-in was started in its place.");
      const device = await deps.book.device(deps.uuid);
      const stop = new AbortController();
      const pasted = Promise.withResolvers<string>();
      // A flow that ends before anything is pasted leaves this promise unread.
      pasted.promise.catch(() => undefined);
      const address = Promise.withResolvers<string>();
      const interaction: AuthInteraction = {
        signal: stop.signal,
        async prompt(p) {
          if (p.type === "select") {
            // Anthropic asks how to sign in: its copy-code login is the one a page can finish.
            const paste = p.options.find((o) => o.id === "copy_code");
            if (paste === undefined) throw new Error("The sign-in offered no way to finish it by pasting a code.");
            return paste.id;
          }
          if (p.type !== "manual_code") throw new Error("The sign-in asked for something the runtime can't give it.");
          // OpenAI stops asking when its callback caught the browser first.
          p.signal?.addEventListener("abort", () => pasted.reject(p.signal?.reason), { once: true });
          return pasted.promise;
        },
        notify(event) {
          if (event.type === "auth_url") address.resolve(event.url);
        },
      };
      const id = deps.id();
      const flow: Flow = {
        id,
        provider,
        stop,
        pasted,
        done: Promise.resolve(),
        timer: deps.setTimeout(() => {
          const open = flows.get(id);
          if (open !== undefined) end(open, "The sign-in was left open too long.");
        }, deps.signInMs),
      };
      flow.done = deps.pi.login(provider, "oauth", interaction, { getDeviceId: () => device, agentName: AGENT_NAME }).then(
        () => {
          if (flows.get(id) === flow) {
            flows.delete(id);
            deps.clearTimeout(flow.timer);
          }
          deps.log(`signed in to ${NAMES[provider]}`);
        },
        async (error: unknown) => {
          const why = flow.stop.signal.aborted ? errorWords(flow.stop.signal.reason) : failure(error, [...(await deps.book.secretValues())]);
          if (flows.get(id) === flow) {
            flows.delete(id);
            deps.clearTimeout(flow.timer);
          }
          throw new Error(`The ${NAMES[provider]} sign-in didn't finish: ${why.replace(/[\s.]+$/, "")}. Start it again.`);
        },
      );
      // Read by `finish`, or by nobody when the flow is let go.
      flow.done.catch(() => undefined);
      flows.set(id, flow);
      const url = await Promise.race([address.promise, flow.done.then(() => Promise.reject(new Error(`The ${NAMES[provider]} sign-in ended without an address to open.`)))]);
      return { flow: id, url, note: NOTES[provider] };
    },

    async finish(flowId, code) {
      const flow = flows.get(flowId);
      if (flow === undefined) throw new Error("This sign-in is no longer open: start it again.");
      if (typeof code !== "string" || code.trim() === "") throw new Error("Paste what the provider gave you after you signed in.");
      flow.pasted.resolve(code.trim());
      await flow.done;
      return stateOf(flow.provider);
    },

    async cancel(flowId) {
      const flow = flows.get(flowId);
      if (flow !== undefined) end(flow, "The sign-in was cancelled.");
    },

    async out(provider) {
      if (!isSignInProvider(provider)) throw new Error(`The runtime can sign in to Anthropic and to OpenAI, not to "${String(provider)}".`);
      const open = openFlow(provider);
      if (open !== undefined) end(open, "The runtime was signed out.");
      await deps.pi.logout(provider);
      deps.log(`signed out of ${NAMES[provider]}`);
    },

    state: stateOf,

    close() {
      for (const flow of [...flows.values()]) end(flow, "The runtime is stopping.");
    },
  };
}
