// What Runtime → System says of a runtime's working store (store-model.ts).

import { describe, expect, test } from "bun:test";
import type { StoreStateView } from "../../src/shared/ui";
import { sizeOf, storeLead, storeLines } from "../../src/extension/frontend/store-model";

const NOW = 1_700_000_000_000;
const settled: StoreStateView = { open: true, mode: "held", holder: null, lost: null, waiting: 0, behindSince: null, lastError: null, lastSent: NOW - 1_000, bytes: 3 * 1024 * 1024, counting: false, takeover: null, refused: [] };

describe("a runtime's store on the Runtime page", () => {
  test("in step with the extension's storage says so, and what its copy takes on the disk", () => {
    expect(storeLines(settled, NOW, "LumiAH")).toEqual([
      { text: "LumiAH's storage holds everything it saved.", tone: "neutral" },
      { text: "Its copy takes 3.0 MB on its disk.", tone: "neutral" },
    ]);
  });

  test("behind, says how many changes wait and why, a takeover that dropped changes, and each refusal for good", () => {
    const lines = storeLines(
      {
        ...settled,
        open: false,
        mode: "opening",
        waiting: 2,
        behindSince: NOW - 120_000,
        lastError: { words: "the extension isn't linked", at: NOW - 60_000 },
        lastSent: NOW - 300_000,
        counting: true,
        takeover: { from: "mara (harbour-box)", at: NOW - 3_600_000, dropped: 3 },
        refused: [{ name: "chats/c1/session.json", doc: true, words: "The extension's storage refused the document chats/c1/session.json for good (too long).", at: NOW - 30_000 }],
      },
      NOW,
      "LumiAH",
    );
    expect(lines.map((line) => line.tone)).toEqual(["warn", "warn", "warn", "neutral", "neg", "neg"]);
    expect(lines[1]?.text).toStartWith("2 changes wait to reach LumiAH's storage");
    expect(lines[2]?.text).toContain("the extension isn't linked");
    expect(lines[3]?.text).toContain("so far (still counting)");
    expect(lines[4]?.text).toContain("the storage kept by mara (harbour-box), threw its own copy away with 3 changes the storage never had");
    expect(lines[5]?.text).toContain("refused the document chats/c1/session.json for good");
  });

  test("without a copy of its own, says it works straight on the storage and why: another runtime keeps it, or took it over and with what", () => {
    const second: StoreStateView = { ...settled, mode: "direct", holder: "mara (harbour-box)", bytes: 0 };
    expect(storeLead(second, "LumiAH")).toBe("What its agents keep (their files, jobs, sessions, transcripts) it reads and saves straight in LumiAH's storage.");
    expect(storeLines(second, NOW, "LumiAH")).toEqual([{ text: "It runs without a copy of its own: mara (harbour-box) keeps LumiAH's storage, and one runtime at a time keeps a copy. It reads and saves straight in the storage, which is slower.", tone: "neutral" }]);

    const lost = storeLines({ ...second, lost: { at: NOW - 180_000, to: "mara (laptop)", dropped: 2 } }, NOW, "LumiAH");
    expect(lost).toEqual([
      { text: "It runs without a copy of its own since 3 min ago: mara (laptop) keeps LumiAH's storage now, and one runtime at a time keeps a copy. It reads and saves straight in the storage, which is slower, until it starts again.", tone: "warn" },
      { text: "2 changes it hadn't sent to the storage went with its copy (its log names each).", tone: "neg" },
    ]);
    expect(storeLines({ ...settled, mode: "waiting", open: false }, NOW, "LumiAH")[0]).toEqual({ text: "It hasn't heard from LumiAH whether it keeps a copy of its own, so it doesn't yet read or save what the agents keep.", tone: "warn" });
    expect(storeLead(null, "LumiAH")).toContain("on its own disk first");
  });

  test("sizes read as a person reads them", () => {
    expect([sizeOf(512), sizeOf(2048), sizeOf(5 * 1024 * 1024), sizeOf(3 * 1024 ** 3)]).toEqual(["512 B", "2.0 KB", "5.0 MB", "3.0 GB"]);
  });
});
