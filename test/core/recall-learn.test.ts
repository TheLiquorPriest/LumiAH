// Learning an existing story by stretches (DESIGN §24.7), through a whole job on a scripted model:
// the chronicler plans from the cut `chat_outline` makes, has a story reader read each stretch,
// merges what the readers answer, and checks it. The script does what the skill tells a model to
// do, from what the tools answer and nothing else, so what the test shows is the code's part: the
// chronicler is sent no text of the chat, and a reader that fails is told to it as failed, so its
// stretch is unread in the plan, in what the check lists, and in the job's report.

import { expect, test } from "bun:test";
import { createHarness } from "../../src/core/harness";
import type { ModelRequest } from "../../src/core/ports";
import { CHRONICLER, READER } from "../../src/core/recall/definitions";
import { defaultSettings } from "../../src/core/settings";
import { CHAT, harbour } from "./recall-support";
import { type Answer, call } from "./support/host";

const PLAN = "learned/chronicle/plan.md";
const OUTLINE = "learned/chronicle/outline.md";

const firstUser = (request: ModelRequest): string => request.messages.find((m) => m.role === "user")?.content ?? "";
const isChronicler = (request: ModelRequest): boolean => firstUser(request).startsWith("You are running as a job");

/** Every text a request sends a model: its messages, and what the tool calls among them came to. */
const sent = (request: ModelRequest): string => request.messages.map((m) => [m.content, ...(m.parts ?? []).map((part) => (part.type === "tool_result" ? part.content : ""))].join("\n")).join("\n");

/** What the tool calls of an agent's latest answer came to, by the call's id. */
function results(request: ModelRequest): Map<string, { text: string; failed: boolean }> {
  const found = new Map<string, { text: string; failed: boolean }>();
  for (const part of request.messages.at(-1)?.parts ?? []) if (part.type === "tool_result") found.set(part.toolUseId, { text: part.content, failed: part.isError === true });
  return found;
}

const span = (s: readonly [number, number]): string => `#${s[0]} to #${s[1]}`;

test("a story is learned by stretches: the chronicler's session holds no text of the chat, and a failed reader's stretch is marked unread", async () => {
  const host = harbour();
  const stored = { values: defaultSettings(), texts: {} as Record<string, string> };
  // Twelve messages, cut into three stretches of four.
  stored.values.recall.chronicle.stretchMessages = 4;
  const harness = createHarness(host, { settings: async () => structuredClone(stored) });

  let stretches: [number, number][] = [];
  let step = 0;
  /** How far each reader has got, by the stretch its task names. */
  const readers = new Map<string, number>();
  const chronicler = (request: ModelRequest): Answer => {
    const got = results(request);
    switch (step++) {
      case 0:
        return { toolCalls: [call("chat_outline", { stretches: true }, "o1")] };
      case 1: {
        // The plan: one line a stretch, as the cut gives them. A reader for each, all in one answer.
        stretches = [...(got.get("o1")?.text ?? "").matchAll(/^- #(\d+) to #(\d+) ·/gm)].map((m): [number, number] => [Number(m[1]), Number(m[2])]);
        return { toolCalls: [call("workspace_write", { path: PLAN, content: stretches.map((s) => `[ ] ${span(s)}`).join("\n"), base: "new" }, "p1"), ...stretches.map((s, i) => call("delegate", { agent: READER, task: `Read ${span(s)}.` }, `d${i}`))] };
      }
      case 2: {
        // Merge what the readers returned; a stretch whose reader `delegate` says failed is marked unread.
        const lines = stretches.flatMap((_, i) => (got.get(`d${i}`)?.failed ? [] : (got.get(`d${i}`)?.text ?? "").split("\n").filter((line) => /^- #\d+–#\d+ · /.test(line))));
        const plan = stretches.map((s, i) => (got.get(`d${i}`)?.failed ? `[!] ${span(s)}: unread from #${s[0]}, its reader stopped before it answered` : `[x] ${span(s)}`)).join("\n");
        const version = /version ([0-9a-f]+)/.exec(got.get("p1")?.text ?? "")?.[1] ?? "";
        return { toolCalls: [call("workspace_write", { path: OUTLINE, content: lines.join("\n"), base: "new" }, "m1"), call("workspace_write", { path: PLAN, content: plan, base: version }, "p2")] };
      }
      case 3:
        return { toolCalls: [call("chronicle_check", {}, "k1")] };
      default: {
        // The report names as unread what the check lists as not covered.
        const unread = /No outline line covers [^:]+: ([^\n]+?)\.(\n|$)/.exec(got.get("k1")?.text ?? "")?.[1] ?? "nothing";
        return `Read by readers: ${stretches.length - 1} of ${stretches.length} stretches. Unread: ${unread}. The files are in learned/chronicle/.`;
      }
    }
  };
  const reader = (request: ModelRequest): Answer => {
    const stretch = /Read (#\d+ to #\d+)\./.exec(firstUser(request))?.[1] ?? "";
    const [from = 0, to = 0] = [...stretch.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    const at = readers.get(stretch) ?? 0;
    readers.set(stretch, at + 1);
    // The reader of the second stretch never answers: its provider refuses every call.
    if (from === 4) return { error: "the provider refused the call" };
    if (at === 0) return { toolCalls: [call("chat_read", { from, to }, `r${from}`)] };
    const cited = [...(results(request).get(`r${from}`)?.text ?? "").matchAll(/\[#\d+ [0-9a-f]{8}\]/g)].map((m) => m[0]);
    return `outline:\n- #${from}–#${to} · What the stretch established, in the reader's own words. ${cited[0] ?? ""} ${cited.at(-1) ?? ""}\nfacts:\nthreads:\ncast:\nread: ${stretch}`;
  };
  host.script = (request) => (isChronicler(request) ? chronicler(request) : reader(request));

  const { job } = await harness.jobs.start({ chatId: CHAT, agent: CHRONICLER, task: "Learn this story.", when: "now" });
  const ran = await harness.jobs.run({ id: job.id }, new AbortController().signal);
  expect(ran.state).toBe("done");
  expect(stretches).toEqual([
    [0, 3],
    [4, 7],
    [8, 11],
  ]);

  // The chronicler was sent the cut, the readers' answers and the check's: no message of the chat, whole or by the sentence.
  const chat = (await host.chat.messages(CHAT, 0, 11)).map((m) => m.content);
  const pieces = chat.flatMap((text) => [text, ...text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length >= 20)]);
  const mine = host.calls.filter(isChronicler);
  expect(mine).toHaveLength(5);
  for (const request of mine) for (const piece of pieces) expect(sent(request).includes(piece) ? piece : "").toBe("");
  // The readers were: each read its own stretch, and nothing was read by the chronicler.
  const theirs = host.calls.filter((request) => !isChronicler(request));
  expect(theirs.some((request) => sent(request).includes(chat[0] ?? "\u0000"))).toBe(true);
  expect(mine.flatMap((request) => (request.tools ?? []).map((tool) => tool.name)).filter((name) => /^chat_(read|around|grep|search)$/.test(name))).toEqual([]);

  // The failed reader was told to the chronicler as failed, by name, and the two others as answers.
  const told = results(mine[2] as ModelRequest);
  expect([told.get("d0")?.failed, told.get("d1")?.failed, told.get("d2")?.failed]).toEqual([false, true, false]);
  expect(told.get("d1")?.text).toContain(READER);

  // Its stretch is unread in the plan, in what the check lists as not covered, and in the job's report.
  expect((await harness.workspace.read({ chatId: CHAT, area: "learned", path: "chronicle/plan.md" })).text).toBe("[x] #0 to #3\n[!] #4 to #7: unread from #4, its reader stopped before it answered\n[x] #8 to #11");
  const outline = (await harness.workspace.read({ chatId: CHAT, area: "learned", path: "chronicle/outline.md" })).text.split("\n");
  expect(outline.map((line) => line.slice(0, 9))).toEqual(["- #0–#3 ·", "- #8–#11 "]);
  const check = results(mine[4] as ModelRequest).get("k1");
  expect(check?.failed).toBe(false);
  expect(check?.text).toContain("No outline line covers 4 messages: #4 to #7.");
  expect((await harness.jobs.read({ id: job.id })).report).toBe("Read by readers: 2 of 3 stretches. Unread: #4 to #7. The files are in learned/chronicle/.");
});
