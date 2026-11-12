// What the Runtime page says of how one runtime is run and kept: its update (waiting, and why;
// taken; or the line to run, with the reason, where the runtime can't take the extension's offer),
// what the Update now button ended, its memory limit and what holds it there, and a copy of it that
// waits beside it.

import { describe, expect, test } from "bun:test";
import type { RelayView, ServiceView } from "../../src/shared/ui";
import { copyWords, cutWords, memoryWords, underWayWords, updateStanding } from "../../src/extension/frontend/runtime-service-model";

const RELAY: RelayView = { id: "relay-1", name: "mara", build: "1f0a6c33", host: "harbour", url: "http://127.0.0.1:7871/v1", registeredAt: 0, seenAt: 0, link: "linked", problem: null, update: true, turns: 0, unit: "lumiah-mara.service", session: { valid: true, endsAt: null }, scheduler: "excluded", lines: { update: "bun lumiah.js up --name mara --systemd", login: null } };
const SERVICE: ServiceView = { build: "1f0a6c33", memory: "1G", memoryNote: null, autoUpdate: true, runs: "systemd", unit: "lumiah-mara.service", source: "/srv/lumiverse/extensions/lumi_ah/dist/lumiah.js", installed: "/home/mara/.local/share/lumiah/lumiah.js", waiting: null, busy: false, restartNeeded: false, updating: false, problem: null, line: null, handedOver: false, waitingCopy: null, underWay: { replies: 0, requests: 0, jobs: 0, sides: 0 } };
const EXT = { build: "2a7d9e11", selfUpdate: true, name: "LumiAH" };

describe("a runtime's update on the page", () => {
  test("waits for what is under way, or for the button where it doesn't update by itself, and says which", () => {
    const busy = { ...SERVICE, waiting: { build: "2a7d9e11", since: 0 }, busy: true, underWay: { replies: 1, requests: 1, jobs: 2, sides: 0 } };
    expect(updateStanding(RELAY, busy, EXT)).toEqual({ at: "waiting", build: "2a7d9e11", why: "It waits for what is under way to end (1 reply and 2 jobs), then updates by itself.", ends: "1 reply and 2 jobs" });
    expect(updateStanding(RELAY, { ...busy, autoUpdate: false }, EXT)).toMatchObject({ at: "waiting", why: "Updates are taken from this button only (it doesn't update by itself)." });
    expect(updateStanding(RELAY, { ...SERVICE, updating: true }, EXT)).toEqual({ at: "updating" });
    expect(updateStanding({ ...RELAY, update: false }, SERVICE, EXT)).toEqual({ at: "current" });
  });

  test("keeps the update line, with the reason, where a linked runtime can't take the extension's offer", () => {
    expect(updateStanding(RELAY, { ...SERVICE, problem: "LumiAH offers the runtime at /srv/a, and this runtime was set up from /srv/b." }, EXT)).toEqual({ at: "line", why: "LumiAH offers the runtime at /srv/a, and this runtime was set up from /srv/b." });
    expect(updateStanding(RELAY, { ...SERVICE, source: null }, EXT)).toMatchObject({ at: "line", why: expect.stringContaining("set up before it could update itself") });
    expect(updateStanding(RELAY, SERVICE, { ...EXT, selfUpdate: false })).toMatchObject({ at: "line", why: expect.stringContaining("offers runtimes no update of their own") });
    // Asked how it is kept, it gave no answer: an older build can't say, and can't take the offer either.
    expect(updateStanding(RELAY, null, EXT, "This runtime's build can't do that yet: update the runtime with its update line on the Runtime page.")).toEqual({ at: "line", why: "It didn't say how its update stands (This runtime's build can't do that yet: update the runtime with its update line on the Runtime page.), so it may be a build that can't take LumiAH's by itself: run this on the machine it runs on." });
  });

  test("each state of a runtime's row has its own words: a linked runtime is never said not to be", () => {
    const words = (relay: RelayView, service: ServiceView | null, unread: string | null = null): string => {
      const standing = updateStanding(relay, service, EXT, unread);
      return standing.at === "line" || standing.at === "waiting" ? `${standing.at}: ${standing.why}` : standing.at;
    };
    // Linked, on the extension's build.
    expect(words({ ...RELAY, update: false }, SERVICE)).toBe("current");
    // Linked, an update waiting.
    expect(words(RELAY, { ...SERVICE, waiting: { build: "2a7d9e11", since: 0 } })).toBe("waiting: It updates by itself in a moment.");
    // Linked, still being asked how it stands: nothing is said of it yet.
    expect(words(RELAY, null)).toBe("asking");
    // Linked, but unable to take the offer, with the reason.
    expect(words(RELAY, { ...SERVICE, source: null })).toBe("line: It was set up before it could update itself: run this once on the machine it runs on, and from then on it updates by itself.");
    expect(words(RELAY, null, "The runtime didn't answer within 30 seconds.")).toStartWith("line: It didn't say how its update stands (The runtime didn't answer within 30 seconds.)");
    // Not linked: only then is it said not to be.
    for (const link of ["quiet", "refused", "down"] as const) expect(words({ ...RELAY, link }, null)).toBe("line: It isn't linked, so LumiAH can't offer it the update: run this on the machine it runs on.");
    for (const service of [null, SERVICE]) for (const unread of [null, "anything"]) expect(words(RELAY, service, unread)).not.toContain("isn't linked");
  });

  test("says what the button ended, and what becomes of it", () => {
    expect(cutWords({ replies: 1, requests: 1, jobs: 1, sides: 0 }, "2a7d9e11")).toBe("Updating to build 2a7d9e11: the runtime restarts now. It ended 1 reply and 1 job: a reply it ended keeps what it had written, and Retry writes it again; a job it ended shows as interrupted on Jobs, where it can be started again.");
    expect(cutWords({ replies: 0, requests: 0, jobs: 0, sides: 0 }, "2a7d9e11")).toBe("Updating to build 2a7d9e11: the runtime restarts now, and nothing was under way.");
    expect(underWayWords({ replies: 0, requests: 2, jobs: 0, sides: 1 })).toBe("2 requests from Lumiverse and 1 side session's answer");
  });
});

describe("a runtime's memory and copies on the page", () => {
  test("says what holds it to its limit, or the runtime's own words that nothing does", () => {
    expect(memoryWords(SERVICE)).toBe("Its systemd service lumiah-mara.service holds it to this limit (MemoryMax): past it, systemd stops the runtime and starts it again.");
    expect(memoryWords({ ...SERVICE, runs: "itself", unit: null, memoryNote: "Nothing holds the runtime to this limit on macOS." })).toBe("Nothing holds the runtime to this limit on macOS.");
  });

  test("says when it was started by the one before it, and when another copy waits to serve on its port", () => {
    expect(copyWords(SERVICE, 0)).toEqual([]);
    const words = copyWords({ ...SERVICE, handedOver: true, waitingCopy: { pid: 4312, since: 0 } }, 3 * 60_000);
    expect(words[0]).toContain("restarted by starting a new copy of itself");
    expect(words[1]).toContain("Another copy of it (process 4312) has waited 3 minute(s)");
  });
});
