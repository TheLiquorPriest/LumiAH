// The runtime's own connections, kept in its folder: each key apart from the connection, in a file
// only its owner can read; the pages see that a key is set and its last four characters, never the
// key; the core's port answers the default for null and nothing for a connection that is gone; and
// a file the book can't read stops it in words, rather than being written over.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Rig } from "./support";
import { failed, json, rig } from "./support";

const KEY = "sk-ant-api03-Ilse0123456789abcdefWXYZ";
const SERVER_KEY = "sk-proxy-0123456789abcdefghijklmnop";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const made of rigs.splice(0)) await made.done();
});

function kept(...made: Rig[]): Rig {
  rigs.push(...made);
  return made[0] as Rig;
}

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe("the book of connections", () => {
  test("keeps a key apart from its connection, shows only that it is set and its last four characters, and writes for its owner alone", async () => {
    const r = kept(rig());
    const view = await r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    expect(view).toMatchObject({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", default: true, key: { set: true, last4: "WXYZ" } });
    const list = await r.layer.book.list();
    expect(JSON.stringify(list)).not.toContain(KEY);
    expect(list.providers.map((p) => p.id)).toEqual(["anthropic", "openai", "google", "openrouter", "deepseek", "xai", "groq", "mistral", "openai-compatible", "anthropic-compatible"]);
    expect(readFileSync(join(r.dir, "connections.json"), "utf8")).not.toContain(KEY);
    expect(readFileSync(join(r.dir, "secrets.json"), "utf8")).toContain(KEY);
    expect([modeOf(join(r.dir, "secrets.json")), modeOf(join(r.dir, "connections.json")), modeOf(r.dir)]).toEqual([0o600, 0o600, 0o700]);
    // Each file was written whole and moved into place: nothing half-written is left beside it.
    expect(readdirSync(r.dir).sort()).toEqual(["connections.json", "secrets.json"]);
  });

  test("answers the core's port: the default for null, nothing for a connection that is gone, one tool at a time where the user says so", async () => {
    const r = kept(rig({ serialTools: ["id2"] }));
    const first = await r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const second = await r.layer.book.save({ name: "Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1/", model: "served-model" });
    expect(second.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(await r.layer.connections.list()).toEqual([
      { id: first.id, name: "Claude", provider: "anthropic", model: "claude-sonnet-4-5", loopback: false },
      { id: second.id, name: "Local", provider: "openai-compatible", model: "served-model", loopback: false },
    ]);
    expect(await r.layer.connections.get(null)).toEqual({ id: first.id, name: "Claude", provider: "anthropic", model: "claude-sonnet-4-5", loopback: false, cache: null, parallelTools: true });
    expect((await r.layer.connections.get(second.id))?.parallelTools).toBe(false);
    expect(await r.layer.connections.get("gone")).toBeNull();
    await r.layer.book.setDefault(second.id);
    expect((await r.layer.connections.get(null))?.id).toBe(second.id);
    await r.layer.book.remove(second.id);
    expect(await r.layer.connections.get(null)).toBeNull();
    expect((await r.layer.book.list()).connections.map((c) => c.id)).toEqual([first.id]);
  });

  test("reads its connections back when the runtime starts again", async () => {
    const r = kept(rig());
    await r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", effort: "low", headers: { "x-team": "harbour" } }, KEY);
    await r.layer.close();
    const again = kept(rig({ dir: r.dir }));
    expect((await again.layer.book.list()).connections).toEqual([
      { id: "id1", name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", effort: "low", headers: { "x-team": "harbour" }, default: true, key: { set: true, last4: "WXYZ" } },
    ]);
  });

  test("takes a key away when asked to, and from a connection that no longer signs with one", async () => {
    const r = kept(rig());
    const saved = await r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    expect((await r.layer.book.save({ id: saved.id, name: "Claude", provider: "anthropic", auth: "key" })).key).toEqual({ set: true, last4: "WXYZ" });
    expect((await r.layer.book.save({ id: saved.id, name: "Claude", provider: "anthropic", auth: "key" }, null)).key).toEqual({ set: false, last4: null });
    await r.layer.book.save({ id: saved.id, name: "Claude", provider: "anthropic", auth: "key" }, KEY);
    expect((await r.layer.book.save({ id: saved.id, name: "Claude", provider: "anthropic", auth: "signin" })).key).toBeNull();
    expect(readFileSync(join(r.dir, "secrets.json"), "utf8")).not.toContain(KEY);
  });

  test("says in words what it can't save, and saves none of it", async () => {
    const r = kept(rig());
    const tries: [Parameters<typeof r.layer.book.save>[0], string][] = [
      [{ name: "", provider: "anthropic", auth: "key" }, "Give the connection a name."],
      [{ name: "X", provider: "bedrock", auth: "key" }, `"bedrock" isn't a provider the runtime offers.`],
      [{ name: "X", provider: "deepseek", auth: "signin" }, "DeepSeek connections can't use a sign-in."],
      [{ name: "X", provider: "openai-compatible", auth: "none" }, "An OpenAI-compatible connection needs the server's address."],
      [{ name: "X", provider: "openai-compatible", auth: "none", baseUrl: "ftp://files.example.com" }, `"ftp://files.example.com" isn't an http or https address.`],
      [{ name: "X", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080", api: "anthropic-messages" }, "OpenAI-compatible connections speak openai-completions or openai-responses, not anthropic-messages."],
      [{ name: "X", provider: "anthropic", auth: "key", headers: { "bad name": "x" } }, `"bad name" isn't a header's name.`],
      [{ id: "gone", name: "X", provider: "anthropic", auth: "key" }, "That connection is no longer there: reload the page."],
    ];
    for (const [input, words] of tries) await expect(r.layer.book.save(input)).rejects.toThrow(words);
    await expect(r.layer.book.save({ name: "X", provider: "anthropic", auth: "key" }, "  ")).rejects.toThrow("A key can't be empty");
    await expect(r.layer.book.setDefault("gone")).rejects.toThrow("That connection is no longer there");
    expect((await r.layer.book.list()).connections).toEqual([]);
  });

  test("stops at a file it can't read, in words that name it, and never writes over it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lumiah-models-"));
    writeFileSync(join(dir, "connections.json"), "{ not json");
    const r = kept(rig({ dir }));
    await expect(r.layer.book.list()).rejects.toThrow(`${dir}/connections.json`);
    await expect(r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key" }, KEY)).rejects.toThrow("couldn't be read");
    await expect(r.layer.connections.get(null)).rejects.toThrow("couldn't be read");
    expect(readFileSync(join(dir, "connections.json"), "utf8")).toBe("{ not json");
    expect(existsSync(join(dir, "secrets.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a connection's test call", () => {
  test("answers with the model and how long it took", async () => {
    const faux = fauxProvider({ provider: "groq", models: [{ id: "faux-1" }] });
    faux.setResponses([fauxAssistantMessage("OK")]);
    const r = kept(rig({ providers: [faux.provider] }));
    const saved = await r.layer.book.save({ name: "Groq", provider: "groq", auth: "key", model: "faux-1" }, "gsk_0123456789abcdefghij");
    const result = await r.layer.book.test(saved.id);
    expect(result).toMatchObject({ ok: true, model: "faux-1" });
    expect(result.ms).toBeGreaterThan(0);
  });

  test("says what the provider said when it fails, and never the key", async () => {
    const r = kept(rig({ script: () => failed(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }) }));
    const saved = await r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const result = await r.layer.book.test(saved.id);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error.startsWith("401: invalid x-api-key")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe("a connection's models, for the pickers", () => {
  test("a provider's own come from pi-ai's catalogue", async () => {
    const r = kept(rig());
    await r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key" }, KEY);
    expect((await r.layer.modelsOf(null)).map((m) => m.id)).toContain("claude-sonnet-4-5");
    expect(r.sent).toEqual([]);
  });

  test("a compatible server's come from the server, asked with the connection's key", async () => {
    const r = kept(rig({ script: (sent) => (sent.url.startsWith("https://proxy.example.com/") ? json({ data: [{ id: "claude-proxy", display_name: "Claude via the proxy" }] }) : json({ object: "list", data: [{ id: "served-model" }, { id: "other-model" }] })) }));
    const open = await r.layer.book.save({ name: "Local", provider: "openai-compatible", auth: "key", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model" }, SERVER_KEY);
    const proxy = await r.layer.book.save({ name: "Proxy", provider: "anthropic-compatible", auth: "key", baseUrl: "https://proxy.example.com" }, SERVER_KEY);
    expect(await r.layer.modelsOf(open.id)).toEqual([
      { id: "served-model", name: "served-model" },
      { id: "other-model", name: "other-model" },
    ]);
    expect(await r.layer.modelsOf(proxy.id)).toEqual([{ id: "claude-proxy", name: "Claude via the proxy" }]);
    expect(r.sent.map((s) => [s.url, s.headers.authorization ?? s.headers["x-api-key"]])).toEqual([
      ["http://127.0.0.1:8080/v1/models", `Bearer ${SERVER_KEY}`],
      ["https://proxy.example.com/v1/models", SERVER_KEY],
    ]);
  });

  test("a server that won't list them says why, and never the key", async () => {
    const r = kept(rig({ script: () => failed(403, { error: { message: `key ${SERVER_KEY} may not list models`, type: "permission_error" } }) }));
    const saved = await r.layer.book.save({ name: "Local", provider: "openai-compatible", auth: "key", baseUrl: "http://127.0.0.1:8080/v1" }, SERVER_KEY);
    const failure = await r.layer.modelsOf(saved.id).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(failure).toStartWith("The server didn't list its models: 403: key ");
    expect(failure).not.toContain(SERVER_KEY);
  });
});
