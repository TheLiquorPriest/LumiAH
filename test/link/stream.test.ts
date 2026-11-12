// The link's own machinery, both ends in one process (DESIGN §6): a stream's one chunk, numbered,
// kept until acknowledged and sent again after a reconnect; a frame too large to cross whole, cut and
// put together again; and the words for a version mismatch.

import { describe, expect, test } from "bun:test";
import { type StreamChunk, FRAME_LIMIT, LINK, versionWords } from "../../src/link/contract";
import { chunkOf, pushOf, requestOf } from "../../src/link/frames";
import { PartJoiner, needsParts, partOf, splitFrame } from "../../src/link/parts";
import { checkTransport, TRANSPORT_DEFAULTS, transportOf } from "../../src/link/settings";
import { StreamSender } from "../../src/link/stream";

const outcome: StreamChunk = { kind: "value", value: { text: "Okoro keeps the light." } };

describe("a stream", () => {
  test("carries one chunk, numbered 1, and takes nothing after it", () => {
    const sender = new StreamSender();
    expect(sender.push(outcome)).toEqual({ seq: 1, chunk: outcome });
    expect(sender.push({ kind: "error", message: "late", code: "internal" })).toBeNull();
  });

  test("keeps its chunk for a runtime that reconnects until the chunk is acknowledged, and is then over", () => {
    const sender = new StreamSender();
    // Asked for before it has its chunk: nothing to send again yet, and nothing to let go.
    expect(sender.from(1)).toEqual([]);
    expect(sender.ack(1)).toBe(false);
    sender.push(outcome);
    // A runtime that held nothing of it when it reconnected is sent it again; one that held it, nothing.
    expect(sender.from(1)).toEqual([{ seq: 1, chunk: outcome }]);
    expect(sender.from(2)).toEqual([]);
    expect(sender.ack(1)).toBe(true);
    expect(sender.from(1)).toEqual([]);
  });
});

describe("a frame too large for Lumiverse's socket", () => {
  test("crosses in parts and is the same frame once put together, in whatever order they arrive", () => {
    // Text of three bytes a character: past the limit long before its length says so.
    const frame = JSON.stringify({ link: LINK, type: "result", id: "r1", body: { text: "灯".repeat(1_600_000) } });
    expect(needsParts(frame)).toBe(true);
    expect(needsParts(JSON.stringify({ link: LINK, type: "result", id: "r2", body: { text: "a short one" } }))).toBe(false);
    const parts = splitFrame(frame, "r1");
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(new TextEncoder().encode(JSON.stringify(part)).length).toBeLessThan(FRAME_LIMIT);

    const joiner = new PartJoiner(() => ({ maxUnits: 32 * 1024 * 1024, staleMs: 60_000 }));
    let whole: string | null = null;
    for (const part of [...parts].reverse()) {
      const read = partOf(JSON.parse(JSON.stringify(part)));
      if (read === null) throw new Error("a part didn't read as one");
      const joined = joiner.take(read, 0);
      if ("text" in joined) whole = joined.text;
    }
    expect(whole).toBe(frame);
    expect(joiner.waiting).toBe(0);
  });

  test("is refused past the most the receiver puts together, and half a frame is let go when the rest never comes", () => {
    const parts = splitFrame("x".repeat(3 * 1024 * 1024), "big");
    const small = new PartJoiner(() => ({ maxUnits: 1024 * 1024, staleMs: 1_000 }));
    const first = parts[0];
    if (first === undefined) throw new Error("no parts");
    expect(small.take(first, 0)).toMatchObject({ id: "big", refused: expect.stringContaining("the most LumiAH's link puts together") });

    const patient = new PartJoiner(() => ({ maxUnits: 32 * 1024 * 1024, staleMs: 1_000 }));
    expect(patient.take(first, 0)).toEqual({ waiting: true });
    expect(patient.waiting).toBe(1);
    // Another frame's part, long after: the stale half is gone.
    const other = splitFrame("y".repeat(2 * 1024 * 1024), "other")[0];
    if (other === undefined) throw new Error("no parts");
    patient.take(other, 5_000);
    expect(patient.waiting).toBe(1);
  });
});

describe("what crosses the link", () => {
  test("is read only when it is the link's, and a request only when the contract has it", () => {
    expect(requestOf({ lah: 1, type: "lah.hello", reqId: "r1" })).toBeNull();
    expect(requestOf({ link: LINK, type: "ping", id: "7", secret: "s" })).toMatchObject({ request: { type: "ping", id: "7" } });
    expect(requestOf({ link: LINK, type: "launch", id: "8" })).toMatchObject({ id: "8", malformed: expect.stringContaining("There is no link request launch") });
    expect(pushOf({ link: LINK, type: "chunk", stream: "s", seq: 0, chunk: outcome })).toBeNull();
    expect(pushOf({ link: LINK, type: "stop", turn: "t1", why: "You stopped the reply in Lumiverse." })).toMatchObject({ type: "stop", turn: "t1" });
    expect(chunkOf({ kind: "error", message: "The tool failed." })).toBeNull();
    // What a model's answer crossed as before its calls left the link is no chunk now.
    expect(chunkOf({ kind: "content", text: "Okoro" })).toBeNull();
  });

  test("a version mismatch is said in words that name which side to update", () => {
    expect(versionWords(1, 2)).toBe("This runtime speaks link version 1 and LumiAH 2: update the runtime by running its start line on LumiAH's Runtime page again.");
    expect(versionWords(3, 2)).toBe("This runtime speaks link version 3 and LumiAH 2: update LumiAH in Lumiverse (Extensions → LumiAH → Update), then restart the runtime.");
  });
});

describe("the transport's settings", () => {
  test("refuse a value out of range or of the wrong kind, and name it", () => {
    expect(checkTransport({ history: { keep: "last", count: 12 } })).toEqual([]);
    expect(checkTransport({ history: { count: 0 } })).toEqual([{ path: ["history", "count"], message: "Latest messages kept must be from 1 to 10000 messages." }]);
    expect(checkTransport({ history: { keep: "some" } })[0]?.message).toBe("Keep must be one of: last, all.");
    expect(checkTransport({ streams: { speed: 1 } })[0]?.message).toBe("There is no setting streams.speed.");
    expect(checkTransport({ connections: { oneToolAtATime: ["conn-a", "conn-a"] } })[0]?.path).toEqual(["connections", "oneToolAtATime", 1]);
  });

  test("read as the defaults under what the user set, a refused value left out", () => {
    const read = transportOf({ history: { keep: "all", count: 0 }, runtime: { stallMs: 60_000 } });
    expect(read.history).toEqual({ keep: "all", count: TRANSPORT_DEFAULTS.history.count });
    expect(read.runtime.stallMs).toBe(60_000);
    expect(read.runtime.lostMs).toBe(TRANSPORT_DEFAULTS.runtime.lostMs);
    expect(read.tags).toEqual(TRANSPORT_DEFAULTS.tags);
  });
});
