// A runtime's update for a runtime a test runs (`RigOptions.update`), as `lumiah serve` builds one
// (cli.ts): its disk a map of files (the extension's copy of the runtime it was set up from, and
// lumiah's installed copy it runs from), its programs scripted (a build says its version unless a
// test says it can't start), and its leaving recorded rather than done. A test that wants the stop
// that follows a leave ends what the runtime serves itself (`runtime.shutdown()`), as serve does.

import { createHash } from "node:crypto";
import { EXTENSION_IDENTIFIER } from "../../src/link/contract";
import type { RuntimeConfig, RuntimeSetup, SavedConfig } from "../../src/runtime/config";
import type { RuntimeDeps } from "../../src/runtime/runtime";
import type { Successor } from "../../src/runtime/update/restart";
import { createUpdate } from "../../src/runtime/update/update";

/** The extension's own copy of the runtime, where LumiAH's backend is installed on the fake Lumiverse (FakeHost's `install.dir`). */
export const SOURCE = `/srv/lumiverse/extensions/${EXTENSION_IDENTIFIER}/dist/lumiah.js`;
/** lumiah's installed copy, which the runtime runs (`ran.script` in the rig). */
export const COPY = "/home/mara/.local/share/lumiah/lumiah.js";
export const BUN = "/opt/bun/bin/bun";
/** What the installed copy holds, and what the extension ships after its update. */
export const OLD = "// LumiAH's runtime, build test-build\n";
export const NEW = "// LumiAH's runtime, build next-build\n";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface Updating {
  /** What builds the runtime's update: `RigOptions.update`. */
  update: RuntimeDeps["update"];
  /** The disk, by path. */
  files: Map<string, string>;
  /** The successors the runtime left for, in order. */
  left: Successor[];
  /** Every program run, as one line. */
  ran: string[];
  /** The runtime's config as it stands, with what the Runtime page changed. */
  config(): SavedConfig;
  /** Whether a build said its version: false makes every build one that can't start here. */
  starts: boolean;
}

/** A runtime set up from the extension's copy (`source`, the default) or before it could update itself (`source: null`), running lumiah's installed copy, which holds the build before. */
export function updating(config: RuntimeConfig, setting: { source?: string | null; autoUpdate?: boolean } = {}): Updating {
  let current: SavedConfig = { ...config, memory: "1G", autoUpdate: setting.autoUpdate ?? true, source: setting.source === undefined ? SOURCE : setting.source, service: null };
  const made: Updating = {
    files: new Map([
      [COPY, OLD],
      [SOURCE, NEW],
    ]),
    left: [],
    ran: [],
    starts: true,
    config: () => current,
    update: (busy) =>
      createUpdate({
        config: () => current,
        save: (change: Partial<RuntimeSetup>) => {
          current = { ...current, ...change };
        },
        configPath: "/home/mara/.config/lumiah/mara.json",
        build: "test-build",
        bun: BUN,
        self: COPY,
        installed: COPY,
        service: null,
        platform: "linux",
        container: false,
        env: {},
        uid: 1000,
        files: {
          read: (path) => {
            const text = made.files.get(path);
            return text === undefined ? null : new TextEncoder().encode(text);
          },
          write: (path, bytes) => void made.files.set(path, new TextDecoder().decode(bytes)),
          mode: (path) => (made.files.has(path) ? 0o644 : null),
          rename: (from, to) => {
            const text = made.files.get(from);
            if (text === undefined) throw new Error(`no such file: ${from}`);
            made.files.set(to, text);
            made.files.delete(from);
          },
          remove: (path) => void made.files.delete(path),
          real: (path) => path,
        },
        run: async (command, args) => {
          made.ran.push([command, ...args].join(" "));
          if (args.at(-1) === "--version") return made.starts ? { code: 0, out: "lumiah 0.0.2 (build next-build)\n", err: "" } : { code: 1, out: "", err: "SyntaxError: this Bun can't read the new build" };
          return { code: 0, out: "", err: "" };
        },
        leave: (next) => void made.left.push(next),
        busy,
        now: () => Date.now(),
        log: () => undefined,
        name: () => "LumiAH",
        handedOver: false,
        waitingCopy: () => null,
      }),
  };
  return made;
}
