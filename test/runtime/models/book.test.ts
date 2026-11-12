// The runtime's own connections, kept in its folder: each key apart from the connection, in a file
// only its owner can read; the pages see that a key is set and its last four characters, and each
// header by name, never a value; what was stored for one server goes to no other; the core's port
// answers the default for null and nothing for a connection that is gone; and a file the book can't
// read stops it in words, rather than being written over.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as nodeFiles from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { BookFiles } from "../../../src/runtime/models/book";
import { Book } from "../../../src/runtime/models/book";
import { WORDS_MAX } from "../../../src/runtime/models/words";
import type { Rig } from "./support";
import { anthropicStream, anthropicTurn, eventStream, failed, forever, json, request, rig } from "./support";

const KEY = "sk-ant-api03-Ilse0123456789abcdefWXYZ";
const SERVER_KEY = "sk-proxy-0123456789abcdefghijklmnop";
const OPENAI_KEY = "sk-proj-0123456789abcdefghijQRST";
const ROUTER_KEY = "sk-or-v1-0123456789abcdefghijklmn";
const GATEWAY = "gw-token-Okoro0123456789abcdef";

const rigs: Rig[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const made of rigs.splice(0)) await made.done();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function kept(...made: Rig[]): Rig {
  rigs.push(...made);
  return made[0] as Rig;
}

/** A folder of the test's own, with the files given written in it as they are, for their owner alone as the runtime writes them. */
function folder(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "lumiah-models-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, { mode: 0o600 });
  return dir;
}

/** A connections file holding `connections` as they are written. */
function bookFile(...connections: Record<string, unknown>[]): string {
  return JSON.stringify({ lumiah: 1, default: (connections[0]?.id as string | undefined) ?? null, connections });
}

const modeOf = (path: string): number => statSync(path).mode & 0o777;

/** A promise's failure words, or what it answered. */
async function wordsOf(work: Promise<unknown>): Promise<string> {
  return work.then(
    (answer) => `answered ${JSON.stringify(answer)}`,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

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
      { id: first.id, name: "Claude", provider: "anthropic", model: "claude-sonnet-4-5" },
      { id: second.id, name: "Local", provider: "openai-compatible", model: "served-model" },
    ]);
    expect(await r.layer.connections.get(null)).toEqual({ id: first.id, name: "Claude", provider: "anthropic", model: "claude-sonnet-4-5", parallelTools: true });
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
    await r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", effort: "low", headers: { "x-team": "harbour-crew" } }, KEY);
    await r.layer.close();
    const again = kept(rig({ dir: r.dir }));
    expect((await again.layer.book.list()).connections).toEqual([
      { id: "id1", name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", effort: "low", headers: [{ name: "x-team", set: true }], default: true, key: { set: true, last4: "WXYZ" } },
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
      [{ name: "X", provider: "openai-compatible", auth: "none", baseUrl: "not an address" }, "That isn't an address: give one such as https://example.com/v1."],
      [{ name: "X", provider: "openai-compatible", auth: "none", baseUrl: "ftp://files.example.com" }, "An address starts with http:// or https://, not ftp://."],
      [{ name: "X", provider: "openai-compatible", auth: "none", baseUrl: "https://proxy.example.com/v1?team=harbour" }, `Give the address without what follows "?" or "#": https://proxy.example.com/v1`],
      [{ name: "X", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080", api: "anthropic-messages" }, "OpenAI-compatible connections speak openai-completions or openai-responses, not anthropic-messages."],
      // A whole header pasted where its name goes: the words don't repeat it, credential and all.
      [{ name: "X", provider: "anthropic", auth: "key", headers: { "x-api-key: sk-pasted-0123456789abcdef": "x" } }, "A header's name is a single word, such as x-team, with no space or colon in it: give its value in its own field."],
      [{ name: "X", provider: "anthropic", auth: "key", headers: { "x-team": "harbour\r\nx-api-key: other" } }, `The header "x-team" can't hold a line break.`],
      [{ id: "gone", name: "X", provider: "anthropic", auth: "key" }, "That connection is no longer there: reload the page."],
    ];
    for (const [input, words] of tries) expect(await wordsOf(r.layer.book.save(input))).toBe(words);
    await expect(r.layer.book.save({ name: "X", provider: "anthropic", auth: "key" }, "  ")).rejects.toThrow("A key can't be empty");
    await expect(r.layer.book.setDefault("gone")).rejects.toThrow("That connection is no longer there");
    expect((await r.layer.book.list()).connections).toEqual([]);
  });

  test("keeps no key and no header's value shorter than 8 characters, which nothing a server says back could be cleaned of; 8 are kept, and taken out of a Test's words", async () => {
    // A server that refuses every call and says back the key and the header it was sent, as some do.
    const r = kept(rig({ script: (sent) => failed(401, { error: { message: `Unknown key ${sent.headers.authorization ?? ""} with token ${sent.headers["x-gateway-token"] ?? ""}.`, type: "invalid_request_error" } }) }));
    const fields = { name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://proxy.example.com/v1", model: "served-model" } as const;
    await expect(r.layer.book.save(fields, "sk-0123")).rejects.toThrow();
    await expect(r.layer.book.save({ ...fields, headers: { "x-gateway-token": "gw-0123" } }, SERVER_KEY)).rejects.toThrow();
    expect((await r.layer.book.list()).connections).toEqual([]);
    expect(existsSync(join(r.dir, "secrets.json"))).toBe(false);
    const saved = await r.layer.book.save({ ...fields, headers: { "x-gateway-token": "gw-01234" } }, "sk-01234");
    const tested = await r.layer.book.test(saved.id);
    expect(r.sent.map((s) => [s.headers.authorization, s.headers["x-gateway-token"]])).toEqual([["Bearer sk-01234", "gw-01234"]]);
    expect(tested.ok).toBe(false);
    expect(JSON.stringify(tested)).not.toContain("sk-01234");
    expect(JSON.stringify(tested)).not.toContain("gw-01234");
  });

  test("stops at a file it can't read, in words that name it, and never writes over it", async () => {
    const dir = folder({ "connections.json": "{ not json" });
    const r = kept(rig({ dir }));
    await expect(r.layer.book.list()).rejects.toThrow(`${dir}/connections.json isn't valid JSON: fix or remove it, then restart the runtime.`);
    await expect(r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key" }, KEY)).rejects.toThrow("isn't valid JSON");
    await expect(r.layer.connections.get(null)).rejects.toThrow("isn't valid JSON");
    expect(readFileSync(join(dir, "connections.json"), "utf8")).toBe("{ not json");
    expect(existsSync(join(dir, "secrets.json"))).toBe(false);
  });
});

describe("what was stored for one server goes to no other", () => {
  test("a new origin for a connection's address takes its key and its headers' values away, and the new server gets neither; another path at the same origin keeps them", async () => {
    const r = kept(rig({ script: () => json({ data: [{ id: "served-model" }] }) }));
    const fields = { name: "Proxy", provider: "openai-compatible", auth: "key", model: "served-model" } as const;
    const saved = await r.layer.book.save({ ...fields, baseUrl: "https://proxy.example.com/v1", headers: { "x-gateway-token": GATEWAY } }, SERVER_KEY);
    // The same server at another path: what was stored for it stays.
    expect(await r.layer.book.save({ ...fields, id: saved.id, baseUrl: "https://proxy.example.com/v2" })).toMatchObject({ key: { set: true, last4: "mnop" }, headers: [{ name: "x-gateway-token", set: true }] });
    // Another server, and no key with the change: nothing stored goes there.
    expect(await r.layer.book.save({ ...fields, id: saved.id, baseUrl: "https://elsewhere.example/v1" })).toMatchObject({ key: { set: false, last4: null }, headers: [{ name: "x-gateway-token", set: false }] });
    expect(await r.layer.modelsOf(saved.id)).toEqual([{ id: "served-model", name: "served-model" }]);
    await expect(r.layer.models.call(request({ messages: [{ role: "user", content: "Where is Ilse?" }], connectionId: saved.id }), forever())).rejects.toThrow('The connection "Proxy" has no key');
    expect(r.sent.map((s) => s.url)).toEqual(["https://elsewhere.example/v1/models"]);
    expect(JSON.stringify(r.sent)).not.toContain(SERVER_KEY);
    expect(JSON.stringify(r.sent)).not.toContain(GATEWAY);
    expect(readFileSync(join(r.dir, "secrets.json"), "utf8")).not.toContain(SERVER_KEY);
    expect(readFileSync(join(r.dir, "connections.json"), "utf8")).not.toContain(GATEWAY);
  });

  test("a connection whose provider changes keeps no key: an OpenAI key never goes to OpenRouter", async () => {
    const r = kept(rig());
    const saved = await r.layer.book.save({ name: "Mine", provider: "openai", auth: "key", model: "gpt-5" }, OPENAI_KEY);
    expect((await r.layer.book.save({ id: saved.id, name: "Mine", provider: "openrouter", auth: "key", model: "openai/gpt-5" })).key).toEqual({ set: false, last4: null });
    await expect(r.layer.models.call(request({ messages: [{ role: "user", content: "Hello?" }] }), forever())).rejects.toThrow('The connection "Mine" has no key: add one on the Connections page.');
    expect(r.sent).toEqual([]);
    expect(readFileSync(join(r.dir, "secrets.json"), "utf8")).not.toContain(OPENAI_KEY);
    // A key that comes with the change is the new provider's own.
    expect((await r.layer.book.save({ id: saved.id, name: "Mine", provider: "openrouter", auth: "key" }, ROUTER_KEY)).key).toEqual({ set: true, last4: "klmn" });
  });

  test("a connection that signs in goes to its provider's own address: one given another is refused when saved, and left out when read", async () => {
    const r = kept(rig());
    expect(await wordsOf(r.layer.book.save({ name: "Claude sign-in", provider: "anthropic", auth: "signin", baseUrl: "https://elsewhere.example", model: "claude-sonnet-4-5" }))).toBe(
      "A connection that signs in to Anthropic goes to Anthropic's own address: leave the address out.",
    );
    expect((await r.layer.book.list()).connections).toEqual([]);

    // Written by hand beside a sign-in the runtime holds: the connection is left out, and the token goes nowhere.
    const token = { type: "oauth", access: "sk-ant-oat01-held-0123456789abcdef", refresh: "sk-ant-ort01-held-0123456789abcdef", expires: 4_102_444_800_000 };
    const dir = folder({
      "connections.json": bookFile({ id: "c1", name: "Claude sign-in", provider: "anthropic", auth: "signin", baseUrl: "https://elsewhere.example", model: "claude-sonnet-4-5" }),
      "secrets.json": JSON.stringify({ lumiah: 1, keys: {}, signins: { anthropic: token } }),
    });
    const read = kept(rig({ dir }));
    expect((await read.layer.book.list()).connections).toEqual([]);
    expect(read.logs).toContain(`left out the connection "Claude sign-in" in ${dir}/connections.json: A connection that signs in to Anthropic goes to Anthropic's own address: leave the address out.`);
    expect(await read.layer.book.test("c1")).toMatchObject({ ok: false, error: "This call's connection is no longer there: pick another on the Connections page." });
    expect(read.sent).toEqual([]);
  });

  test("a connection copied in under an id starts with only the key it is given", async () => {
    // A key left in the secrets under that id, by a connection the book no longer holds.
    const dir = folder({ "secrets.json": JSON.stringify({ lumiah: 1, keys: { "lumi-7": SERVER_KEY }, signins: {} }) });
    const r = kept(rig({ dir }));
    const copied = await r.layer.book.save({ id: "lumi-7", name: "Copied", provider: "openai-compatible", auth: "key", baseUrl: "http://127.0.0.1:8080/v1" }, undefined, { create: true });
    expect(copied.key).toEqual({ set: false, last4: null });
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).not.toContain(SERVER_KEY);
  });
});

describe("a connection's headers", () => {
  test("the pages see each header's name and whether it has a value, never the value; a save keeps, changes or takes each away as it says", async () => {
    const r = kept(rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: "At the quay." }))) }));
    const fields = { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" } as const;
    const saved = await r.layer.book.save({ ...fields, headers: { "x-gateway-token": GATEWAY, "x-team": "harbour-crew" } }, KEY);
    expect(saved.headers).toEqual([
      { name: "x-gateway-token", set: true },
      { name: "x-team", set: true },
    ]);
    expect(JSON.stringify(await r.layer.book.list())).not.toContain(GATEWAY);
    // Null keeps the value stored under a name; a text changes it.
    await r.layer.book.save({ ...fields, id: saved.id, headers: { "x-gateway-token": null, "x-team": "quay-watch" } });
    await r.layer.models.call(request({ messages: [{ role: "user", content: "Where is Ilse?" }] }), forever());
    expect([r.sent[0]?.headers["x-gateway-token"], r.sent[0]?.headers["x-team"]]).toEqual([GATEWAY, "quay-watch"]);
    // A name left out is taken away, and null takes them all.
    expect((await r.layer.book.save({ ...fields, id: saved.id, headers: { "x-team": null } })).headers).toEqual([{ name: "x-team", set: true }]);
    expect((await r.layer.book.save({ ...fields, id: saved.id, headers: null })).headers).toBeUndefined();
  });

  test("an address with a name and a password in it is refused in words that never repeat it, and left out when read", async () => {
    const address = "https://okoro:hunter2-0123456789@proxy.example.com/v1";
    const r = kept(rig());
    expect(await wordsOf(r.layer.book.save({ name: "Proxy", provider: "openai-compatible", auth: "none", baseUrl: address }))).toBe("An address can't hold a name or a password: give the key in its own field, or a header.");
    const dir = folder({ "connections.json": bookFile({ id: "c1", name: "Proxy", provider: "openai-compatible", auth: "none", baseUrl: address, model: "served-model" }) });
    const read = kept(rig({ dir }));
    expect((await read.layer.book.list()).connections).toEqual([]);
    expect(read.logs).toEqual([`left out the connection "Proxy" in ${dir}/connections.json: An address can't hold a name or a password: give the key in its own field, or a header.`]);
  });
});

describe("the files on the disk", () => {
  test("each file is flushed to the disk before it is moved into place, and the move is flushed with its folder", async () => {
    const dir = folder();
    const done: string[] = [];
    const named = (path: unknown): string => String(path).slice(dir.length + 1) || "the folder";
    const files: BookFiles = {
      ...nodeFiles,
      async open(path, flags, mode) {
        const handle = await nodeFiles.open(path, flags, mode);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          done.push(`flush ${named(path)}`);
          await sync();
        };
        return handle;
      },
      async rename(from, to) {
        done.push(`move ${named(from)} to ${named(to)}`);
        await nodeFiles.rename(from, to);
      },
    };
    const book = new Book({ dir, log: () => undefined, files });
    await book.save({ name: "Claude", provider: "anthropic", auth: "key" }, KEY, () => "c1");
    expect(done).toEqual([
      "flush connections.json.tmp",
      "move connections.json.tmp to connections.json",
      "flush the folder",
      "flush secrets.json.tmp",
      "move secrets.json.tmp to secrets.json",
      "flush the folder",
    ]);
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).toContain(KEY);
  });

  test("a folder and files other accounts could read are made the owner's alone as they are read, and the log says so", async () => {
    const dir = folder({ "connections.json": bookFile(), "secrets.json": JSON.stringify({ lumiah: 1, keys: {}, signins: {} }) });
    chmodSync(dir, 0o755);
    chmodSync(join(dir, "connections.json"), 0o644);
    chmodSync(join(dir, "secrets.json"), 0o644);
    const r = kept(rig({ dir }));
    await r.layer.book.list();
    expect([modeOf(dir), modeOf(join(dir, "connections.json")), modeOf(join(dir, "secrets.json"))]).toEqual([0o700, 0o600, 0o600]);
    expect(r.logs).toEqual([
      `${dir} was open to other accounts (mode 755): made it its owner's alone (700)`,
      `${dir}/connections.json was open to other accounts (mode 644): made it its owner's alone (600)`,
      `${dir}/secrets.json was open to other accounts (mode 644): made it its owner's alone (600)`,
    ]);
  });

  test("a file that isn't JSON is said to be so, never quoted: a key in it stays out of the words", async () => {
    const unquoted = "sk0123456789abcdefOkoroWXYZ";
    const dir = folder({ "secrets.json": `{"lumiah":1,"keys":{"c1":${unquoted}},"signins":{}}` });
    const r = kept(rig({ dir }));
    const words = await wordsOf(r.layer.book.list());
    expect(words).toBe(`${dir}/secrets.json isn't valid JSON: fix or remove it, then restart the runtime.`);
    expect(words).not.toContain(unquoted);
  });

  test("a compatible connection with no address is left out when read, with a line in the log, and no call goes out on it", async () => {
    const dir = folder({
      "connections.json": bookFile({ id: "c1", name: "Local", provider: "openai-compatible", auth: "key", model: "served-model" }),
      "secrets.json": JSON.stringify({ lumiah: 1, keys: { c1: SERVER_KEY }, signins: {} }),
    });
    const r = kept(rig({ dir }));
    expect((await r.layer.book.list()).connections).toEqual([]);
    expect(r.logs).toEqual([`left out the connection "Local" in ${dir}/connections.json: An OpenAI-compatible connection needs the server's address.`]);
    await expect(r.layer.models.call(request({ messages: [{ role: "user", content: "Hello?" }], connectionId: "c1" }), forever())).rejects.toThrow("This call's connection is no longer there");
    await expect(r.layer.modelsOf("c1")).rejects.toThrow("That connection is no longer there");
    expect(r.sent).toEqual([]);
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

  test("a provider that doesn't answer within the Provider wait is said not to have, with that setting and where it is changed; a server's list of models waits as long", async () => {
    // The Provider wait set short, shown in the Settings of an extension that builds LumiAH in; neither the provider nor the server ever answers.
    const asked = Promise.withResolvers<void>();
    const never = (_: unknown, n: number): Promise<Response> => {
      if (n === 1) asked.resolve();
      return new Promise<Response>(() => undefined);
    };
    const r = kept(rig({ script: never, askMs: 2_000, owner: { name: "LumiRPEngine", settingsAt: "LumiRPEngine's Harness tab → System → Settings" } }));
    const claude = await r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const local = await r.layer.book.save({ name: "Local", provider: "openai-compatible", auth: "key", baseUrl: "http://127.0.0.1:8080/v1" }, SERVER_KEY);
    const tested = r.layer.book.test(claude.id);
    const listed = wordsOf(r.layer.modelsOf(local.id));
    // Both were sent, and each waits as long as the setting says, no longer.
    await asked.promise;
    expect([...r.timers.pending.values()].map((timer) => timer.ms)).toEqual([2_000, 2_000]);
    r.timers.fireAll();
    const place = "Provider wait (LumiRPEngine's Harness tab → System → Settings → Timeouts → A model call) says how long the runtime waits for it.";
    expect(await tested).toMatchObject({ ok: false, error: `The provider didn't answer within 2 seconds. ${place}` });
    expect(await listed).toBe(`The server didn't list its models: it didn't answer within 2 seconds. ${place}`);
  });
});

describe("a connection's models, for the pickers", () => {
  test("a provider's own come from pi-ai's catalogue", async () => {
    const r = kept(rig());
    await r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key" }, KEY);
    expect((await r.layer.modelsOf(null)).map((m) => m.id)).toContain("claude-sonnet-4-5");
    expect(r.sent).toEqual([]);
  });

  test("a compatible server's come from the server, asked with the connection's key and headers, and no redirect followed", async () => {
    const r = kept(rig({ script: (sent) => (sent.url.startsWith("https://proxy.example.com/") ? json({ data: [{ id: "claude-proxy", display_name: "Claude via the proxy" }] }) : json({ object: "list", data: [{ id: "served-model" }, { id: "other-model" }] })) }));
    const open = await r.layer.book.save({ name: "Local", provider: "openai-compatible", auth: "key", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model", headers: { "x-team": "harbour-crew" } }, SERVER_KEY);
    const proxy = await r.layer.book.save({ name: "Proxy", provider: "anthropic-compatible", auth: "key", baseUrl: "https://proxy.example.com" }, SERVER_KEY);
    expect(await r.layer.modelsOf(open.id)).toEqual([
      { id: "served-model", name: "served-model" },
      { id: "other-model", name: "other-model" },
    ]);
    expect(await r.layer.modelsOf(proxy.id)).toEqual([{ id: "claude-proxy", name: "Claude via the proxy" }]);
    expect(r.sent.map((s) => [s.url, s.headers.authorization ?? s.headers["x-api-key"], s.headers["x-team"] ?? "none", s.redirect])).toEqual([
      ["http://127.0.0.1:8080/v1/models", `Bearer ${SERVER_KEY}`, "harbour-crew", "error"],
      ["https://proxy.example.com/v1/models", SERVER_KEY, "none", "error"],
    ]);
  });

  test("a server whose list isn't JSON is said to be so, never quoted", async () => {
    const r = kept(rig({ script: () => new Response(`<html>Unknown key ${SERVER_KEY.slice(0, 12)}</html>`, { status: 200, headers: { "content-type": "text/html" } }) }));
    const saved = await r.layer.book.save({ name: "Local", provider: "openai-compatible", auth: "key", baseUrl: "http://127.0.0.1:8080/v1" }, SERVER_KEY);
    expect(await wordsOf(r.layer.modelsOf(saved.id))).toBe("The server didn't list its models: its answer isn't JSON.");
  });

  test("a server that won't list them says why, and never the key", async () => {
    const r = kept(rig({ script: () => failed(403, { error: { message: `key ${SERVER_KEY} may not list models`, type: "permission_error" } }) }));
    const saved = await r.layer.book.save({ name: "Local", provider: "openai-compatible", auth: "key", baseUrl: "http://127.0.0.1:8080/v1" }, SERVER_KEY);
    const failure = await wordsOf(r.layer.modelsOf(saved.id));
    expect(failure).toStartWith("The server didn't list its models: 403: key ");
    expect(failure).not.toContain(SERVER_KEY);
  });

  test("a list without end is read no further than 8 MB, and a server's long words are cut to what a page can show", async () => {
    const endless = (): Response => new Response(new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(new Uint8Array(1024 * 1024).fill(32)) }), { status: 200, headers: { "content-type": "application/json" } });
    const r = kept(rig({ script: (sent) => (sent.url.startsWith("http://127.0.0.1:8080/") ? endless() : failed(400, { error: { message: `The tide is out. ${"Okoro waits at the quay. ".repeat(4000)}` } })) }));
    const open = await r.layer.book.save({ name: "Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1" });
    expect(await wordsOf(r.layer.modelsOf(open.id))).toBe("The server didn't list its models: its answer is larger than 8 MB, more than the runtime reads.");
    const wordy = await r.layer.book.save({ name: "Wordy", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.2:8080/v1" });
    const failure = await wordsOf(r.layer.modelsOf(wordy.id));
    expect(failure).toStartWith("The server didn't list its models: 400: The tide is out. Okoro waits at the quay.");
    expect(failure.length).toBe(WORDS_MAX + 1);
    expect(failure).toEndWith("…");
  });
});
