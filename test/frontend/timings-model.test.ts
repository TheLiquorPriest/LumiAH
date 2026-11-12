// Runtime → Timings and Settings → Timeouts, as worked out for the page: the timing log summed up
// per op and road with waiting and working apart, the road line of a runtime, and every wait a user
// can meet gathered from the settings' own form, each with its own controls and its default.

import { describe, expect, test } from "bun:test";
import { defaultSettings, SETTINGS_SCHEMA } from "../../src/core/settings";
import { Timings } from "../../src/link/timings";
import { TRANSPORT_SCHEMA, transportDefaults } from "../../src/link/settings";
import { TIMEOUT_GROUPS, timeoutPlace } from "../../src/shared/timeouts";
import type { JsonObject } from "../../src/shared/ui";
import { formOf } from "../../src/extension/frontend/settings-model";
import { keptWords, opRows, roadLine, sizeWords, slowLine } from "../../src/extension/frontend/timings-model";
import { timeoutSections, timeoutsChanged } from "../../src/extension/frontend/timeouts-model";

const NOW = 1_800_000_000_000;

describe("the timing log on the page", () => {
  test("each op and road is a line: how many, how many not answered, its spread, waiting and working apart, the largest each way", () => {
    const log = new Timings(4);
    log.add({ at: NOW - 9_000, op: "workspace.read", road: "link", sent: 180, got: 2_300, ms: 41_000, workMs: 40, outcome: "timeout" });
    log.add({ at: NOW - 8_000, op: "workspace.read", road: "proxy", sent: 190, got: 2_310, ms: 46, workMs: 31, outcome: "ok" });
    log.add({ at: NOW - 7_000, op: "workspace.read", road: "proxy", sent: 190, got: 2_310, ms: 60, workMs: 30, outcome: "ok" });
    const rows = opRows(log.view(), 5_000);
    expect(rows.map((r) => [r.op, r.road, r.count, r.slow])).toEqual([
      ["workspace.read", "link", "1, 1 not answered", true],
      ["workspace.read", "proxy", "2", false],
    ]);
    expect(rows[1]).toMatchObject({ median: "46 ms", max: "60 ms", working: "30 ms", waiting: "15 ms", largest: "190 B sent, 2.3 KB back" });
    const slowest = log.view().slowest[0];
    if (slowest === undefined) throw new Error("no row");
    expect(slowLine(slowest, NOW)).toBe("workspace.read by the link: 41.0 s (waited 41.0 s, worked 40 ms), given up waiting, 9 s ago.");
    expect(keptWords(log.view(), NOW)).toBe("The latest 3 crossings (it keeps 4), the oldest 9 s ago.");
  });

  test("the log holds a fixed number of rows, the newest over the oldest, and only sizes and times", () => {
    const log = new Timings(2);
    for (let i = 0; i < 5; i++) log.add({ at: NOW + i, op: `op.${i}`, road: "link", sent: i, got: i, ms: i, workMs: null, outcome: "ok" });
    expect(log.all().map((r) => r.op)).toEqual(["op.3", "op.4"]);
    expect(Object.keys(log.all()[0] ?? {}).sort()).toEqual(["at", "got", "ms", "op", "outcome", "road", "sent", "workMs"]);
    expect(sizeWords(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  test("a runtime's row says which road the pages' requests take, and why not the faster one", () => {
    expect(roadLine({ road: "proxy", why: null, at: NOW }).proxy).toBe(true);
    expect(roadLine({ road: "link", why: "It isn't linked now.", at: null })).toEqual({ proxy: false, text: "Pages reach it over the link. It isn't linked now." });
  });
});

describe("Settings → Timeouts", () => {
  const core = JSON.parse(JSON.stringify(defaultSettings())) as JsonObject;
  const transport = transportDefaults();
  const changed = JSON.parse(JSON.stringify(transport)) as JsonObject;
  changed.pages = { ...(transport.pages as JsonObject), askMs: 45_000 };
  const form = formOf({ schema: { type: "object", properties: { core: SETTINGS_SCHEMA, transport: TRANSPORT_SCHEMA } }, defaults: { core, transport }, values: { core, transport: changed } });

  test("every wait the list names is a setting of the schema, in its group, with the same controls as on its own section", () => {
    const sections = timeoutSections(form);
    expect(sections.map((s) => s.group.id)).toEqual(TIMEOUT_GROUPS.map((g) => g.id));
    expect(sections.reduce((n, s) => n + s.nodes.length, 0)).toBe(TIMEOUT_GROUPS.reduce((n, g) => n + g.rows.length, 0));
    for (const { nodes } of sections) for (const node of nodes) expect(node.control.kind).toBe("number");
    const runtime = sections.find((s) => s.group.id === "runtime");
    expect(runtime?.nodes.map((n) => n.label)).toContain("Proxy road wait");
    // Two that would read alike say whose each is.
    const link = sections.find((s) => s.group.id === "link")?.nodes.map((n) => n.label) ?? [];
    expect(link).toContain("Parts kept (Runtime)");
    expect(link).toContain("Parts kept (Link)");
    expect(timeoutsChanged(sections)).toBe(1);
  });

  test("a timeout's words name its setting and this page: in the extension's own Settings, or where an extension that builds LumiAH in says they are shown", () => {
    expect(timeoutPlace(["transport", "pages", "askMs"], "Runtime wait", { name: "LumiAH" })).toBe("Runtime wait (LumiAH's Settings → Timeouts → Waiting for the runtime)");
    expect(timeoutPlace(["transport", "pages", "askMs"], "Runtime wait", { name: "LumiRPEngine", settingsAt: "LumiRPEngine's Harness tab → System → Settings" })).toBe("Runtime wait (LumiRPEngine's Harness tab → System → Settings → Timeouts → Waiting for the runtime)");
  });
});
