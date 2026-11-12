// Runtime → Connections (PI-BUILD-PLAN §4.3), worked out without a browser. The agents call their
// providers on the runtime's own connections: which provider, at which address, with which model
// and effort, signed with a key, with a sign-in to the user's account, or with nothing (a local
// server). connections.tsx draws the section, signin.tsx the sign-in; what they show and send is
// decided here:
//
// - A connection as the list shows it, and as a picker on Settings and Agents names it; an id an
//   agent holds that is none of the runtime's connections runs on the default, and says so.
// - The form's draft: what shows for a provider (a key or a sign-in, an address it needs or may
//   take, the API of a compatible server), what is wrong with it before it is sent, and what a save
//   sends. A key, and a header's value, are never part of a draft: the page reads them from their
//   fields when the user saves, sends them in that one request, and keeps them nowhere
//   (`saveBody`); words that could carry one back are cleaned of it (`withoutSecrets`).
// - What a save takes away (the key and the headers' values, where the provider or the address's
//   origin changes and no key comes with it), and what removing a connection does to the agents on
//   it, asked before it is done.
// - Copy from Lumiverse: which of Lumiverse's connections the runtime can take, as what, under
//   their own ids, keys typed again one by one.
// - A sign-in: what to know before starting, what to paste back, how it stands.

import { addConnectionWords } from "../../shared/connections";
import { type ChatView, type ConnectionAuth, type ConnectionEffort, type ConnectionInput, type ConnectionsView, type ConnectionTest, isRecord, type LumiverseConnection, type ProviderOffer, type RuntimeConnection, type SettingsView, type SignInProvider, type SignInState, type UiRequests } from "../../shared/ui";
import { dateTime, duration } from "./format";
import { settingPlace, valueAt } from "./settings-model";

/** "a", "a and b", "a, b and c". */
export function andList(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// ---------------------------------------------------------------- what the runtime holds, as a page knows it

/**
 * A runtime's connections as a page knows them: as last read (null before a read answered; kept
 * while the runtime is away, for the names it gives), whether the runtime they are asked of is
 * linked to read them from, how many of the user's runtimes are linked (each keeps connections of
 * its own), whether that runtime is the one that plays the chat they are shown for (else it is the
 * one heard from last) and whether that chat is the one the page shows (`shown`; else it is the one
 * open in Lumiverse, on a page about no chat), why the last read failed (null when it didn't), and
 * whether a read is under way.
 */
export interface KnownConnections {
  view: ConnectionsView | null;
  linked: boolean;
  runtimes: number;
  chat: boolean;
  shown?: true;
  failed: string | null;
  reading: boolean;
}

/**
 * Whose connections a page lists: those of the runtime that plays the chat the page is about,
 * while that runtime is linked (`ChatView.runtime`); else those of the user's runtime heard from
 * last (`relay` null). A page about a chat is about the one it shows (`shown`; null: none); a page
 * about no chat (`shown` left out: Settings, Agents) takes the chat open in Lumiverse (`open`).
 */
export function listedRuntime(chats: readonly Pick<ChatView, "chatId" | "runtime">[], shown: string | null | undefined, open: string | null): { relay: string | null; shown: boolean } {
  const chatId = shown === undefined ? open : shown;
  const relay = chatId === null ? null : (chats.find((c) => c.chatId === chatId)?.runtime?.id ?? null);
  return { relay, shown: relay !== null && shown !== undefined };
}

export const NOTHING_KNOWN: KnownConnections = { view: null, linked: false, runtimes: 0, chat: false, failed: null, reading: false };

/** A provider the runtime offers, by its id; null for one it doesn't (a connection made by a newer runtime). */
export function offerOf(view: Pick<ConnectionsView, "providers">, provider: string): ProviderOffer | null {
  return view.providers.find((p) => p.id === provider) ?? null;
}

/** A provider's name as the runtime offers it, else its id. */
export function providerName(view: Pick<ConnectionsView, "providers">, provider: string): string {
  return offerOf(view, provider)?.name ?? provider;
}

/** The default connection; null where none is. */
export function defaultOf(view: ConnectionsView): RuntimeConnection | null {
  return view.connections.find((c) => c.id === view.default) ?? null;
}

/** A connection in one line, as a picker lists it: "Claude · Anthropic · claude-sonnet-4-5". */
export function pickerLabel(c: RuntimeConnection, view: Pick<ConnectionsView, "providers">): string {
  return [c.name, providerName(view, c.provider), ...(c.model !== undefined ? [c.model] : [])].join(" · ");
}

/** The providers the runtime signs in to, by name, and whose account a sign-in is. */
export const SIGNIN_NAME: Readonly<Record<SignInProvider, string>> = { anthropic: "Anthropic", openai: "OpenAI" };
export const SIGNIN_ACCOUNT: Readonly<Record<SignInProvider, string>> = { anthropic: "your Claude account", openai: "your ChatGPT account" };

export function isSignInProvider(provider: string): provider is SignInProvider {
  return provider === "anthropic" || provider === "openai";
}

/** How a connection signs its calls, in a few words: its key's last characters, whether the runtime is signed in, or that it needs nothing. */
export function signsWords(c: RuntimeConnection): string {
  if (c.auth === "none") return "No key: the server asks for none";
  if (c.auth === "signin") {
    const who = isSignInProvider(c.provider) ? SIGNIN_ACCOUNT[c.provider] : "an account";
    return c.signedIn === true ? `Signs in with ${who}` : `Not signed in: sign in with ${who}`;
  }
  if (c.key === null || !c.key.set) return "No key yet: its calls are refused until you add one";
  return c.key.last4 !== null ? `Key ending in ${c.key.last4}` : "Key set";
}

/** Whether a connection can make a call as it stands: a key it signs with is there, the sign-in it uses holds. */
export function canCall(c: RuntimeConnection): boolean {
  if (c.auth === "key") return c.key?.set === true;
  if (c.auth === "signin") return c.signedIn === true;
  return true;
}

// ---------------------------------------------------------------- the pickers on Settings and Agents

/** What a picker of connections says while it can't list them: why, in a line; null once it can. */
export function unlistedWords(known: KnownConnections): string | null {
  if (known.view !== null) return null;
  if (!known.linked) return "Your connections are kept in the runtime, so they show once a runtime is linked (its steps are on the Runtime page).";
  if (known.failed !== null) return `The runtime's connections couldn't be read: ${known.failed}`;
  return "Reading the runtime's connections…";
}

/** The runtime a page's list is of, in words, where several are linked: "mara, the runtime that plays this chat"; null where one is, or while the list isn't known. */
function runtimeWords(known: KnownConnections): string | null {
  if (known.view === null || known.runtimes < 2) return null;
  const which = !known.chat ? "the runtime heard from last" : known.shown === true ? "the runtime that plays this chat" : "the runtime that plays the open chat";
  return `${known.view.relay.name}, ${which}`;
}

/** Whose connections a picker lists, said where several runtimes are linked (each keeps its own); null where one is. */
export function whoseWords(known: KnownConnections): string | null {
  const runtime = runtimeWords(known);
  return runtime === null ? null : `These are the connections of ${runtime}. Each runtime keeps connections of its own, and an agent runs on those of the runtime its chat runs in.`;
}

/** Whose connections a banner about them speaks of, where several runtimes are linked; null where one is. */
export function wantedOn(known: KnownConnections): string | null {
  const runtime = runtimeWords(known);
  return runtime === null ? null : `This is about ${runtime}: each runtime keeps connections of its own.`;
}

/** What "none" means where a picker may leave the connection out, with the connection that is now: "Your default connection (now Claude)". */
export function noneWords(none: string, known: KnownConnections): string {
  const chosen = known.view !== null ? defaultOf(known.view) : null;
  return chosen !== null ? `${none} (now ${chosen.name})` : none;
}

/**
 * What a picker says of the id it holds where the runtime has no connection of that id (removed,
 * or one of Lumiverse's from before the runtime kept its own): the agent runs on the default, which
 * it names, or on nothing while there is no default. Null where the id is one of them, where none
 * is held, and while the list isn't known (nothing can be said of an id then).
 */
export function goneWords(id: string | null, known: KnownConnections): string | null {
  if (id === null || known.view === null || known.view.connections.some((c) => c.id === id)) return null;
  const chosen = defaultOf(known.view);
  return chosen !== null
    ? `None of the runtime's connections has this id now, so it runs on the default connection, ${chosen.name}. Pick one here to choose again.`
    : "None of the runtime's connections has this id now, and the runtime has no default connection, so its calls are refused. Pick one here, or make one the default on the Runtime page.";
}

/** The connection whose models a model picker offers: the one chosen where the runtime has it, else the default (null), which is what the agent runs on then. While the list isn't known, the one chosen. */
export function modelsConnection(id: string | null, known: KnownConnections): string | null {
  if (id === null || known.view === null) return id;
  return known.view.connections.some((c) => c.id === id) ? id : null;
}

// ---------------------------------------------------------------- the form

/** A header of the connection being edited: its name, whether the connection has it already (`known`), and whether a value is stored for it. */
export interface HeaderDraft {
  name: string;
  known: boolean;
  set: boolean;
}

/**
 * A connection as the form edits it: what it is saved with, but never a key or a header's value,
 * which stay in their fields until the user saves. `id` null: a new one. `headers` null: left as
 * they are; else exactly these. `clearKey`: the stored key is to be taken away.
 */
export interface ConnectionDraft {
  id: string | null;
  name: string;
  provider: string;
  auth: ConnectionAuth;
  baseUrl: string;
  /** The API a compatible server speaks; "" for the provider's first. */
  api: string;
  model: string;
  effort: ConnectionEffort | null;
  clearKey: boolean;
  headers: HeaderDraft[] | null;
}

/** The efforts a connection may hold, in order, with their names. */
export const EFFORT_CHOICES: readonly { value: ConnectionEffort | null; label: string }[] = [
  { value: null, label: "The provider's own" },
  { value: "off", label: "No thinking" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Very high" },
  { value: "max", label: "The most" },
];

/** The APIs a compatible server may speak, in words. */
export const API_WORDS: Readonly<Record<string, string>> = { "openai-completions": "Chat Completions (/chat/completions)", "openai-responses": "Responses (/responses)", "anthropic-messages": "Messages (/v1/messages)" };

/** What a way of signing calls is called in the form, for a provider. */
export function authLabel(auth: ConnectionAuth, provider: string): string {
  if (auth === "signin") return isSignInProvider(provider) ? `Sign in with ${SIGNIN_ACCOUNT[provider]}` : "Sign in";
  return auth === "key" ? "An API key" : "No key";
}

/** A new connection's draft: the first provider offered, signed as it signs first, named after it. */
export function newDraft(view: Pick<ConnectionsView, "providers">): ConnectionDraft {
  const offer = view.providers[0];
  return { id: null, name: offer?.name ?? "", provider: offer?.id ?? "", auth: offer?.auth[0] ?? "key", baseUrl: "", api: "", model: "", effort: null, clearKey: false, headers: null };
}

/** A connection's draft, as it is stored. */
export function draftOf(c: RuntimeConnection): ConnectionDraft {
  return { id: c.id, name: c.name, provider: c.provider, auth: c.auth, baseUrl: c.baseUrl ?? "", api: c.api ?? "", model: c.model ?? "", effort: c.effort ?? null, clearKey: false, headers: null };
}

/**
 * The draft moved to another provider: it keeps what the new one takes (the way it signs, the API),
 * takes the first of what it offers for the rest, and forgets the model (another provider's models
 * are others). A new draft still named after its provider is named after the new one. A connection
 * that signs in calls the provider's own address, so it keeps none.
 */
export function withProvider(draft: ConnectionDraft, view: Pick<ConnectionsView, "providers">, provider: string): ConnectionDraft {
  const offer = offerOf(view, provider);
  if (offer === null || provider === draft.provider) return draft;
  const auth = offer.auth.includes(draft.auth) ? draft.auth : (offer.auth[0] ?? "key");
  const was = providerName(view, draft.provider);
  const name = draft.id === null && (draft.name.trim() === "" || draft.name === was) ? offer.name : draft.name;
  return { ...draft, provider, name, auth, api: offer.apis.includes(draft.api) ? draft.api : "", model: "", baseUrl: auth === "signin" ? "" : draft.baseUrl };
}

/** The draft signing another way. A sign-in takes no address of its own. */
export function withAuth(draft: ConnectionDraft, auth: ConnectionAuth): ConnectionDraft {
  return { ...draft, auth, baseUrl: auth === "signin" ? "" : draft.baseUrl };
}

/** What the form shows for the draft's provider: the ways it may sign, its address (needed, optional, or none for a sign-in), the APIs to choose from where there are several, and the sign-in it uses. */
export interface FormShape {
  offer: ProviderOffer | null;
  auths: readonly ConnectionAuth[];
  address: "needed" | "optional" | "none";
  apis: readonly string[] | null;
  signIn: SignInProvider | null;
}

export function formShape(draft: ConnectionDraft, view: Pick<ConnectionsView, "providers">): FormShape {
  const offer = offerOf(view, draft.provider);
  return {
    offer,
    auths: offer?.auth ?? [draft.auth],
    address: draft.auth === "signin" ? "none" : offer?.needsBaseUrl === true ? "needed" : "optional",
    apis: offer !== null && offer.apis.length > 1 ? offer.apis : null,
    signIn: draft.auth === "signin" && isSignInProvider(draft.provider) ? draft.provider : null,
  };
}

/** What the address field says, for a provider that needs one and for one that may take one. */
export function addressHelp(shape: FormShape): string {
  const name = shape.offer?.name ?? "the provider";
  return shape.address === "needed"
    ? "The address of the server its calls go to, as its own documents give it: for a server on this machine, something like http://127.0.0.1:8080/v1."
    : `Leave it empty to call ${name} at its own address. Fill it in to go through a proxy, or to reach a server of your own that speaks ${name}'s API.`;
}

/** An address as a draft holds it, checked as the runtime checks it: an http or https URL with no name and password in it. Null where it is sound. */
function addressProblem(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "That isn't an address: give one such as https://example.com/v1.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Give an http or https address.";
  if (url.username !== "" || url.password !== "") return "Leave the name and password out of the address: a key goes in its own field.";
  return null;
}

/** What is wrong with a draft before it is sent, by field; the runtime has the last word on the rest. */
export interface DraftProblems {
  name: string | null;
  address: string | null;
  headers: string | null;
}

/** `valued`: the names of the headers whose value field holds something now (never the values). */
export function draftProblems(draft: ConnectionDraft, shape: FormShape, valued: ReadonlySet<string>): DraftProblems {
  const address = draft.baseUrl.trim();
  const unvalued = (draft.headers ?? []).filter((h) => !h.known && !valued.has(h.name)).map((h) => h.name);
  const names = (draft.headers ?? []).map((h) => h.name.trim().toLowerCase());
  return {
    name: draft.name.trim() === "" ? "Give the connection a name." : null,
    address: shape.address === "needed" && address === "" ? "Give the server's address." : shape.address !== "none" && address !== "" ? addressProblem(address) : null,
    headers: names.some((n) => n === "") ? "Give each header a name." : names.some((n, i) => names.indexOf(n) !== i) ? "Each header may be named once." : unvalued.length > 0 ? `Type a value for ${andList(unvalued)}.` : null,
  };
}

/** Whether a draft can be sent: nothing in it is wrong. */
export function sendable(problems: DraftProblems): boolean {
  return problems.name === null && problems.address === null && problems.headers === null;
}

/** An address's origin, the part a secret is given for; null for none (the provider's own address). One that isn't an address stands as itself. */
function originOf(address: string | undefined): string | null {
  const trimmed = address?.trim() ?? "";
  if (trimmed === "") return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed;
  }
}

/** Whether saving the draft sends the connection to another server: its provider, or its address's origin, changes. A secret stored for the old one is then given up unless it comes again with the change. */
export function moves(existing: RuntimeConnection, draft: ConnectionDraft): boolean {
  return existing.provider !== draft.provider || originOf(existing.baseUrl) !== originOf(draft.auth === "signin" ? "" : draft.baseUrl);
}

/**
 * What saving the draft takes away that the user should hear of first. Where it moves the
 * connection to another server (`moves`): its stored key unless a key is typed with the change, and
 * the value of every header it keeps that the change doesn't give again (one may hold a gateway's
 * credential for the old server), so nothing stored goes to a server it wasn't given for. Where it
 * stops signing with a key: that key. `typed`: whether the key field holds anything, and the names
 * of the headers whose value field does. Null where nothing goes.
 */
export function lossWords(existing: RuntimeConnection | null, draft: ConnectionDraft, typed: { key: boolean; headers: ReadonlySet<string> }): string | null {
  if (existing === null) return null;
  const hadKey = existing.key?.set === true;
  if (draft.auth !== "key" && hadKey) return "It stops signing with a key, so the stored key is forgotten when you save.";
  if (!moves(existing, draft)) return null;
  // The headers it keeps: all of them while the form leaves them alone, else those the form still holds.
  const kept = draft.headers?.map((h) => h.name) ?? null;
  const values = (existing.headers ?? []).filter((h) => h.set && (kept === null || kept.includes(h.name)) && !typed.headers.has(h.name)).map((h) => h.name);
  const key = hadKey && !typed.key;
  if (!key && values.length === 0) return null;
  const lost = andList([...(key ? ["its key"] : []), ...(values.length > 0 ? [`the ${values.length === 1 ? "value" : "values"} of ${andList(values)}`] : [])]);
  const again = key && values.length > 0 ? "them" : key ? "the key" : values.length === 1 ? "that value" : "those values";
  return `Its ${existing.provider !== draft.provider ? "provider" : "address"} changes, so saving forgets ${lost}: a secret is never sent to a server it wasn't given for. Type ${again} again to keep the connection working.`;
}

/** What the user typed into the secret fields, read from them at the moment of saving: the key, and each header's value by its name. */
export interface TypedSecrets {
  key: string;
  headers: ReadonlyMap<string, string>;
}

export const NO_SECRETS: TypedSecrets = { key: "", headers: new Map() };

/**
 * What a save sends: the connection whole, and its key: the one typed (it goes to the runtime in
 * this request and nowhere else), null to take the stored one away, absent to keep it. Headers go
 * only where the user changed them: each typed value sets one, a header the connection has keeps
 * its stored value, and one left out is taken away (none left: null).
 */
export function saveBody(draft: ConnectionDraft, shape: FormShape, typed: TypedSecrets): UiRequests["lah.connections.save"]["body"] {
  const address = draft.baseUrl.trim();
  const connection: ConnectionInput = {
    ...(draft.id !== null ? { id: draft.id } : {}),
    name: draft.name.trim(),
    provider: draft.provider,
    auth: draft.auth,
    baseUrl: shape.address !== "none" && address !== "" ? address : null,
    api: shape.apis !== null && draft.api !== "" ? draft.api : null,
    model: draft.model.trim() !== "" ? draft.model.trim() : null,
    effort: draft.effort,
  };
  if (draft.headers !== null) {
    const headers: Record<string, string | null> = {};
    for (const h of draft.headers) {
      const value = typed.headers.get(h.name) ?? "";
      if (value !== "") headers[h.name.trim()] = value;
      else if (h.known) headers[h.name.trim()] = null;
    }
    connection.headers = Object.keys(headers).length > 0 ? headers : null;
  }
  const key = typed.key.trim();
  if (draft.auth !== "key") return { connection };
  if (key !== "") return { connection, key };
  return draft.clearKey ? { connection, key: null } : { connection };
}

/** A connection saved again as it stands, with nothing of it changed: what a key typed later goes with. Its headers are left as they are. */
export function inputOf(c: RuntimeConnection): ConnectionInput {
  return { id: c.id, name: c.name, provider: c.provider, auth: c.auth, baseUrl: c.baseUrl ?? null, api: c.api ?? null, model: c.model ?? null, effort: c.effort ?? null };
}

/** The connection's headers as the form edits them. */
export function headersOf(c: RuntimeConnection | null): HeaderDraft[] {
  return (c?.headers ?? []).map((h) => ({ name: h.name, known: true, set: h.set }));
}

/** Words that may have come back with a secret in them, with every secret the user typed taken out: what the page shows and keeps of a failed save. */
export function withoutSecrets(words: string, secrets: readonly string[]): string {
  let out = words;
  for (const secret of secrets) if (secret.trim().length >= 4) out = out.replaceAll(secret.trim(), "[the key you typed]");
  return out;
}

/** Every secret typed, for `withoutSecrets`. */
export function secretsOf(typed: TypedSecrets): string[] {
  return [typed.key, ...typed.headers.values()].filter((s) => s.trim() !== "");
}

/**
 * Where the form reads a model list for the draft: the connection itself where it is saved as the
 * draft stands (its provider and address unchanged), else the provider's own list (a compatible
 * server has none until it is saved with its address). Null where there is no list to read yet.
 */
export function modelsAsk(draft: ConnectionDraft, existing: RuntimeConnection | null, shape: FormShape): UiRequests["lah.connections.models"]["body"] | null {
  if (existing !== null && existing.provider === draft.provider && (existing.baseUrl ?? "") === draft.baseUrl.trim()) return { connectionId: existing.id };
  if (shape.offer !== null && !shape.offer.needsBaseUrl) return { provider: draft.provider };
  return null;
}

// ---------------------------------------------------------------- testing and removing

/** A test call's outcome in words: how long it took and which model answered, or the provider's own words. */
export function testWords(t: ConnectionTest): { ok: boolean; text: string } {
  return t.ok ? { ok: true, text: `It answered in ${duration(t.ms)}, as ${t.model}.` } : { ok: false, text: `It failed after ${duration(t.ms)}: ${t.error}` };
}

/** The agents Settings put on a connection, by their names there: those whose connection is that one. */
export function agentsOn(id: string, settings: Pick<SettingsView, "schema" | "values">): string[] {
  const place = settingPlace(settings.schema, ["agents"]);
  if (place === null) return [];
  let schema: unknown = settings.schema;
  for (const key of place) schema = isRecord(schema) && isRecord(schema.properties) ? schema.properties[key] : undefined;
  const values = valueAt(settings.values, place);
  if (!isRecord(values)) return [];
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  return Object.entries(values).flatMap(([agent, value]) => {
    if (!isRecord(value) || value.connectionId !== id) return [];
    const own = properties[agent];
    return [isRecord(own) && typeof own.title === "string" ? own.title : agent];
  });
}

/** What removing a connection is asked with: which agents run on it now and where they go, that the default's agents are left with none, and that its key goes with it. */
export function removeAsk(c: RuntimeConnection, view: ConnectionsView, settings: Pick<SettingsView, "schema" | "values"> | null): { title: string; message: string; confirm: string } {
  const agents = settings !== null ? agentsOn(c.id, settings) : [];
  const fallback = c.default ? null : defaultOf(view);
  const parts: string[] = [];
  if (agents.length > 0) parts.push(`${andList(agents)} ${agents.length === 1 ? "runs" : "run"} on it now, and would ${fallback !== null ? `run on ${fallback.name}, the default,` : "have no connection to run on"} until you pick another.`);
  if (c.default) parts.push(view.connections.length > 1 ? "It is the default, so every agent that names no connection runs on it: they would have none until you make another one the default." : "It is your only connection: once it is gone, no agent can make a call until you add one.");
  if (parts.length === 0) parts.push("No agent runs on it now.");
  if (c.key?.set === true) parts.push("Its key is forgotten with it.");
  return { title: `Remove ${c.name}?`, message: parts.join(" "), confirm: "Remove it" };
}

/** What the section says over the list while something keeps the agents from running: no connection at all, or none that is the default. Null while there is one to run on. */
export function wantWords(view: ConnectionsView): { title: string; text: string } | null {
  if (view.connections.length === 0) return { title: "No connection yet", text: `Your agents have no provider to call, so a reply LumiAH works on fails before it starts. ${addConnectionWords()}` };
  if (defaultOf(view) === null) return { title: "No default connection", text: "An agent that names no connection runs on the default, and there is none now, so those agents' calls are refused. Make one of your connections the default." };
  return null;
}

// ---------------------------------------------------------------- copy from Lumiverse

/** Lumiverse's providers the runtime offers under the same name, each with the address Lumiverse calls it at when its profile names none: a profile holding that address names no address of its own. */
const SAME_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://api.x.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
};

/** Lumiverse's providers that speak OpenAI's API at an address of their own, which the runtime reaches as an OpenAI-compatible server: the address Lumiverse calls each at when the profile names none ("" for Custom, which always names one). */
const OPENAI_LIKE: Readonly<Record<string, string>> = {
  custom: "",
  chutes: "https://llm.chutes.ai/v1",
  electronhub: "https://api.electronhub.top/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  moonshot: "https://api.moonshot.ai/v1",
  nanogpt: "https://nano-gpt.com/api/v1",
  infermatic: "https://api.totalgpt.ai/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  zai: "https://api.z.ai/api/paas/v4",
  ai21: "https://api.ai21.com/studio/v1",
  perplexity: "https://api.perplexity.ai",
};

/** Lumiverse's providers with a sign-in of their own, which the runtime doesn't offer. */
const NOT_OFFERED: Readonly<Record<string, string>> = { bedrock: "Amazon Bedrock", google_vertex: "Google Vertex" };

const COMPATIBLE = "openai-compatible";

/**
 * One of Lumiverse's connections as Copy from Lumiverse offers it: its id and name (the copy keeps
 * both), its provider as Lumiverse names it, what it becomes in the runtime (the provider's name,
 * and the address where it isn't the provider's own), the connection to save, why it can't be
 * copied (null where it can), and whether the runtime has one of that id already.
 */
export interface CopyRow {
  id: string;
  name: string;
  from: string;
  to: string;
  input: ConnectionInput | null;
  why: string | null;
  there: boolean;
}

/** Lumiverse's connections as Copy from Lumiverse offers them, the loopbacks left out (they point at the runtime itself). A copy comes without its key: the page asks for each afterwards. */
export function copyRows(lumiverse: readonly LumiverseConnection[], loopbacks: ReadonlySet<string>, view: ConnectionsView): CopyRow[] {
  const offered = (id: string): boolean => view.providers.some((p) => p.id === id);
  return lumiverse
    .filter((l) => !loopbacks.has(l.id))
    .map((l): CopyRow => {
      const there = view.connections.some((c) => c.id === l.id);
      const base = { id: l.id, name: l.name, from: l.provider, there };
      const own = l.baseUrl !== null && l.baseUrl.trim() !== "" ? l.baseUrl.trim().replace(/\/+$/, "") : null;
      const made = (provider: string, baseUrl: string | null): CopyRow => ({ ...base, to: baseUrl !== null ? `${providerName(view, provider)} at ${baseUrl}` : providerName(view, provider), input: { id: l.id, name: l.name, provider, auth: "key", baseUrl, api: null, model: l.model, effort: null }, why: there ? "The runtime has it already." : null });
      const same = SAME_PROVIDER[l.provider];
      if (same !== undefined && offered(l.provider)) return made(l.provider, own !== null && own !== same ? own : null);
      const like = OPENAI_LIKE[l.provider];
      const address = own ?? (like !== undefined && like !== "" ? like : null);
      if ((like !== undefined || (NOT_OFFERED[l.provider] === undefined && own !== null)) && address !== null && offered(COMPATIBLE)) return made(COMPATIBLE, address);
      const why = NOT_OFFERED[l.provider] !== undefined ? `The runtime offers no ${NOT_OFFERED[l.provider]} connection.` : like !== undefined ? "Its profile names no address: add it by hand as OpenAI-compatible, with its server's address." : `The runtime doesn't know the provider "${l.provider}": add it by hand, as OpenAI-compatible where it speaks OpenAI's API.`;
      return { ...base, to: "", input: null, why };
    });
}

/** The rows ticked at first: every one that can be copied and isn't in the runtime yet. */
export function copyTicked(rows: readonly CopyRow[]): Set<string> {
  return new Set(rows.filter((r) => r.input !== null && !r.there).map((r) => r.id));
}

/** The copies waiting for a key, in the order they were copied: those that sign with one and have none yet. */
export function keysWanted(view: ConnectionsView, copied: readonly string[]): string[] {
  return copied.filter((id) => {
    const c = view.connections.find((x) => x.id === id);
    return c !== undefined && c.auth === "key" && c.key?.set !== true;
  });
}

// ---------------------------------------------------------------- signing in

/**
 * What the page says before a sign-in begins: where the user signs in, and what comes back. For
 * OpenAI, that it sends the browser to an address on the browser's own machine, which loads only
 * where the runtime runs there too, and that its address is pasted back where it doesn't. What
 * Anthropic's sign-in changes about the requests is the runtime's to say (`SignInStart.note`), and
 * is said before its address is shown.
 */
export function beforeWords(provider: SignInProvider): string {
  return provider === "anthropic"
    ? "You sign in to your Claude account on Anthropic's own page, and paste back the code it shows you. The runtime then calls Claude with your account rather than with a key. Before you open the page, the runtime says how requests on this sign-in are sent."
    : "You sign in to your ChatGPT account on OpenAI's own page. OpenAI then sends your browser to an address on port 1455 of the machine your browser runs on. That page loads only where the runtime runs on that same machine, and the sign-in then finishes by itself. Anywhere else it won't load, which is expected: copy the whole address from the browser's address bar and paste it here.";
}

/** What the user pastes back, for each provider: the field's label, its help, and an example of its shape. */
export function pasteWords(provider: SignInProvider): { label: string; help: string; placeholder: string } {
  return provider === "anthropic"
    ? { label: "The code Anthropic shows you", help: "Once you have signed in, Anthropic's page shows a code. Copy it whole and paste it here.", placeholder: "Paste the code" }
    : { label: "The address your browser was sent to", help: "Once you have signed in, copy the whole address from the browser's address bar, even where the page didn't load, and paste it here. Where the runtime runs on this machine, you needn't: the sign-in finishes by itself.", placeholder: "http://localhost:1455/auth/callback?code=…" };
}

/** How the runtime stands with a provider's sign-in, in a line: signed in, and until when its current token holds; or not. */
export function signInLine(state: SignInState): string {
  if (!state.signedIn) return `Not signed in to ${SIGNIN_NAME[state.provider]}.`;
  const holds = state.until !== null ? ` Its current token holds until ${dateTime(state.until)}; the runtime renews it by itself when a call needs it.` : "";
  return `Signed in with ${SIGNIN_ACCOUNT[state.provider]}.${holds}`;
}

/** An address the page may offer as a link to open: an https one; anything else is shown to copy, never opened. */
export function openable(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
