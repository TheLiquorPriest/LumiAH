// Bodies as blobs (DESIGN §5): text stored once by its hash and never changed, checked against its
// hash when read; and the exact prompt of each call, stored so that an agent's rounds share what
// they share.

import { describe, expect, test } from "bun:test";
import { Blobs } from "../../src/core/blobs";
import { isHash, nextPath, partsHash, ROOT_PATH, textHash } from "../../src/core/hash";
import type { ModelRequest } from "../../src/core/ports";
import { PromptKeeper, readCallPrompt } from "../../src/core/prompts";
import { MemoryHost } from "./support/host";

describe("blobs", () => {
  test("a text is stored under the hash of its text, and read back by it", async () => {
    const host = new MemoryHost();
    const blobs = new Blobs(host, () => 1000);
    const hash = await blobs.put("The lamp is lit.");
    expect(isHash(hash)).toBe(true);
    expect(hash).toBe(await textHash("The lamp is lit."));
    // SHA-256 of the text's UTF-8, in lower-case hex: what any other SHA-256 gives for it.
    expect(hash).toBe("665f424b5c347759d7b4c418c3ad34092118ca9b00572d9de9768f297af64b06");
    expect(await blobs.put("The lamp is lit.")).toBe(hash);
    expect(host.blobStore.size).toBe(1);
    expect(await blobs.get(hash)).toBe("The lamp is lit.");
    expect(await blobs.getJson(await blobs.putJson({ steps: [1, 2] }))).toEqual({ steps: [1, 2] });
  });

  test("what the store hands back under the wrong hash is read as missing, and the log says so", async () => {
    const host = new MemoryHost();
    const hash = await textHash("The lamp is lit.");
    host.blobStore.set(hash, "The lamp is out.");
    const blobs = new Blobs(host, () => 1000);
    expect(await blobs.get(hash)).toBeNull();
    expect(host.logs.at(-1)?.message).toContain("doesn't match its hash");
    expect(await blobs.get("not-a-hash")).toBeNull();
    expect(await blobs.get(await textHash("never stored"))).toBeNull();
  });

  test("a text read once is kept in memory within its setting, the one used longest ago let go first", async () => {
    const host = new MemoryHost();
    let reads = 0;
    const get = host.blobs.get;
    host.blobs.get = async (hash) => (reads++, get(hash));
    const fresh = new Blobs(host, () => 25);
    const [a, b, c] = await Promise.all(["a".repeat(10), "b".repeat(10), "c".repeat(10)].map(async (text) => (host.blobStore.set(await textHash(text), text), textHash(text))));
    await fresh.get(a!);
    await fresh.get(b!);
    await fresh.get(a!);
    expect(reads).toBe(2);
    await fresh.get(c!);
    await fresh.get(a!);
    expect(reads).toBe(3);
    await fresh.get(b!);
    expect(reads).toBe(4);
  });

  test("a path hash chains over each message's role and text, so any change before a record moves it", async () => {
    const a = await textHash("I knock.");
    const one = await nextPath(ROOT_PATH, "user", a);
    expect(await nextPath(ROOT_PATH, "user", a)).toBe(one);
    expect(await nextPath(ROOT_PATH, "assistant", a)).not.toBe(one);
    expect(await nextPath(ROOT_PATH, "user", await textHash("I knock twice."))).not.toBe(one);
    expect(await partsHash("ab", "c")).not.toBe(await partsHash("a", "bc"));
  });
});

describe("the exact prompt of a call", () => {
  const request = (messages: ModelRequest["messages"]): ModelRequest => ({ messages, maxTokens: 800, connectionId: "conn-1", model: null, effort: "low", usage: true, tools: [{ name: "lookup", description: "Looks up.", parameters: { type: "object", properties: {} } }] });

  test("is read back whole, though each round stores only what it adds to the round before", async () => {
    const host = new MemoryHost();
    const blobs = new Blobs(host, () => 0);
    const keeper = new PromptKeeper(blobs);
    const system = { role: "system" as const, content: "You look things up." };
    const long = { role: "user" as const, content: `The request: ${"a message of the chat. ".repeat(400)}` };
    const first = request([system, { ...long, parts: [{ type: "text", text: long.content, cache: true }] }]);
    // The next round sends the same messages again, the cache mark moved on to the latest.
    const second = request([system, long, { role: "assistant", content: "lookup {}" }, { role: "user", content: "found it", parts: [{ type: "tool_result", toolUseId: "c1", content: "found it", cache: true }] }]);
    const third = request([...second.messages.slice(0, 3), { role: "user", content: "found it", parts: [{ type: "tool_result", toolUseId: "c1", content: "found it" }] }, { role: "assistant", content: "lookup {}" }, { role: "user", content: "again" }]);
    const hashes = [await keeper.keep("agent_a", first), await keeper.keep("agent_a", second), await keeper.keep("agent_a", third)];
    expect(await readCallPrompt(host.blobs, hashes[0]!)).toEqual(first);
    expect(await readCallPrompt(host.blobs, hashes[1]!)).toEqual(second);
    expect(await readCallPrompt(host.blobs, hashes[2]!)).toEqual(third);
    // The long message is stored with its mark and without, never a third time.
    const stored = [...host.blobStore.values()];
    expect(stored.filter((text) => text.includes("a message of the chat.")).length).toBe(2);
    expect(stored[2]!.length).toBeLessThan(600);
  });

  test("another agent's calls share nothing with it, and a blob that isn't a prompt reads as none", async () => {
    const host = new MemoryHost();
    const blobs = new Blobs(host, () => 0);
    const keeper = new PromptKeeper(blobs);
    const a = await keeper.keep("agent_a", request([{ role: "user", content: "one" }]));
    const b = await keeper.keep("agent_b", request([{ role: "user", content: "one" }, { role: "user", content: "two" }]));
    expect((await readCallPrompt(host.blobs, b))?.messages).toHaveLength(2);
    expect(a).not.toBe(b);
    expect(await readCallPrompt(host.blobs, await blobs.put("just some text"))).toBeNull();
    expect(await readCallPrompt(host.blobs, "nothing")).toBeNull();
    // A chain whose earlier call is gone can't be read whole, so it reads as none.
    const first = await keeper.keep("agent_c", request([{ role: "user", content: "kept" }]));
    const next = await keeper.keep("agent_c", request([{ role: "user", content: "kept" }, { role: "assistant", content: "more" }]));
    host.blobStore.delete(first);
    expect(await readCallPrompt(host.blobs, next)).toBeNull();
  });
});
