// The stand-in backend's connections and sign-ins (PI-BUILD-PLAN §4.3), as each of the user's
// runtimes keeps them: a book of connections for each runtime, the default among them, and its
// sign-ins to Anthropic and OpenAI. Requests name the runtime (`relay`), or go to the one heard from
// last; with none linked, or with the one named away, they are refused as the real backend refuses
// them. It checks what it is asked to keep as the runtime does, so a page's mistakes show.
//
// A key it is sent is never kept: of it the stand-in keeps only that one is set and, for a key long
// enough, its last four characters, which is all a page is ever shown; a header's value the same.
// A sign-in is finished by any code of the right shape; an OpenAI flow can be finished as if the
// browser were on the runtime's machine (`finishByItself`), to watch a page notice it by itself.

import type { ConnectionsView, LumiverseConnection, ModelChoice, ProviderOffer, RelayView, RuntimeConnection, SignInProvider, SignInState } from "../../../src/shared/ui";
import { type Handlers, type MockCtx, Refusal } from "./ctx";

type Requests = "lah.connections.list" | "lah.connections.save" | "lah.connections.remove" | "lah.connections.default" | "lah.connections.test" | "lah.connections.models" | "lah.connections.lumiverse" | "lah.signin.start" | "lah.signin.finish" | "lah.signin.cancel" | "lah.signin.out" | "lah.signin.state";

/** The providers a runtime offers, as the runtime lists them. */
export const PROVIDERS: ProviderOffer[] = [
  { id: "anthropic", name: "Anthropic", auth: ["key", "signin"], apis: ["anthropic-messages"], needsBaseUrl: false },
  { id: "openai", name: "OpenAI", auth: ["key", "signin"], apis: ["openai-responses"], needsBaseUrl: false },
  { id: "google", name: "Google Gemini", auth: ["key"], apis: ["google-generative-ai"], needsBaseUrl: false },
  { id: "openrouter", name: "OpenRouter", auth: ["key"], apis: ["openai-completions"], needsBaseUrl: false },
  { id: "deepseek", name: "DeepSeek", auth: ["key"], apis: ["openai-completions"], needsBaseUrl: false },
  { id: "xai", name: "xAI", auth: ["key"], apis: ["openai-responses"], needsBaseUrl: false },
  { id: "groq", name: "Groq", auth: ["key"], apis: ["openai-completions"], needsBaseUrl: false },
  { id: "mistral", name: "Mistral", auth: ["key"], apis: ["mistral-conversations"], needsBaseUrl: false },
  { id: "openai-compatible", name: "OpenAI-compatible", auth: ["key", "none"], apis: ["openai-completions", "openai-responses"], needsBaseUrl: true },
  { id: "anthropic-compatible", name: "Anthropic-compatible", auth: ["key", "none"], apis: ["anthropic-messages"], needsBaseUrl: true },
];

/** Each provider's own list of models, as its catalogue names them; a compatible server has none until its address is known. */
const CATALOGUE: Readonly<Record<string, ModelChoice[]>> = {
  anthropic: [
    { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
  openai: [
    { id: "gpt-5", name: "GPT-5" },
    { id: "gpt-5-mini", name: "GPT-5 mini" },
  ],
  google: [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ],
  openrouter: [{ id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
  deepseek: [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  ],
  xai: [{ id: "grok-4", name: "Grok 4" }],
  groq: [{ id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" }],
  mistral: [{ id: "mistral-large-latest", name: "Mistral Large" }],
};

/** What a compatible server lists of its own, by its address. */
const SERVED: Readonly<Record<string, ModelChoice[]>> = { "http://127.0.0.1:8080/v1": [{ id: "llama-local", name: "llama-local" }] };

/** The connections a set-up runtime keeps: Deepseek, copied from Lumiverse under its own id with its key typed again; Claude on the user's own account; and a server on the same machine that asks for no key. */
function setUp(): RuntimeConnection[] {
  return [
    { id: "conn-deepseek", name: "Deepseek", provider: "deepseek", auth: "key", model: "deepseek-v4-flash", default: true, key: { set: true, last4: "9f2c" } },
    { id: "rc-claude", name: "Claude", provider: "anthropic", auth: "signin", model: "claude-sonnet-4-5", effort: "medium", default: false, key: null, signedIn: true },
    { id: "rc-local", name: "Local llama", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", api: "openai-completions", model: "llama-local", default: false, key: null },
  ];
}

/** Lumiverse's own connection profiles, as Copy from Lumiverse lists them: never a key. The loopback is among them, as it is in Lumiverse; the page leaves it out. */
export const LUMIVERSE_CONNECTIONS: LumiverseConnection[] = [
  { id: "conn-loopback", name: "LumiAH loopback", provider: "custom", baseUrl: "http://127.0.0.1:7861/v1", model: "lumiah" },
  { id: "conn-deepseek", name: "Deepseek", provider: "deepseek", baseUrl: null, model: "deepseek-v4-flash" },
  { id: "conn-local", name: "Local llama", provider: "custom", baseUrl: "http://127.0.0.1:8080/v1", model: "llama-local" },
  { id: "conn-nano", name: "NanoGPT", provider: "nanogpt", baseUrl: null, model: "deepseek-ai/deepseek-v4" },
  { id: "conn-claude-proxy", name: "Claude through the proxy", provider: "anthropic", baseUrl: "https://proxy.harbour.example/anthropic", model: "claude-sonnet-4-5" },
  { id: "conn-bedrock", name: "Bedrock", provider: "bedrock", baseUrl: null, model: "anthropic.claude-sonnet-4-5" },
];

const HOUR = 3_600_000;

/** A runtime's book as the stand-in keeps it: its connections as a page sees them, with no secret among them, and the default. */
interface Book {
  connections: RuntimeConnection[];
  default: string | null;
  signins: Record<SignInProvider, { signedIn: boolean; until: number | null; ended: string | null }>;
}

/** A sign-in flow open: whose runtime, which provider. */
interface Flow {
  relay: string;
  provider: SignInProvider;
}

const NAMES: Readonly<Record<SignInProvider, string>> = { anthropic: "Anthropic", openai: "OpenAI" };

/** What the runtime says before its address is opened: how requests on Anthropic's sign-in are sent; what OpenAI's sends the browser to. The stand-in's words, in the runtime's place. */
const NOTES: Readonly<Record<SignInProvider, string>> = {
  anthropic: "Requests on this sign-in go to Anthropic the way Claude Code sends them: the runtime puts Claude Code's own line first in the system prompt, and writes the names of tools that share a name with one of Claude Code's the way Claude Code writes them. Open the address, sign in to your Claude account, then paste here the code Anthropic shows you.",
  openai: "Open the address and sign in with your ChatGPT account. Your browser then goes to an address starting with http://localhost:1455/. Where that page doesn't open, copy the whole address from the browser's address bar and paste it here. Where the browser runs on the runtime's own machine, the sign-in finishes by itself.",
};

/** An address checked as the runtime checks one; the words a page shows where it isn't one. */
function addressOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Refusal("invalid", `"${raw}" isn't an address: give one such as https://example.com/v1.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Refusal("invalid", `"${raw}" isn't an http or https address.`);
  if (url.username !== "" || url.password !== "") throw new Refusal("invalid", "An address can't carry a name and password: put the key in the key field.");
  return url.href.replace(/\/+$/, "");
}

export function connectionsMock(ctx: MockCtx): Handlers<Requests> & { finishByItself(provider: SignInProvider): void } {
  const books = new Map<string, Book>();
  const flows = new Map<string, Flow>();
  let flowCount = 0;

  const bookOf = (relay: string): Book => {
    let book = books.get(relay);
    if (book === undefined) {
      // A runtime of a set-up install keeps the connections it was set up with; one first linked in the preview starts with none.
      const connections = ctx.ready && relay === "relay-1" ? setUp() : [];
      book = { connections, default: connections.find((c) => c.default)?.id ?? null, signins: { anthropic: { signedIn: ctx.ready && relay === "relay-1", until: ctx.ready && relay === "relay-1" ? ctx.now() + 7 * HOUR : null, ended: null }, openai: { signedIn: false, until: null, ended: null } } };
      books.set(relay, book);
    }
    return book;
  };
  /** The runtime a request is about: the one it names, else the one heard from last; refused where it isn't linked. */
  const runtimeOf = (r: { relay?: string }): RelayView => {
    const linked = ctx.state().runtime.relays.filter((x) => x.link === "linked");
    if (r.relay !== undefined) {
      const named = linked.find((x) => x.id === r.relay);
      if (named === undefined) throw new Refusal("unavailable", "That runtime isn't linked now. Start it (its line is on LumiAH's Runtime page) and try again.");
      return named;
    }
    const last = [...linked].sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0))[0];
    if (last === undefined) throw new Refusal("unavailable", "LumiAH needs its runtime for this, and none is linked now. Start it (its line is on LumiAH's Runtime page) and try again.");
    return last;
  };
  const viewOf = (relay: RelayView): ConnectionsView => {
    const book = bookOf(relay.id);
    return {
      connections: book.connections.map((c) => ({ ...c, default: c.id === book.default, ...(c.auth === "signin" && (c.provider === "anthropic" || c.provider === "openai") ? { signedIn: book.signins[c.provider].signedIn } : {}) })),
      default: book.default,
      providers: PROVIDERS,
      relay: { id: relay.id, name: relay.name },
    };
  };
  const stateOf = (relay: string, provider: SignInProvider): SignInState => {
    const s = bookOf(relay).signins[provider];
    const open = [...flows.entries()].find(([, f]) => f.relay === relay && f.provider === provider)?.[0] ?? null;
    return { provider, signedIn: s.signedIn, until: s.signedIn ? s.until : null, flow: open, ended: s.ended };
  };
  const endFlows = (relay: string, provider: SignInProvider): void => {
    for (const [id, f] of [...flows]) if (f.relay === relay && f.provider === provider) flows.delete(id);
  };
  const signedIn = (relay: string, provider: SignInProvider): void => {
    endFlows(relay, provider);
    bookOf(relay).signins[provider] = { signedIn: true, until: ctx.now() + 8 * HOUR, ended: null };
  };

  return {
    "lah.connections.list": (r) => viewOf(runtimeOf(r)),
    "lah.connections.save": (r) => {
      const relay = runtimeOf(r);
      const book = bookOf(relay.id);
      const input = r.connection;
      const at = input.id === undefined ? -1 : book.connections.findIndex((c) => c.id === input.id);
      if (r.create === true && at !== -1) throw new Refusal("conflict", "The runtime has a connection of that id already.");
      if (r.create !== true && input.id !== undefined && at === -1) throw new Refusal("not_found", "That connection is no longer there: reload the page.");
      const before = at === -1 ? null : book.connections[at];
      const name = input.name.trim();
      if (name === "") throw new Refusal("invalid", "Give the connection a name.");
      const offer = PROVIDERS.find((p) => p.id === input.provider);
      if (offer === undefined) throw new Refusal("invalid", `"${input.provider}" isn't a provider the runtime offers.`);
      if (!offer.auth.includes(input.auth)) throw new Refusal("invalid", `${offer.name} connections can't use ${input.auth === "signin" ? "a sign-in" : input.auth === "none" ? "no key" : "a key"}.`);
      const given = typeof input.baseUrl === "string" && input.baseUrl.trim() !== "" ? input.baseUrl : null;
      if (given !== null && input.auth === "signin") throw new Refusal("invalid", "A connection that signs in calls the provider's own address: leave the address empty.");
      const baseUrl = given !== null ? addressOf(given) : null;
      if (offer.needsBaseUrl && baseUrl === null) throw new Refusal("invalid", `An ${offer.name} connection needs the server's address.`);
      if (typeof input.api === "string" && input.api !== "" && !offer.apis.includes(input.api)) throw new Refusal("invalid", `${offer.name} connections speak ${offer.apis.join(" or ")}, not ${input.api}.`);
      // A change of provider or of the address's origin takes the stored key away unless one comes with it, and unsets every header value the change doesn't give again (one may hold a gateway's credential for the old server): nothing stored goes to a server it wasn't given for.
      const origin = (address: string | null | undefined): string | null => (address ? new URL(address).origin : null);
      const moved = before !== null && (before.provider !== offer.id || origin(before.baseUrl) !== origin(baseUrl));
      const headers =
        input.headers === undefined
          ? before?.headers?.map((h) => ({ name: h.name, set: h.set && !moved }))
          : input.headers === null
            ? undefined
            : Object.entries(input.headers).map(([header, value]) => ({ name: header, set: value !== null || (!moved && before?.headers?.find((h) => h.name === header)?.set === true) }));
      // Of a key sent, only that one is set and, for one long enough to keep them from giving it away, its last four characters are kept.
      const typed = typeof r.key === "string" ? r.key.trim() : null;
      const key = input.auth !== "key" ? null : typed !== null ? { set: true, last4: typed.length >= 12 ? typed.slice(-4) : null } : r.key === null || moved ? { set: false, last4: null } : (before?.key ?? { set: false, last4: null });
      const saved: RuntimeConnection = {
        id: input.id ?? `rc-${ctx.now().toString(36)}-${book.connections.length + 1}`,
        name,
        provider: offer.id,
        auth: input.auth,
        ...(baseUrl !== null ? { baseUrl } : {}),
        ...(typeof input.api === "string" && input.api !== "" && offer.apis.length > 1 ? { api: input.api } : {}),
        ...(typeof input.model === "string" && input.model.trim() !== "" ? { model: input.model.trim() } : {}),
        ...(input.effort !== undefined && input.effort !== null ? { effort: input.effort } : {}),
        ...(headers !== undefined && headers.length > 0 ? { headers } : {}),
        default: false,
        key,
      };
      if (at === -1) book.connections.push(saved);
      else book.connections[at] = saved;
      if (book.default === null) book.default = saved.id;
      const view = viewOf(relay);
      const shown = view.connections.find((c) => c.id === saved.id);
      if (shown === undefined) throw new Refusal("internal", "The connection saved isn't in the list.");
      return { saved: shown, view };
    },
    "lah.connections.remove": (r) => {
      const relay = runtimeOf(r);
      const book = bookOf(relay.id);
      book.connections = book.connections.filter((c) => c.id !== r.id);
      if (book.default === r.id) book.default = null;
      return viewOf(relay);
    },
    "lah.connections.default": (r) => {
      const relay = runtimeOf(r);
      const book = bookOf(relay.id);
      if (r.id !== null && !book.connections.some((c) => c.id === r.id)) throw new Refusal("not_found", "That connection is no longer there: reload the page.");
      book.default = r.id;
      return viewOf(relay);
    },
    "lah.connections.test": (r) => {
      const relay = runtimeOf(r);
      const c = viewOf(relay).connections.find((x) => x.id === r.id);
      if (c === undefined) throw new Refusal("not_found", "That connection is no longer there: reload the page.");
      if (c.auth === "key" && c.key?.set !== true) return { test: { ok: false, ms: 0, error: `The connection "${c.name}" has no key: add one on the Connections page.` } };
      if (c.auth === "signin" && c.signedIn !== true) return { test: { ok: false, ms: 0, error: `The runtime isn't signed in to ${c.provider === "openai" || c.provider === "anthropic" ? NAMES[c.provider] : c.provider}, which the connection "${c.name}" uses: sign in on the Connections page.` } };
      if (c.provider === "openai-compatible" && c.baseUrl !== undefined && SERVED[c.baseUrl] === undefined) return { test: { ok: false, ms: 1840, error: `502: nothing answered at ${c.baseUrl}` } };
      return { test: { ok: true, ms: 840, model: c.model ?? CATALOGUE[c.provider]?.[0]?.id ?? "the server's own" } };
    },
    "lah.connections.models": (r) => {
      const relay = runtimeOf(r);
      if ("provider" in r) return { models: CATALOGUE[r.provider] ?? [] };
      const view = viewOf(relay);
      const c = view.connections.find((x) => x.id === (r.connectionId ?? view.default));
      if (c === undefined) throw new Refusal("not_found", r.connectionId === null ? "The runtime has no default connection." : "There is no such connection.");
      if (c.baseUrl !== undefined && !(c.provider in CATALOGUE)) {
        const served = SERVED[c.baseUrl];
        if (served === undefined) throw new Refusal("unavailable", `${c.baseUrl} didn't list its models.`);
        return { models: served };
      }
      return { models: CATALOGUE[c.provider] ?? [] };
    },
    "lah.connections.lumiverse": () => ({ connections: LUMIVERSE_CONNECTIONS }),
    "lah.signin.start": (r) => {
      const relay = runtimeOf(r);
      endFlows(relay.id, r.provider);
      flowCount += 1;
      const flow = `flow-${flowCount}`;
      flows.set(flow, { relay: relay.id, provider: r.provider });
      bookOf(relay.id).signins[r.provider].ended = null;
      const url = r.provider === "anthropic" ? `https://claude.ai/oauth/authorize?code=true&client_id=lumiah-preview&state=${flow}` : `https://auth.openai.com/oauth/authorize?client_id=lumiah-preview&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=${flow}`;
      return { flow, url, note: NOTES[r.provider] };
    },
    "lah.signin.finish": (r) => {
      const relay = runtimeOf(r);
      const flow = flows.get(r.flow);
      if (flow === undefined || flow.relay !== relay.id) throw new Refusal("invalid", "That sign-in is no longer open: begin it again.");
      const code = r.code.trim();
      const fits = flow.provider === "anthropic" ? /^[A-Za-z0-9_-]{8,}#[A-Za-z0-9_-]+$/.test(code) : /[?&]code=[^&]+/.test(code);
      if (!fits) throw new Refusal("invalid", flow.provider === "anthropic" ? "400: Invalid authorization code (invalid_grant). Copy the whole code Anthropic shows, and paste it here." : "That isn't the address OpenAI sent your browser to: copy it whole from the address bar, starting with http://localhost:1455/.");
      signedIn(relay.id, flow.provider);
      return { state: stateOf(relay.id, flow.provider), view: viewOf(relay) };
    },
    "lah.signin.cancel": (r) => {
      const relay = runtimeOf(r);
      const flow = flows.get(r.flow);
      if (flow !== undefined && flow.relay === relay.id) {
        flows.delete(r.flow);
        bookOf(relay.id).signins[flow.provider].ended = "You cancelled it.";
      }
      return { cancelled: true };
    },
    "lah.signin.out": (r) => {
      const relay = runtimeOf(r);
      endFlows(relay.id, r.provider);
      bookOf(relay.id).signins[r.provider] = { signedIn: false, until: null, ended: null };
      return { state: stateOf(relay.id, r.provider), view: viewOf(relay) };
    },
    "lah.signin.state": (r) => stateOf(runtimeOf(r).id, r.provider),
    finishByItself(provider) {
      const open = [...flows.entries()].find(([, f]) => f.provider === provider);
      if (open !== undefined) signedIn(open[1].relay, provider);
    },
  };
}
