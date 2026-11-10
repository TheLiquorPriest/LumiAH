// The exact prompt of each model call (DESIGN §8: "the exact prompt of any call"), kept as blobs.
//
// A call's request is its messages and everything else it was sent with. An agent's calls share
// almost all of their messages: each round sends the conversation so far again, with the round
// before added. So a call's blob holds only the messages that differ from the same agent's call
// before it, and names that call's blob for the rest (`base`, `keep`): a turn of many rounds stores
// each message once or twice, never once per round. `readCallPrompt` follows the chain and gives the
// request whole.

import type { Blobs } from "./blobs";
import { isHash, textHash } from "./hash";
import type { BlobsPort, ModelMessage, ModelRequest } from "./ports";
import { isRecord } from "./ports";
import { parseJson } from "./util";

/** A call's prompt as stored: the request without its messages, the messages it doesn't share with `base` (the same agent's call before it; null for none), and how many leading messages it takes from there. */
interface StoredPrompt {
  v: 1;
  kind: "prompt";
  request: Omit<ModelRequest, "messages">;
  base: string | null;
  keep: number;
  messages: ModelMessage[];
}

/** Keeps a turn's prompts: remembers each agent's last call, so the next one stores only what it adds. */
export class PromptKeeper {
  /** Each agent's last call: its blob, and each of its messages as JSON, to compare the next call's with. */
  private readonly last = new Map<string, { hash: string; messages: string[] }>();

  constructor(private readonly blobs: Blobs) {}

  /** Stores `request` as `agentId`'s next call, and gives its blob's hash. */
  async keep(agentId: string, request: ModelRequest): Promise<string> {
    const { messages, ...rest } = request;
    const json = messages.map((m) => JSON.stringify(m));
    const before = this.last.get(agentId);
    let shared = 0;
    if (before) while (shared < json.length && shared < before.messages.length && json[shared] === before.messages[shared]) shared++;
    const stored: StoredPrompt = { v: 1, kind: "prompt", request: rest, base: before && shared > 0 ? before.hash : null, keep: before ? shared : 0, messages: messages.slice(shared) };
    const hash = await this.blobs.put(JSON.stringify(stored), false);
    this.last.set(agentId, { hash, messages: json });
    return hash;
  }
}

function storedOf(raw: unknown): StoredPrompt | null {
  if (!isRecord(raw) || raw.v !== 1 || raw.kind !== "prompt" || !isRecord(raw.request) || !Array.isArray(raw.messages) || typeof raw.keep !== "number" || !Number.isSafeInteger(raw.keep) || raw.keep < 0) return null;
  if (raw.base !== null && !isHash(raw.base)) return null;
  // A stored prompt is the core's own blob, read back under its hash: past its envelope, its request and messages are taken as written.
  return raw as unknown as StoredPrompt;
}

/**
 * The exact request of the call whose prompt is the blob `hash` (`TranscriptEntry.prompt`), read
 * from `blobs` and checked against its hash at every link of its chain; null when any of it is
 * missing or isn't what it should be.
 */
export async function readCallPrompt(blobs: Pick<BlobsPort, "get">, hash: string): Promise<ModelRequest | null> {
  const chain: StoredPrompt[] = [];
  for (let at: string | null = hash; at !== null; ) {
    if (!isHash(at)) return null;
    const text: string | null = await blobs.get(at);
    if (text === null || (await textHash(text)) !== at) return null;
    const stored = storedOf(parseJson(text));
    if (!stored) return null;
    chain.push(stored);
    at = stored.keep > 0 ? stored.base : null;
  }
  // From the oldest call of the chain to this one: each keeps the first `keep` messages of the one before, then adds its own.
  let messages: ModelMessage[] = [];
  for (const stored of chain.reverse()) {
    if (stored.keep > messages.length) return null;
    messages = [...messages.slice(0, stored.keep), ...stored.messages];
  }
  const own = chain.at(-1);
  return own ? { ...own.request, messages } : null;
}
