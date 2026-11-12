// The streams the runtime reads from the extension (DESIGN §6, "Patient streams"): a call that runs
// in the extension and brings nothing for Stream stalled after is given up, in words that name the
// setting and where the user changes it, as every wait that runs out does; a call held for the
// user's word is never given up for silence. Time is the test's own clock: the runtime looks at its
// streams on each tick, and the shortest Stream stalled after that Settings take is 10 seconds.

import { describe, expect, test } from "bun:test";
import type { StreamChunk } from "../../src/link/contract";
import { RUNTIME_DEFAULTS } from "../../src/link/settings";
import type { RuntimeLink } from "../../src/runtime/link";
import { Streams } from "../../src/runtime/streams";

describe("a call that runs in the extension", () => {
  test("is given up once nothing came for it for Stream stalled after, in words that name the setting and where it is changed; a call held for the user's word is not", () => {
    const clock = { now: 1_000_000 };
    // The link of a runtime that an extension builds LumiAH into, up: that extension shows LumiAH's Settings in a tab of its own.
    const link = {
      out: null,
      refused: null,
      backendName: "Lamp Room",
      owner: { name: "Lamp Room", settingsAt: "Lamp Room's Harness tab → System → Settings" },
      request: async () => ({}),
    } as unknown as RuntimeLink;
    const streams = new Streams(link, { now: () => clock.now, log: () => undefined, tuning: () => ({ ...RUNTIME_DEFAULTS, stallMs: 10_000 }) });
    const heard = new Map<string, StreamChunk[]>();
    const reader = (id: string) => ({ chunk: (chunk: StreamChunk) => void heard.set(id, [...(heard.get(id) ?? []), chunk]) });
    const tool = "a".repeat(32);
    const held = "b".repeat(32);
    streams.start(tool, reader(tool), async () => ({}));
    streams.start(held, reader(held), async () => ({}), true);

    clock.now += 9_999;
    streams.tick();
    expect(heard.size).toBe(0);
    clock.now += 1;
    streams.tick();
    expect(heard.get(tool)).toEqual([{ kind: "error", code: "stalled", message: "Lamp Room sent nothing for this call in 10 seconds, so the runtime gave it up. Press Retry. Stream stalled after (Lamp Room's Harness tab → System → Settings → Timeouts → The link) says how long the runtime waits for a call that sends nothing." }]);

    // A call held for a person's word: silence is no stall, however long.
    clock.now += 60 * 60_000;
    streams.tick();
    expect(heard.has(held)).toBe(false);
    expect(streams.count).toBe(1);
  });
});
