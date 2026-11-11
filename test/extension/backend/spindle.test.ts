// The one file that talks to Lumiverse (spindle.ts), over a stubbed `spindle` global: the prompt
// interceptor as Lumiverse calls it. What LumiAH didn't make goes back to Lumiverse exactly as it
// came (DESIGN §7): the very message objects, with the host's own fields and any field LumiAH
// doesn't know still on them. Lumiverse gives the next interceptor what this one hands back, so
// two backends made of LumiAH's code, run one after the other (§21), must each see which messages
// are the chat's and which are lore. Every other backend test stands on a fake above this file.

import { afterEach, describe, expect, test } from "bun:test";
import { createSpindleHost, type InterceptorInput } from "../../../src/extension/backend/spindle";

type Message = Record<string, unknown>;
type Registered = (messages: Message[], context: Record<string, unknown>) => Promise<unknown>;

const scope = globalThis as Record<string, unknown>;
const before = scope.spindle;
afterEach(() => {
  scope.spindle = before;
});

/** As much of Lumiverse's `spindle` global as the host reads to register an interceptor, for one extension's worker: what it registered, once it has. */
function worker(granted: (permission: string) => boolean = () => true): () => Registered {
  let registered: Registered | null = null;
  scope.spindle = {
    host: { capabilities: { "chat-lean-messages-v1": 1 } },
    manifest: { interceptorTimeoutMs: 300_000 },
    permissions: { has: granted, onChanged: () => undefined },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    registerInterceptor: (handler: Registered) => {
      registered = handler;
      return () => undefined;
    },
  };
  return () => {
    if (registered === null) throw new Error("no interceptor was registered");
    return registered;
  };
}

/** A prompt as Lumiverse hands it to the interceptor pipeline: its own flags on the messages, what it keeps of a chat message's source, and a field no build of LumiAH knows. */
const prompt = (): Message[] => [
  { role: "system", content: "You are Joss, keeper of the harbour light." },
  { role: "system", content: "The quay floods at spring tide.", __isWorldInfoEntry: true },
  { role: "user", content: "Who keeps the harbour light now?", __isChatHistory: true, sourceMessageId: "m1", sourceIndexInChat: 0, sourceMessageMetadata: { mood: "wary" }, hostOnly: { any: ["thing", 1] } },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Ilse did, " },
      { type: "text", text: "last I heard." },
    ],
    __isChatHistory: true,
    sourceMessageId: "m2",
    sourceIndexInChat: 1,
  },
];
const CONTEXT = { chatId: "chat-1", userId: "user-mara", generationId: "gen-1", generationType: "normal", isDryRun: false };
const OPTIONS = { priority: Number.MAX_SAFE_INTEGER, types: ["normal"] as const, required: false };

describe("the interceptor as Lumiverse calls it", () => {
  test("hands back a prompt that is none of LumiAH's exactly as it came: the very messages, every field of the host's still on them", async () => {
    const registered = worker();
    createSpindleHost().registerInterceptor(async () => ({}), OPTIONS);
    const came = prompt();
    const each = [...came];

    const back = await registered()(came, CONTEXT);

    expect(back).toBe(came);
    expect((back as Message[]).map((m, i) => m === each[i])).toEqual([true, true, true, true]);
    expect(back).toEqual(prompt());
  });

  test("leaves the next backend made of LumiAH's code able to tell the chat's messages and the lore: two backends in a row", async () => {
    // LumiAH, installed first: the chat isn't its own, so it changes nothing.
    const first = worker();
    createSpindleHost("lumi_ah").registerInterceptor(async () => ({}), OPTIONS);
    const lumiah = first();
    // An extension that has LumiAH built in, installed second: the chat is its own.
    const second = worker();
    const seen: InterceptorInput[] = [];
    createSpindleHost("lantern_ext").registerInterceptor(async (input) => {
      seen.push(input);
      return {};
    }, OPTIONS);
    const lantern = second();

    const left = (await lumiah(prompt(), CONTEXT)) as Message[];
    const sent = await lantern(left, CONTEXT);

    expect(seen[0]?.messages.map((m) => ({ text: m.text, history: m.history, lore: m.lore === true, sourceId: m.sourceId ?? null, sourceIndex: m.sourceIndex ?? null }))).toEqual([
      { text: "You are Joss, keeper of the harbour light.", history: false, lore: false, sourceId: null, sourceIndex: null },
      { text: "The quay floods at spring tide.", history: false, lore: true, sourceId: null, sourceIndex: null },
      { text: "Who keeps the harbour light now?", history: true, lore: false, sourceId: "m1", sourceIndex: 0 },
      { text: "Ilse did, last I heard.", history: true, lore: false, sourceId: "m2", sourceIndex: 1 },
    ]);
    // And what goes on to Lumiverse after both is still the prompt as Lumiverse made it.
    expect(sent).toEqual(prompt());
  });

  test("puts what LumiAH made in as its role and text, and sends every message that came as the object it came as, in its place", async () => {
    const registered = worker();
    createSpindleHost().registerInterceptor(async () => ({ messages: [{ keep: 0 }, { keep: 2 }, { role: "system", text: "Okoro keeps the light; Ilse handed it over.", label: "LumiAH: the main agent's brief" }, { keep: 3 }] }), OPTIONS);
    const came = prompt();

    const back = (await registered()(came, CONTEXT)) as { messages: Message[]; breakdown: unknown; parameters?: unknown };

    expect(back.messages.map((m) => came.indexOf(m))).toEqual([0, 2, -1, 3]);
    expect(back.messages[2]).toEqual({ role: "system", content: "Okoro keeps the light; Ilse handed it over." });
    expect(back.messages[1]).toEqual(prompt()[2]);
    expect(back.breakdown).toEqual([{ messageIndex: 2, name: "LumiAH: the main agent's brief" }]);
    expect(back.parameters).toBeUndefined();
  });

  test("leaves out only the messages the cutoff hides, and sends a tag only with the permission to set a request's parameters", async () => {
    const tagging = async () => ({ omit: [2], parameters: { lumiah_turn: "tag-1" } });
    const granted = worker();
    createSpindleHost().registerInterceptor(tagging, OPTIONS);
    const came = prompt();
    const back = (await granted()(came, CONTEXT)) as { messages: Message[]; parameters: unknown };
    expect(back.messages.map((m) => came.indexOf(m))).toEqual([0, 1, 3]);
    expect(back.parameters).toEqual({ lumiah_turn: "tag-1" });

    const without = worker((permission) => permission !== "generation_parameters");
    createSpindleHost().registerInterceptor(tagging, OPTIONS);
    const again = prompt();
    const untagged = (await without()(again, CONTEXT)) as Message[];
    expect(untagged.map((m) => again.indexOf(m))).toEqual([0, 1, 3]);
  });

  test("reads the generation from Lumiverse's context as the running Lumiverse and the published types name it, and passes a context that names no chat over", async () => {
    const registered = worker();
    const seen: InterceptorInput[] = [];
    createSpindleHost().registerInterceptor(async (input) => {
      seen.push(input);
      return {};
    }, OPTIONS);
    const stop = new AbortController();

    await registered()(prompt(), { chatId: "chat-1", userId: "user-mara", generationId: "gen-2", generationType: "swipe", dryRun: true, connectionId: "conn-main", presetId: "preset-1", personaId: "persona-1", interceptorDeadlineAt: 9_000, signal: stop.signal, activatedWorldInfo: [{ id: "entry-quay", bookId: "book-harbour", comment: "The quay", source: "keyword" }, { id: "entry-light", comment: "", source: "vector", score: 0.82 }, { comment: "no id" }] });
    await registered()(prompt(), CONTEXT);
    const came = prompt();
    expect(await registered()(came, { userId: "user-mara" })).toBe(came);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ chatId: "chat-1", userId: "user-mara", generationId: "gen-2", type: "swipe", dryRun: true, connectionId: "conn-main", presetId: "preset-1", personaId: "persona-1", deadlineAt: 9_000, signal: stop.signal });
    expect(seen[0]?.activated).toEqual([
      { entryId: "entry-quay", bookId: "book-harbour", title: "The quay", how: "key" },
      { entryId: "entry-light", bookId: null, title: "", how: "vector", score: 0.82 },
    ]);
    expect(seen[1]).toMatchObject({ generationId: "gen-1", type: "normal", dryRun: false, connectionId: null, presetId: null, personaId: null, activated: [] });
    expect(seen[1]?.signal).toBeUndefined();
  });
});
