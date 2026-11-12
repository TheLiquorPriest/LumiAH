// After a crash or a restart, the journal is replayed (PI-BUILD-PLAN §4.4): nothing written and
// acknowledged is ever missing from the mirror for good. A run writes, removes and stores while the
// mirror's answer is held back, then lets the store send it all; the process is cut off before each
// change it makes, on the disk or in the mirror, in turn. At every cut, a runtime started again on
// the same folder brings the mirror to what was acknowledged (or to the change under way at the cut),
// its own copy agrees with the mirror, and nothing is left in its journal or its temp folder.

import { describe, expect, test } from "bun:test";
import { textHash } from "../../../src/core/hash";
import type { JsonValue } from "../../../src/core/ports";
import { type Bench, bench, cleanUp, Cut, cutDisk, files, open } from "./rig";

/** One step of the run: a document written (or removed, as null), or a blob stored. */
type Step = { path: string; value: JsonValue | null } | { text: string };

const STEPS: Step[] = [
  { path: "chats/c1/session.json", value: { asked: 1 } },
  { text: "a segment of the first turn" },
  { path: "jobs/all.json", value: { jobs: ["j1"] } },
  { path: "chats/c1/session.json", value: { asked: 2 } },
  { path: "jobs/all.json", value: null },
  { text: "the transcript of the first turn" },
  { path: "chats/c1/approvals.json", value: null },
  { path: "jobs/all.json", value: { jobs: ["j2"] } },
];

/** What the mirror holds before the run: one document the run removes, and one it never touches. */
const BEFORE: Record<string, JsonValue> = { "chats/c1/approvals.json": { tools: ["web_search"] }, "chats/c1/learned.json": { files: 1 } };

const PATHS = [...new Set([...Object.keys(BEFORE), ...STEPS.flatMap((step) => ("path" in step ? [step.path] : []))])];

/** How far a run got: how many steps were acknowledged, and the one under way when it was cut off (null: none). */
interface Reached {
  acked: number;
  during: number | null;
}

/** The run, on a disk and a mirror that stop at the cut. */
async function run(b: Bench, cut: Cut): Promise<Reached> {
  for (const [path, value] of Object.entries(BEFORE)) b.mirror.docs.set(path, JSON.stringify(value));
  let held: PromiseWithResolvers<void> | null = null;
  b.mirror.hold = async (what) => {
    if (/^(write|remove|put|drop) /.test(what)) await cut.change();
    else await cut.look();
    // While the steps are taken, a round of sending waits at its first look at the mark.
    if (held !== null && what === "read mirror.json") await held.promise;
  };
  // Every round reads the mark first, so the one the first step begins waits there.
  const s = open(b, { disk: cutDisk(cut), limits: () => ({ markMs: 0 }) });
  const alive = (work: Promise<unknown>): Promise<boolean> => Promise.race([work.then(() => true), cut.died.then(() => false)]);
  if (!(await alive(s.settle()))) return { acked: 0, during: null };

  held = Promise.withResolvers<void>();
  for (const [n, step] of STEPS.entries()) {
    const done = "text" in step ? textHash(step.text).then((hash) => s.blobs.put(hash, step.text)) : step.value === null ? s.store.remove(step.path) : s.store.write(step.path, step.value);
    if (!(await alive(done))) return { acked: n, during: n };
  }
  held.resolve();
  if (await alive(s.settle())) await s.close();
  return { acked: STEPS.length, during: null };
}

/** The text a mirror holds for a document after the steps up to `upTo` ("" for none). */
function after(path: string, upTo: number): string {
  let value: JsonValue | null = BEFORE[path] ?? null;
  for (const step of STEPS.slice(0, upTo)) if ("path" in step && step.path === path) value = step.value;
  return value === null ? "" : JSON.stringify(value);
}

/** Starts the runtime again on the same folder, lets it settle, and checks the mirror and its copy against what the run reached. */
async function startAgain(b: Bench, reached: Reached): Promise<void> {
  b.mirror.hold = null;
  const s = open(b);
  await s.settle();
  for (const path of PATHS) {
    const allowed = new Set([after(path, reached.acked)]);
    if (reached.during !== null) allowed.add(after(path, reached.during + 1));
    expect([...allowed]).toContain(b.mirror.docs.get(path) ?? "");
    expect(await s.store.read(path)).toEqual(b.mirror.doc(path));
  }
  expect([...b.mirror.docs.keys()].filter((path) => path !== "mirror.json" && !PATHS.includes(path))).toEqual([]);
  for (const [n, step] of STEPS.entries()) {
    if (!("text" in step)) continue;
    const hash = await textHash(step.text);
    if (n < reached.acked) expect(b.mirror.stored.get(hash)?.text).toBe(step.text);
    if (b.mirror.stored.has(hash)) expect(await s.blobs.get(hash)).toBe(step.text);
  }
  expect((await files(b.dir)).filter((file) => file.includes("/journal/") || file.includes("/tmp/"))).toEqual([]);
  await s.close();
}

/** How many changes a run makes, cut nowhere. */
async function changesOfARun(): Promise<number> {
  const b = await bench();
  try {
    const cut = new Cut(Number.POSITIVE_INFINITY);
    const reached = await run(b, cut);
    if (reached.acked !== STEPS.length) throw new Error("a run cut nowhere didn't finish");
    await startAgain(b, reached);
    return cut.changes;
  } finally {
    await cleanUp(b);
  }
}

const CHANGES = await changesOfARun();

describe("a crash between any two steps", () => {
  test("a run cut nowhere makes changes on the disk and in the mirror, each a place to cut", () => {
    expect(CHANGES).toBeGreaterThan(STEPS.length * 3);
  });

  for (let at = 0; at <= CHANGES; at += 1) {
    test(`cut before change ${at}: started again, the mirror holds everything acknowledged`, async () => {
      const b = await bench();
      try {
        const cut = new Cut(at);
        const reached = await run(b, cut);
        // Every change before the last one counted is one the run dies at.
        expect(cut.dead).toBe(at < CHANGES);
        await startAgain(b, reached);
      } finally {
        await cleanUp(b);
      }
    });
  }
});
