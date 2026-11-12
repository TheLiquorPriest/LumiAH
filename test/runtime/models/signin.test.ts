// Signing the runtime in to Anthropic and to OpenAI through pi-ai's own flows, on the path a page
// can finish: the flow's address to open, then what the provider gave back pasted in. Against a
// scripted token endpoint: the code is exchanged, the tokens are kept for the owner alone, a call
// on the sign-in carries them, an expired token is renewed once however many calls find it so, a
// flow left open expires, and signing out forgets the tokens.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Rig, Sent } from "./support";
import { DEVICE, anthropicStream, anthropicTurn, bodyOf, eventStream, failed, forever, json, request, rig, scriptedFetch } from "./support";

const CLAUDE_CODE = "You are Claude Code, Anthropic's official CLI for Claude.";

let r: Rig | undefined;
let realFetch: typeof globalThis.fetch | undefined;
afterEach(async () => {
  if (realFetch !== undefined) globalThis.fetch = realFetch;
  realFetch = undefined;
  await r?.done();
  r = undefined;
});

/** Answers pi-ai's own requests to the providers' token endpoints, which go out through the global fetch. */
function tokenEndpoint(answer: (sent: Sent) => Response): Sent[] {
  const { fetch, sent } = scriptedFetch(answer);
  realFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  return sent;
}

/** The tokens Anthropic's endpoint hands out, a new pair on each request, each pair good for `seconds`. */
function anthropicTokens(seconds: number): (sent: Sent) => Response {
  let issued = 0;
  return () => {
    issued += 1;
    return json({ access_token: `sk-ant-oat01-access-${issued}`, refresh_token: `sk-ant-ort01-refresh-${issued}`, expires_in: seconds });
  };
}

/** A layer whose Anthropic API answers every call, and a sign-in connection on it. */
async function signInRig(): Promise<{ r: Rig; connection: string }> {
  const made = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: "At the quay." }))) });
  r = made;
  const saved = await made.layer.book.save({ name: "Claude sign-in", provider: "anthropic", auth: "signin", model: "claude-sonnet-4-5" });
  return { r: made, connection: saved.id };
}

/** Signs in to Anthropic with the code its page would show. */
async function signIn(made: Rig): Promise<void> {
  const start = await made.layer.signIn.start("anthropic");
  const state = new URL(start.url).searchParams.get("state");
  await made.layer.signIn.finish(start.flow, `code-from-the-page#${state}`);
}

describe("signing in to Anthropic", () => {
  test("starts on the page that shows a code, says how requests on it are sent, and keeps the tokens for the owner alone", async () => {
    const tokens = tokenEndpoint(anthropicTokens(3600));
    const { r } = await signInRig();
    const start = await r.layer.signIn.start("anthropic");
    const url = new URL(start.url);
    expect(url.host).toBe("claude.ai");
    expect(url.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
    expect(start.note).toContain("the way Claude Code sends them");
    expect(await r.layer.signIn.state("anthropic")).toEqual({ provider: "anthropic", signedIn: false, flow: start.flow });

    const state = url.searchParams.get("state");
    expect(await r.layer.signIn.finish(start.flow, `code-from-the-page#${state}`)).toEqual({ provider: "anthropic", signedIn: true, flow: null });
    expect(tokens.map((t) => [t.url, bodyOf(t).grant_type, bodyOf(t).code])).toEqual([["https://platform.claude.com/v1/oauth/token", "authorization_code", "code-from-the-page"]]);
    const secrets = join(r.dir, "secrets.json");
    expect(readFileSync(secrets, "utf8")).toContain("sk-ant-ort01-refresh-1");
    expect(statSync(secrets).mode & 0o777).toBe(0o600);
    const list = await r.layer.book.list();
    expect(list.connections[0]).toMatchObject({ auth: "signin", signedIn: true, key: null });
    expect(JSON.stringify(list)).not.toContain("sk-ant-oat01");
  });

  test("a call on the sign-in carries its token, as Claude Code sends one", async () => {
    tokenEndpoint(anthropicTokens(3600));
    const { r } = await signInRig();
    await signIn(r);
    await r.layer.models.call(request({ messages: [{ role: "system", content: "You narrate a harbour town." }, { role: "user", content: "Where is Ilse?" }] }), forever());
    const sent = r.sent[0];
    expect(sent?.headers.authorization).toBe("Bearer sk-ant-oat01-access-1");
    expect(sent?.headers["user-agent"]).toStartWith("claude-cli/");
    expect((bodyOf(sent).system as { text: string }[]).map((s) => s.text)).toEqual([CLAUDE_CODE, "You narrate a harbour town."]);
  });

  test("renews an expired token once, however many calls find it so, and keeps the new one", async () => {
    // The code buys a token good for a minute, within pi-ai's five minutes of expiring, so the first calls renew it; a renewed one is good for an hour.
    const tokens = tokenEndpoint((sent) =>
      bodyOf(sent).grant_type === "refresh_token"
        ? json({ access_token: "sk-ant-oat01-renewed", refresh_token: "sk-ant-ort01-renewed", expires_in: 3600 })
        : json({ access_token: "sk-ant-oat01-first", refresh_token: "sk-ant-ort01-first", expires_in: 60 }),
    );
    const { r } = await signInRig();
    await signIn(r);
    const ask = () => r.layer.models.call(request({ messages: [{ role: "user", content: "Where is Okoro?" }] }), forever());
    await Promise.all([ask(), ask()]);
    expect(tokens.map((t) => [bodyOf(t).grant_type, bodyOf(t).refresh_token ?? null])).toEqual([
      ["authorization_code", null],
      ["refresh_token", "sk-ant-ort01-first"],
    ]);
    expect(r.sent.map((s) => s.headers.authorization)).toEqual(["Bearer sk-ant-oat01-renewed", "Bearer sk-ant-oat01-renewed"]);
    const kept = readFileSync(join(r.dir, "secrets.json"), "utf8");
    expect(kept).toContain("sk-ant-ort01-renewed");
    expect(kept).not.toContain("sk-ant-ort01-first");
  });

  test("a code from another flow is refused in words, and the flow must start again", async () => {
    tokenEndpoint(anthropicTokens(3600));
    const { r } = await signInRig();
    const start = await r.layer.signIn.start("anthropic");
    await expect(r.layer.signIn.finish(start.flow, "code-from-the-page#another-flow")).rejects.toThrow("The Anthropic sign-in didn't finish: OAuth state mismatch. Start it again.");
    await expect(r.layer.signIn.finish(start.flow, "code-from-the-page#another-flow")).rejects.toThrow("This sign-in is no longer open");
    expect((await r.layer.signIn.state("anthropic")).signedIn).toBe(false);
  });

  test("a token endpoint that refuses the code says so with its status", async () => {
    tokenEndpoint(() => failed(400, { error: "invalid_grant", error_description: "Invalid authorization code" }));
    const { r } = await signInRig();
    const start = await r.layer.signIn.start("anthropic");
    const state = new URL(start.url).searchParams.get("state");
    await expect(r.layer.signIn.finish(start.flow, `stale-code#${state}`)).rejects.toThrow("The Anthropic sign-in didn't finish: 400: Invalid authorization code (invalid_grant). Start it again.");
  });

  test("a flow left open expires, one cancelled ends, and signing out forgets the tokens", async () => {
    tokenEndpoint(anthropicTokens(3600));
    const { r } = await signInRig();
    const left = await r.layer.signIn.start("anthropic");
    r.timers.fireAll();
    expect((await r.layer.signIn.state("anthropic")).flow).toBeNull();
    await expect(r.layer.signIn.finish(left.flow, "code#state")).rejects.toThrow("This sign-in is no longer open: start it again.");
    const cancelled = await r.layer.signIn.start("anthropic");
    await r.layer.signIn.cancel(cancelled.flow);
    await expect(r.layer.signIn.finish(cancelled.flow, "code#state")).rejects.toThrow("This sign-in is no longer open");

    await signIn(r);
    expect((await r.layer.signIn.state("anthropic")).signedIn).toBe(true);
    await r.layer.signIn.out("anthropic");
    expect(await r.layer.signIn.state("anthropic")).toEqual({ provider: "anthropic", signedIn: false, flow: null });
    expect(readFileSync(join(r.dir, "secrets.json"), "utf8")).not.toContain("sk-ant-");
    await expect(r.layer.models.call(request({ messages: [{ role: "user", content: "Hello?" }] }), forever())).rejects.toThrow("The runtime isn't signed in to Anthropic");
  });
});

describe("signing in to OpenAI", () => {
  test("finishes with the address the browser was sent to, pasted back", async () => {
    const tokens = tokenEndpoint(() => json({ access_token: "chatgpt-access-1", refresh_token: "chatgpt-refresh-1", id_token: "chatgpt-id", scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", expires_in: 3600 }));
    r = rig();
    const start = await r.layer.signIn.start("openai");
    const url = new URL(start.url);
    expect(url.host).toBe("auth.openai.com");
    expect([url.searchParams.get("ext_agent_host_id"), url.searchParams.get("agent_name_hint")]).toEqual([`urn:uuid:${DEVICE}`, "LumiAH"]);
    expect(start.note).toContain("http://127.0.0.1:1455/");
    const pasted = `http://127.0.0.1:1455/auth/callback?code=code-1&state=${url.searchParams.get("state")}&client_id=issued-client`;
    expect(await r.layer.signIn.finish(start.flow, pasted)).toEqual({ provider: "openai", signedIn: true, flow: null });
    const form = new URLSearchParams(tokens[0]?.text);
    expect([tokens[0]?.url, form.get("grant_type"), form.get("code"), form.get("client_id")]).toEqual(["https://auth.openai.com/api/accounts/oauth/token", "authorization_code", "code-1", "issued-client"]);
    expect(readFileSync(join(r.dir, "secrets.json"), "utf8")).toContain("chatgpt-refresh-1");
  });
});
