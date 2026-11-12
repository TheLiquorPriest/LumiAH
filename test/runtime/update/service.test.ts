// Which unit runs the runtime, as the runtime tells for itself: the one `up --systemd` installed,
// only when this process runs the file that unit runs. A terminal that runs as a user service hands
// systemd's mark on to the commands typed in it, so the mark alone makes no unit; a config written
// before units were recorded still finds the unit `up --systemd` names.

import { describe, expect, test } from "bun:test";
import { RUNTIME_DEFAULTS } from "../../../src/link/settings";
import type { SavedConfig } from "../../../src/runtime/config";
import { installedCopy, type ThisProcess, unitRunning } from "../../../src/runtime/update/service";

const HOME = "/home/mara";
const BUN = "/opt/bun/bin/bun";
const COPY = `${HOME}/.local/share/lumiah/lumiah.js`;
const SOURCE = "/srv/lumiverse/extensions/lumi_ah/dist/lumiah.js";
const UNIT = { manager: "systemd" as const, unit: "lumiah-mara.service", file: `${HOME}/.config/systemd/user/lumiah-mara.service`, bun: BUN, script: COPY };

const config = (change: Partial<SavedConfig> = {}): SavedConfig => ({
  name: "mara",
  base: "http://127.0.0.1:7860",
  extension: "lumi_ah",
  listen: "127.0.0.1",
  port: 7871,
  relay: "relay-1",
  secret: "a".repeat(64),
  session: { username: "mara", token: "session-token-mara", savedAt: 0 },
  tuning: { ...RUNTIME_DEFAULTS },
  memory: "1G",
  autoUpdate: true,
  source: SOURCE,
  service: UNIT,
  ...change,
});

/** This process: started by systemd when `marked`, running `self`; `links` are the symlinks on its disk. */
const me = (self: string, marked: boolean, env: Record<string, string> = {}, links: Record<string, string> = {}): ThisProcess => ({ env: { ...env, ...(marked ? { INVOCATION_ID: "0f1e2d3c" } : {}) }, home: HOME, bun: BUN, self, real: (path) => links[path] ?? path });

describe("the unit that runs the runtime", () => {
  test("is the one its config records, when systemd started this process and it runs that unit's file, under any name for it", () => {
    expect(unitRunning(config(), me(COPY, true))).toEqual(UNIT);
    expect(unitRunning(config(), me("/home/mara/.lumiah-copy.js", true, {}, { "/home/mara/.lumiah-copy.js": COPY }))).toEqual(UNIT);
  });

  test("is none for a process systemd didn't start, or one started from a terminal that is a service itself, running another file", () => {
    expect(unitRunning(config(), me(COPY, false))).toBeNull();
    expect(unitRunning(config(), me(SOURCE, true))).toBeNull();
    expect(unitRunning(config({ service: null }), me(SOURCE, true))).toBeNull();
  });

  test("is, for a config written before units were recorded, the one `up --systemd` names for the runtime, running the copy it installs", () => {
    expect(unitRunning(config({ service: null }), me(COPY, true))).toEqual(UNIT);
    const data = "/data/mara";
    expect(unitRunning(config({ service: null, name: "mara-other_ext", extension: "other_ext" }), me(`${data}/lumiah/other_ext/lumiah.js`, true, { XDG_DATA_HOME: data, XDG_CONFIG_HOME: "/conf/mara" }))).toEqual({ manager: "systemd", unit: "lumiah-mara-other_ext.service", file: "/conf/mara/systemd/user/lumiah-mara-other_ext.service", bun: BUN, script: `${data}/lumiah/other_ext/lumiah.js` });
  });

  test("leads to lumiah's copy an update replaces: the one the unit runs, though the unit's environment names another data folder; else the one `up --systemd` installs", () => {
    expect(installedCopy(config(), { env: { XDG_DATA_HOME: "/data/mara" }, home: HOME })).toBe(COPY);
    expect(installedCopy(config({ service: null }), { env: {}, home: HOME })).toBe(COPY);
    expect(installedCopy(config({ service: null, extension: "other_ext" }), { env: { XDG_DATA_HOME: "/data/mara" }, home: HOME })).toBe("/data/mara/lumiah/other_ext/lumiah.js");
  });
});
