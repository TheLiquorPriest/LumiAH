// The timing log's part of the stand-in backend: what Runtime → Timings is told (`lah.timings.get`),
// and the road the preview's pages take to its runtime. The preview's runtime is on this machine and
// the extension holds `cors_proxy` once it is set up, so the asks go by the proxy; a few of them
// went over the link while the road was checked, and the runtime's own requests (its files, a
// reply's record) went over the link as they always do.

import { Timings } from "../../../src/link/timings";
import type { RelayView, RoadsView } from "../../../src/shared/ui";
import type { Handlers } from "./ctx";

type Requests = "lah.timings.get";

/** What granting the permission does, as the real backend says it while it isn't granted. */
const OFFER = `Granting LumiAH the permission "cors_proxy" (Extensions → LumiAH → Permissions; only an owner or an admin can) lets its pages, and the tools of an extension that builds it in, reach a runtime on this machine through Lumiverse's own proxy, so a request doesn't wait behind a reply's or a job's traffic on the link. Without it everything still works over the link.`;

/** The road to the preview's runtimes: by the proxy once set up (`granted`), else over the link with what granting the permission does. */
export function previewRoad(granted: boolean, relays: readonly RelayView[], now: number): RoadsView {
  const out: RoadsView["relays"] = {};
  for (const r of relays) out[r.id] = r.link !== "linked" ? { road: "link", why: "It isn't linked now.", at: null } : granted ? { road: "proxy", why: null, at: now - 5 * 60_000 } : { road: "link", why: `LumiAH doesn't hold the permission "cors_proxy".`, at: null };
  return { granted, offer: granted ? null : OFFER, relays: out };
}

/** A log as an end keeps one, filled with crossings `at` before `now`: each [op, road, ms, worked ms, sent, got, outcome]. */
function logOf(now: number, rows: readonly [string, "link" | "proxy", number, number | null, number, number, "ok" | "refused" | "timeout" | "failed"][]): Timings {
  const log = new Timings();
  rows.forEach(([op, road, ms, workMs, sent, got, outcome], i) => log.add({ at: now - (rows.length - i) * 7_000, op, road, sent, got, ms, workMs, outcome }));
  return log;
}

export function timingsMock(now: () => number, relays: () => readonly RelayView[]): Handlers<Requests> {
  return {
    "lah.timings.get": () => {
      const at = now();
      const extension = logOf(at, [
        ["workspace.read", "link", 41_200, 38, 182, 2_310, "timeout"],
        ["workspace.read", "proxy", 46, 31, 190, 2_310, "ok"],
        ["workspace.list", "proxy", 58, 40, 120, 18_400, "ok"],
        ["jobs.list", "proxy", 71, 52, 96, 41_000, "ok"],
        ["workspace.write", "proxy", 88, 61, 4_120, 640, "ok"],
        ["workspace.read", "proxy", 39, 27, 190, 2_310, "ok"],
        ["connections.test", "proxy", 1_840, 1_812, 80, 210, "ok"],
        ["workspace.write", "proxy", 92, 70, 3_980, 120, "refused"],
        ["jobs.list", "proxy", 64, 49, 96, 41_000, "ok"],
      ]);
      const runtime = logOf(at, [
        ["blob.put", "link", 2_430, 410, 3_400_000, 90, "ok"],
        ["doc.put", "link", 310, 22, 12_000, 70, "ok"],
        ["trace.push", "link", 180, 3, 48_000, 60, "ok"],
        ["chat.path", "link", 920, 640, 140, 220_000, "ok"],
        ["doc.put", "link", 260, 20, 9_800, 70, "ok"],
        ["turn.commit", "link", 140, 35, 6_200, 60, "ok"],
      ]);
      return { extension: extension.view(), runtimes: relays().filter((r) => r.link === "linked").map((r) => ({ id: r.id, name: r.name, timings: runtime.view(), problem: null })) };
    },
  };
}
