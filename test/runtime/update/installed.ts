// A runtime set up on a disk of its own (a temporary folder), as an update finds it: the
// extension's copy of the runtime it was set up from, lumiah's installed copy it runs, its unit when
// it has one, and the machine around it. Programs only record how they were run and answer as a
// test scripts them; leaving only records the successor it would hand the process to.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RUNTIME_DEFAULTS } from "../../../src/link/settings";
import type { RuntimeSetup, SavedConfig } from "../../../src/runtime/config";
import { nodeFiles } from "../../../src/runtime/update/files";
import type { Ran } from "../../../src/runtime/update/programs";
import type { Successor } from "../../../src/runtime/update/restart";
import { unitText } from "../../../src/runtime/update/service";
import type { UpdateDeps, UpdateFiles } from "../../../src/runtime/update/update";

export const BUN = "/opt/bun/bin/bun";
/** What lumiah's installed copy held before the update, and what the extension ships now. */
export const OLD = "// LumiAH's runtime, build 1111aaaa\n";
export const NEW = "// LumiAH's runtime, build 2222bbbb\n";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The offer the extension makes for the build it ships now, from where it is installed. */
export const offerOf = (at: Installed, change: Partial<{ build: string; path: string; sha256: string }> = {}) => ({ build: "2222bbbb", path: at.source, sha256: sha256(NEW), ...change });

export interface Setting {
  /** Which file the runtime runs: lumiah's installed copy (as its unit does), the extension's own file (in the foreground), or another path. */
  runs?: "copy" | "source" | { other: string };
  /** Whether its systemd unit runs it. */
  unit?: boolean;
  autoUpdate?: boolean;
  /** The source its config names; by default the extension's file. Null: a config written before it was kept. */
  source?: string | null;
  platform?: string;
  container?: boolean;
  bun?: string | null;
  /** The disk's calls a test replaces (a crash). */
  files?: Partial<UpdateFiles>;
  /** The extension LumiAH is built into, whose runtime this is; LumiAH's own by default. */
  extension?: { identifier: string; name: string };
}

export interface Installed {
  dir: string;
  /** The extension's copy of the runtime, holding NEW. */
  source: string;
  /** lumiah's installed copy, holding OLD. */
  copy: string;
  unitFile: string;
  configPath: string;
  config: SavedConfig;
  /** Each change saved, in order. */
  saved: Partial<RuntimeSetup>[];
  /** Every program run, as one line, and the environment it was given; but a new build's version, which is in `checked`. */
  ran: string[];
  envs: Readonly<Record<string, string>>[];
  /** Each build checked for whether it starts here, as `<bun> <file>`, and the time it was given to say its version. */
  checked: string[];
  checkWaits: (number | undefined)[];
  /** Runs while a build is checked: what happens on the runtime meanwhile. */
  whileChecked: (() => void) | null;
  /** How a build answers `--version`: a whole one's words unless a test says it can't start. */
  version: Ran;
  /** Another copy of the runtime that waits to serve on its port; none unless a test says so. */
  waiting: { pid: number; since: number } | null;
  /** What a program answers, by the verb it was run with (`restart`, `daemon-reload`); 0 and nothing else unless a test says so. */
  answers: Map<string, Ran>;
  /** Each successor the runtime left for. */
  left: Successor[];
  logs: string[];
  /** Whether a turn or a job is under way. */
  busy: boolean;
  deps: UpdateDeps;
  text(path: string): string | null;
  close(): void;
}

export function installed(setting: Setting = {}): Installed {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lumiah-update-")));
  const ext = setting.extension ?? { identifier: "lumi_ah", name: "LumiAH" };
  const own = ext.identifier === "lumi_ah";
  const name = own ? "mara" : `mara-${ext.identifier}`;
  const source = join(dir, `extensions/${ext.identifier}/dist/lumiah.js`);
  const copy = join(dir, own ? "home/.local/share/lumiah/lumiah.js" : `home/.local/share/lumiah/${ext.identifier}/lumiah.js`);
  const configPath = join(dir, `home/.config/lumiah/${name}.json`);
  const unitFile = join(dir, `home/.config/systemd/user/lumiah-${name}.service`);
  for (const [path, text] of [
    [source, NEW],
    [copy, OLD],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode: 0o644 });
  }
  mkdirSync(dirname(configPath), { recursive: true });
  const service = setting.unit === true ? { manager: "systemd" as const, unit: `lumiah-${name}.service`, file: unitFile, bun: BUN, script: copy } : null;
  if (service !== null) {
    mkdirSync(dirname(unitFile), { recursive: true });
    writeFileSync(unitFile, unitText({ name, bun: BUN, script: copy, config: configPath, memory: "1G" }));
  }
  const runs = setting.runs ?? (setting.unit === true ? "copy" : "source");
  const self = runs === "copy" ? copy : runs === "source" ? source : runs.other;
  const at: Installed = {
    dir,
    source,
    copy,
    unitFile,
    configPath,
    config: {
      name,
      base: "http://127.0.0.1:7860",
      extension: ext.identifier,
      listen: "127.0.0.1",
      port: 7871,
      relay: "relay-1",
      secret: "a".repeat(64),
      session: { username: "mara", token: "session-token-mara", savedAt: 0 },
      tuning: { ...RUNTIME_DEFAULTS },
      memory: "1G",
      autoUpdate: setting.autoUpdate ?? true,
      source: setting.source === undefined ? source : setting.source,
      service,
    },
    saved: [],
    ran: [],
    envs: [],
    checked: [],
    checkWaits: [],
    whileChecked: null,
    version: { code: 0, out: "lumiah 0.0.2 (build 2222bbbb)\n", err: "" },
    waiting: null,
    answers: new Map(),
    left: [],
    logs: [],
    busy: false,
    deps: null as unknown as UpdateDeps,
    text(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
  at.deps = {
    config: () => at.config,
    save(change) {
      at.saved.push(change);
      at.config = { ...at.config, ...change };
    },
    configPath,
    build: "1111aaaa",
    bun: setting.bun === undefined ? BUN : setting.bun,
    self,
    installed: copy,
    service,
    platform: setting.platform ?? "linux",
    container: setting.container ?? false,
    env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    uid: 1000,
    files: { ...nodeFiles, ...setting.files },
    async run(command, args, env, timeoutMs) {
      if (args.at(-1) === "--version") {
        at.checked.push(`${command} ${args.slice(0, -1).join(" ")}`);
        at.checkWaits.push(timeoutMs);
        at.whileChecked?.();
        return at.version;
      }
      at.ran.push([command, ...args].join(" "));
      at.envs.push(env ?? {});
      const verb = args.find((word) => !word.startsWith("--")) ?? "";
      return at.answers.get(verb) ?? { code: 0, out: "", err: "" };
    },
    leave: (next) => void at.left.push(next),
    busy: () => at.busy,
    now: () => 1_700_000_000_000,
    log: (text) => void at.logs.push(text),
    name: () => ext.name,
    owner: () => ({ name: ext.name }),
    // As serve reads it: the user's settings as the config keeps them.
    buildStartMs: () => at.config.tuning.buildStartMs,
    handedOver: false,
    waitingCopy: () => at.waiting,
  };
  return at;
}
