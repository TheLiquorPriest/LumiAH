// A runtime that updates itself from the extension it links to, and the settings of how it is run
// that the Runtime page changes (PI-BUILD-PLAN §4.8).
//
// When the runtime says hello on another build, the extension offers its own copy of the runtime:
// `{ build, path, sha256 }`. The runtime takes it only from the file it was set up from (`source`,
// which `up` records) and only when that file's sha256 is the one offered. It then writes those
// very bytes over its installed copy (to a temporary file beside it first, renamed over it, so the
// copy is whole whichever way it goes) and restarts onto it: through systemd where its unit runs
// it, else by handing its process to its successor (restart.ts). A runtime that runs straight from
// the extension's file has nothing to copy: its restart is the update. It updates by itself when
// its user lets it (`autoUpdate`) and nothing is under way, and at once from the page's button.
//
// What it reads, writes, runs and restarts comes from its config and from what it knows of itself,
// never from the offer or the page: an offer only names a build and what its file must hash to, and
// a page only sets the memory limit (one systemd reads, and not under the floor) and whether the
// runtime updates by itself.

import { createHash } from "node:crypto";
import { EXTENSION_IDENTIFIER, shellWord } from "../../link/contract";
import { isRecord } from "../../link/json";
import { OpRefused } from "../../link/work";
import type { RuntimeSetup, SavedConfig, SystemdService } from "../config";
import { memoryRefusal } from "./memory";
import type { Successor } from "./restart";
import { systemctlOf, unitText } from "./service";

/** An update the extension offers: its build, where its copy of the runtime is, and that file's sha256 (hex). */
export interface UpdateOffer {
  build: string;
  path: string;
  sha256: string;
}

/** The disk as an update needs it; `nodeFiles` is the machine's. */
export interface UpdateFiles {
  /** The file's bytes; null when there is none. */
  read(path: string): Uint8Array | null;
  /** Writes the file whole with `mode` and flushes it to the disk; a crash part way leaves it part written. */
  write(path: string, bytes: Uint8Array, mode: number): void;
  /** The file's permission bits; null where it has none to give (Windows, or no such file). */
  mode(path: string): number | null;
  /** Puts `from` in place of `to` in one step (rename(2)): `to` is then the old file or the new one, whole, never a mix. */
  rename(from: string, to: string): void;
  remove(path: string): void;
  /** The path with every symlink in it resolved; throws when there is no such file. */
  real(path: string): string;
}

export interface UpdateDeps {
  /**
   * The runtime's config as it stands. `save` keeps a change of it through the runtime's one
   * writer of the file (serve's `keep`), so nothing that writer saves later undoes the change.
   */
  config(): SavedConfig;
  save(change: Partial<RuntimeSetup>): void;
  /** Where that config is: the successor serves from it, and a unit's ExecStart names it. */
  configPath: string;
  /** This process's build, the Bun running it (null where it can't say), and the file it runs from. */
  build: string;
  bun: string | null;
  self: string;
  /** The copy of the runtime lumiah installs for this runtime's extension (`installedPath`): with a unit's file, the only file an update or a setting writes. */
  installed: string;
  /** The unit that runs this process (`unitRunning`); null when none does. */
  service: SystemdService | null;
  platform: string;
  /** Whether it runs in a container, where the container's own limit holds its memory. */
  container: boolean;
  env: Readonly<Record<string, string | undefined>>;
  uid: number | null;
  files: UpdateFiles;
  /** Runs a program (systemctl) and waits for it to end. */
  run(command: string, args: readonly string[], env?: Readonly<Record<string, string>>): Promise<{ code: number; out: string; err: string }>;
  /** Ends what the runtime serves as a stop does, then hands its process to its successor (`handOver`). */
  leave(next: Successor): void;
  /** Whether a turn or a job is under way. */
  busy(): boolean;
  now(): number;
  log(text: string): void;
  /** The extension's name as words say it: LumiAH, or the extension LumiAH is built into. */
  name(): string;
}

/** What became of an offer: the runtime runs that build already, it waits to take it, it is taking it now; or why it won't. */
export type OfferOutcome = { taken: "current" | "waiting" | "updating" } | { refused: string };

/** How the runtime is run and kept, as the Runtime page shows it. */
export interface UpdateView {
  /** The build this runtime runs. */
  build: string;
  /** Its memory limit; and where nothing holds it to that limit, words that say so and what would. */
  memory: string;
  memoryNote: string | null;
  autoUpdate: boolean;
  /** What restarts it: its systemd unit, which `unit` names, or the runtime itself. */
  runs: "systemd" | "itself";
  unit: string | null;
  /** The file it was set up from, the only one it takes an update from; and the file it runs from. */
  source: string | null;
  installed: string;
  /** The update that waits, for nothing to be under way or for the button, and since when. */
  waiting: { build: string; since: number } | null;
  /** A turn or a job is under way: updating now ends it. */
  busy: boolean;
  /** A setting changed since the runtime started holds only once it restarts. */
  restartNeeded: boolean;
  /** It is updating or restarting now. */
  updating: boolean;
  /** Why the last update or change didn't take; and the line to run where the runtime can't do it itself. */
  problem: string | null;
  line: string | null;
}

/** What a change of the settings did: it holds already, it holds once the runtime restarts, or the runtime is restarting for it. */
export interface SetOutcome {
  view: UpdateView;
  restart: "none" | "needed" | "restarting";
}

export interface Update {
  /** An offer from the extension (the link's push), checked; taken at once when the runtime may, else kept until it may. */
  offer(raw: unknown): Promise<OfferOutcome>;
  /** Every second: an update that waited is taken once updates may be taken by themselves and nothing is under way. Resolves once what it began has settled. */
  tick(): Promise<void>;
  /** The page's button: the update that waits, taken now, whatever is under way. */
  applyNow(): Promise<UpdateView>;
  get(): UpdateView;
  /** The page's settings: `{ memory?, autoUpdate?, restart? }`. */
  set(raw: unknown): Promise<SetOutcome>;
}

/** A build's id as the build script makes one: a commit's short SHA, perhaps marked dirty with a time, or a time. */
const BUILD_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** Longer than any path a system takes: an offer naming a longer one is no offer. */
const PATH_MAX = 4096;

function offerOf(raw: unknown): UpdateOffer | null {
  if (!isRecord(raw)) return null;
  const { build, path, sha256 } = raw;
  if (typeof build !== "string" || !BUILD_ID.test(build) || typeof path !== "string" || path === "" || path.length > PATH_MAX || typeof sha256 !== "string" || !SHA256.test(sha256)) return null;
  return { build, path, sha256 };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createUpdate(deps: UpdateDeps): Update {
  // The build this process runs, by what its file held as it started: an offer of that build is no update, whatever the offer calls it.
  let running: string | null = null;
  try {
    const bytes = deps.files.read(deps.self);
    if (bytes !== null) running = createHash("sha256").update(bytes).digest("hex");
  } catch {
    // Unreadable, it matches no offer: each offer is then checked and taken on its own.
  }
  // The limit its unit started it under: a change of it holds once the runtime restarts.
  const started = deps.config().memory;
  let waiting: (UpdateOffer & { since: number }) | null = null;
  let updating = false;
  let problem: string | null = null;
  let line: string | null = null;

  /** A path as its system compares paths: Windows ignores case and takes either slash. */
  const written = (path: string): string => (deps.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path);

  /** Whether two paths the runtime knows of itself are one file: as written, else by their real paths. */
  function same(a: string, b: string): boolean {
    if (written(a) === written(b)) return true;
    try {
      return deps.files.real(a) === deps.files.real(b);
    } catch {
      return false;
    }
  }

  function fail(words: string, run: string | null = null): { refused: string } {
    problem = words;
    line = run;
    deps.log(run === null ? words : `${words} ${run}`);
    return { refused: words };
  }

  function clear(): void {
    problem = null;
    line = null;
  }

  /** The line that sets the runtime up again from the extension's file, as the Runtime page's update line does. */
  function upLine(config: SavedConfig, systemd: boolean): string {
    return [deps.bun ?? "bun", config.source ?? deps.self, "up", "--name", config.name, ...(config.extension === EXTENSION_IDENTIFIER ? [] : ["--extension", config.extension]), ...(systemd ? ["--systemd"] : [])].map(shellWord).join(" ");
  }

  /** The offered build's bytes, read from the file the runtime was set up from and checked against the offer; else why they can't be taken. */
  function verified(o: UpdateOffer, config: SavedConfig): Uint8Array | { why: string } {
    const name = deps.name();
    const again = `run the update line on ${name}'s Runtime page`;
    const source = config.source;
    if (source === null) return { why: `This runtime was set up before it could update itself. Run the update line on ${name}'s Runtime page once; from then on it updates by itself.` };
    if (written(o.path) !== written(source)) return { why: `${name} offers the runtime at ${o.path}, and this runtime was set up from ${source}. Run the update line on ${name}'s Runtime page once: from then on it updates from there.` };
    if (!same(deps.self, source) && !same(deps.self, deps.installed)) return { why: `This runtime runs from ${deps.self}, a file it doesn't update: it updates only its own installed copy (${deps.installed}), and nothing when it runs from ${source} itself. Copy ${source} over ${deps.self} and restart the runtime, or ${again}.` };
    let bytes: Uint8Array | null;
    try {
      bytes = deps.files.read(source);
    } catch (error) {
      return { why: `The runtime at ${source} can't be read (${message(error)}): ${again}.` };
    }
    if (bytes === null) return { why: `There is no runtime at ${source}, where this runtime was set up from. Check that ${name} is still installed in Lumiverse, then ${again}.` };
    if (createHash("sha256").update(bytes).digest("hex") !== o.sha256) return { why: `The runtime at ${source} isn't the build ${name} offers (${o.build}). When ${name} has just been updated, it offers again once Lumiverse has loaded its new build; otherwise ${again}.` };
    return bytes;
  }

  /** Puts `bytes` in place of the file at `target`: written whole beside it, then renamed over it, so `target` is never part written. */
  function replace(target: string, bytes: Uint8Array, name: string): void {
    // One temporary name per runtime: what a crash left is written over on the next try, and two runtimes that share a copy never write the same one.
    const temp = `${target}.${name}.tmp`;
    const mode = deps.files.mode(target) ?? 0o644;
    try {
      deps.files.write(temp, bytes, mode);
      deps.files.rename(temp, target);
    } catch (error) {
      try {
        deps.files.remove(temp);
      } catch {
        // The error worth telling is the first one.
      }
      throw error;
    }
  }

  /** Restarts the runtime onto what is in place now (`done` says what that is); null once it is on its way, else why it can't, with the line that does it. */
  async function restart(done: string): Promise<{ refused: string } | null> {
    const service = deps.service;
    if (service !== null) {
      const ctl = systemctlOf(deps.env, deps.uid);
      // Queued, not waited for: the restart is a job of the account's service manager, which stops this process as it stops any and then starts it again.
      const queued = await deps.run("systemctl", [...ctl.args, "restart", "--no-block", service.unit], ctl.env);
      if (queued.code !== 0) return fail(`${done}, but systemd didn't restart the runtime (${(queued.err || queued.out).trim() || `exit code ${queued.code}`}). Restart it with:`, `systemctl --user restart ${service.unit}`);
      deps.log(`${done}: restarting through ${service.unit}`);
      return null;
    }
    if (deps.bun === null) return fail(`${done}, but the runtime can't restart itself here. Stop it, then start it again with:`, ["bun", deps.self, "serve", "--config", deps.configPath].map(shellWord).join(" "));
    deps.log(`${done}: restarting`);
    deps.leave({ command: deps.bun, args: [deps.self, "serve", "--config", deps.configPath] });
    return null;
  }

  /** Takes the update that waits; null once the runtime is restarting onto it, else why it didn't. */
  async function apply(): Promise<{ refused: string } | null> {
    const o = waiting;
    if (o === null || updating) return null;
    updating = true;
    try {
      const config = deps.config();
      const bytes = verified(o, config);
      if (!(bytes instanceof Uint8Array)) {
        waiting = null;
        updating = false;
        return fail(bytes.why);
      }
      const source = config.source ?? deps.self;
      if (!same(deps.self, source)) {
        try {
          replace(deps.installed, bytes, config.name);
        } catch (error) {
          // Not tried again by itself: the extension offers again when the runtime next says hello.
          waiting = null;
          updating = false;
          const copy = `${deps.platform === "win32" ? "Copy-Item" : "cp"} ${shellWord(source)} ${shellWord(deps.installed)}`;
          return fail(`Couldn't put build ${o.build} in place of ${deps.installed} (${message(error)}). Copy it yourself, then restart the runtime:`, deps.service !== null ? `${copy} && systemctl --user restart ${deps.service.unit}` : copy);
        }
      }
      waiting = null;
      clear();
      const refused = await restart(`Build ${o.build} is in place`);
      if (refused !== null) updating = false;
      return refused;
    } catch (error) {
      updating = false;
      return fail(`The update to build ${o.build} stopped part way: ${message(error)}`);
    }
  }

  /** Words for where nothing holds the runtime to its limit, and what would; null where its unit does. */
  function memoryNote(config: SavedConfig): string | null {
    if (deps.service !== null) return null;
    if (deps.container) return "Nothing in the runtime holds it to this limit: in a container, the container's own memory limit does (mem_limit in its compose service).";
    if (deps.platform === "linux") return `Nothing holds the runtime to this limit now: only its systemd service does, and it runs without one. To make it one, stop it and run: ${upLine(config, true)}`;
    const system = deps.platform === "darwin" ? "macOS" : deps.platform === "win32" ? "Windows" : "this system";
    return `Nothing holds the runtime to this limit on ${system}: only a systemd service applies it, on Linux. The limit is kept for when the runtime runs as one.`;
  }

  /** Writes the unit again with the limit and has systemd read it; false, with words that say what to run, when either fails. */
  async function rewriteUnit(service: SystemdService, memory: string): Promise<boolean> {
    const config = deps.config();
    try {
      replace(service.file, new TextEncoder().encode(unitText({ name: config.name, bun: service.bun, script: service.script, config: deps.configPath, memory })), config.name);
    } catch (error) {
      fail(`The limit is saved, but the runtime's unit couldn't be written (${message(error)}). Write it again from the saved limit with:`, upLine(config, true));
      return false;
    }
    const ctl = systemctlOf(deps.env, deps.uid);
    const reload = await deps.run("systemctl", [...ctl.args, "daemon-reload"], ctl.env);
    if (reload.code !== 0) {
      fail(`The limit is in the unit, but systemd didn't read the unit again (${(reload.err || reload.out).trim() || `exit code ${reload.code}`}). Have it read it with:`, "systemctl --user daemon-reload");
      return false;
    }
    clear();
    return true;
  }

  function get(): UpdateView {
    const config = deps.config();
    return {
      build: deps.build,
      memory: config.memory,
      memoryNote: memoryNote(config),
      autoUpdate: config.autoUpdate,
      runs: deps.service !== null ? "systemd" : "itself",
      unit: deps.service?.unit ?? null,
      source: config.source,
      installed: deps.self,
      waiting: waiting === null ? null : { build: waiting.build, since: waiting.since },
      busy: deps.busy(),
      restartNeeded: deps.service !== null && config.memory !== started,
      updating,
      problem,
      line,
    };
  }

  return {
    async offer(raw) {
      const name = deps.name();
      const o = offerOf(raw);
      if (o === null) {
        waiting = null;
        return fail(`${name} offered an update this runtime can't read: run the update line on ${name}'s Runtime page.`);
      }
      if (updating) return { taken: "updating" };
      if (o.sha256 === running) {
        waiting = null;
        clear();
        return { taken: "current" };
      }
      const checked = verified(o, deps.config());
      if (!(checked instanceof Uint8Array)) {
        waiting = null;
        return fail(checked.why);
      }
      waiting = { ...o, since: deps.now() };
      clear();
      const { autoUpdate } = deps.config();
      if (!autoUpdate || deps.busy()) {
        deps.log(`build ${o.build} waits: ${autoUpdate ? "a reply or a job is under way" : "updates are taken from the Runtime page"}`);
        return { taken: "waiting" };
      }
      return (await apply()) ?? { taken: "updating" };
    },

    async tick() {
      if (waiting === null || updating || !deps.config().autoUpdate || deps.busy()) return;
      await apply();
    },

    async applyNow() {
      if (updating) throw new OpRefused("unavailable", "The runtime is updating already: it is back in a moment.");
      if (waiting === null) throw new OpRefused("unavailable", problem ?? `There is no update to take: this runtime is on the build ${deps.name()} offered, or ${deps.name()} hasn't offered one since it started.`);
      const refused = await apply();
      if (refused !== null) throw new OpRefused("unavailable", refused.refused);
      return get();
    },

    get,

    async set(raw) {
      if (!isRecord(raw)) throw new OpRefused("bad_request", "Say what to change: memory, autoUpdate, restart.");
      const { memory, autoUpdate, restart: asked } = raw;
      if (memory !== undefined) {
        if (typeof memory !== "string") throw new OpRefused("bad_request", "The memory limit is a size, such as 768M or 2G.");
        const why = memoryRefusal(memory);
        if (why !== null) throw new OpRefused("bad_request", `The memory limit "${memory}" can't be used: ${why}.`);
      }
      if (autoUpdate !== undefined && typeof autoUpdate !== "boolean") throw new OpRefused("bad_request", "autoUpdate is true (updates are taken by themselves) or false (only from the button).");
      if (asked !== undefined && typeof asked !== "boolean") throw new OpRefused("bad_request", "restart is true or false.");
      const before = deps.config();
      const change: Partial<RuntimeSetup> = {
        ...(memory !== undefined && memory !== before.memory ? { memory } : {}),
        ...(autoUpdate !== undefined && autoUpdate !== before.autoUpdate ? { autoUpdate } : {}),
      };
      if (Object.keys(change).length > 0) deps.save(change);
      const service = deps.service;
      const inUnit = change.memory === undefined || service === null || (await rewriteUnit(service, change.memory));
      const needed = service !== null && deps.config().memory !== started;
      if (asked === true && needed && inUnit && !updating) {
        updating = true;
        if ((await restart(`The memory limit ${deps.config().memory} is in the unit`)) !== null) updating = false;
      }
      return { view: get(), restart: updating ? "restarting" : needed ? "needed" : "none" };
    },
  };
}
