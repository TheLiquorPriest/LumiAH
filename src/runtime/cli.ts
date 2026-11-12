// The `lumiah` command (DESIGN §1: the runtime runs beside Lumiverse): the runtime's one-line start,
// its service and its upkeep.
//
//   up      signs in (or reuses the runtime's saved sign-in), registers the runtime with LumiAH (or
//           keeps the registration of the runtime it sets up again), puts its address in the
//           account's scheduler exclusions, writes its config, makes the loopback connection when
//           the user has none, and serves; with --systemd it installs a stable copy of itself and a
//           user unit that runs it instead, restarted once the replies under way have ended. It
//           keeps the memory limit the runtime had (--memory changes it), records the file it was
//           run from (the only one the runtime later updates itself from) and the unit it installed
//   serve   what the unit runs: the runtime from its config, until stopped
//   login   a new session for the runtime when its own ended (the Runtime page says so)
//   status  the runtime's config, unit, link and session
//   down    stops and removes the unit
//
// It runs only from files no other account can change (Bun, this bundle, and every directory above
// them): whoever else could change one would choose the code it runs as this account. Otherwise it
// refuses, and says what to do. It needs Bun: the server is Bun.serve with `idleTimeout: 0`, and the
// unit runs the same Bun by its absolute path. Everything it does to the machine goes through
// RuntimeIO, which main.ts supplies, so the tests run every command against a fake machine.

import type { HarnessHost, JsonObject } from "../core/ports";
import type { LinkedBackend, LinkRequests } from "../link/contract";
import { EXTENSION_IDENTIFIER, RUNTIME_NAME, loopbackModel, runtimeBase, shellWord, unitName } from "../link/contract";
import { linkedBackendOf } from "../link/frames";
import { isRecord } from "../link/json";
import { RUNTIME_DEFAULTS } from "../link/settings";
import type { RuntimeConfig, SavedConfig, SystemdService } from "./config";
import { EXTENSION_FORM, RUNTIME_DIR_MODE, SETUP_DEFAULTS, configDir, configOf, configPathOf, configText, dataDir, installedPath, runtimeDir } from "./config";
import type { OpenSocket } from "./connection";
import { HostConnection, LinkError } from "./connection";
import type { Http, StoredLogin } from "./lumiverse";
import { addConnectionProfile, connectionProfiles, editAndSendPrefersActive, excludeOrigins, inClear, LiveError, loopbackProfile, normalizeBase, runtimeOrigins, sessionOf, signIn } from "./lumiverse";
import { createModelLayer } from "./models";
import { healthProof } from "./proof";
import { createRuntime } from "./runtime";
import type { Harness } from "./turn";
import { DEFAULT_MEMORY, memoryRefusal } from "./update/memory";
import type { Ran } from "./update/programs";
import { HANDED_OVER, type Successor } from "./update/restart";
import { installedCopy, systemctlOf, unitMemory, unitPath, unitRunning, unitText } from "./update/service";
import type { UpdateFiles } from "./update/update";
import { createUpdate } from "./update/update";

export interface ServeOptions {
  hostname: string;
  port: number;
  fetch(req: Request): Promise<Response>;
}

/** A running server. */
export interface Served {
  stop(): void;
}

/** An entry's owner, group and mode. */
export interface OwnedEntry {
  uid: number;
  gid: number;
  mode: number;
}

/** The disk as the command needs it; main.ts supplies Node's. */
export interface RuntimeFiles {
  /** The file's text, or null when there is none. */
  read(path: string): string | null;
  /** Writes it whole and renames it into place with `mode`, making its directory with `dirMode` when missing. */
  write(path: string, text: string, mode: number, dirMode: number): void;
  copy(from: string, to: string, mode: number): void;
  exists(path: string): boolean;
  /** A directory's file names; empty when there is none. */
  list(dir: string): string[];
  remove(path: string): void;
  /** Its owner, group and mode, symlinks followed; null where the system has none (Windows). */
  stat(path: string): OwnedEntry | null;
  /** The path with every symlink in it resolved. */
  real(path: string): string;
  /** Makes the folder, and those above it that are missing, and gives it `mode` (mkdir's is masked by the umask, and a folder there already keeps its own); the path the folder is at. */
  folder(path: string, mode: number): string;
}

/** The machine as the command needs it. */
export interface RuntimeIO {
  out(text: string): void;
  err(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  /** A question on the terminal; `hidden` echoes nothing. Null when there is no terminal to ask on. */
  ask(question: string, hidden: boolean): Promise<string | null>;
  http: Http;
  openSocket: OpenSocket;
  /** Bun.serve with `idleTimeout: 0`; null where there is no Bun. It throws when the port is taken. */
  serve: ((options: ServeOptions) => Served) | null;
  /** Resolves with the signal's name when the process is asked to stop. */
  stopped(): Promise<string>;
  /** The absolute path of the Bun running this, or null under another runtime. */
  bun: string | null;
  /** This bundle's own path (…/dist/lumiah.js): `up --systemd` copies it. */
  self: string;
  /** The process's uid; null on Windows. */
  uid: number | null;
  hostname: string;
  platform: string;
  home: string;
  files: RuntimeFiles;
  /** Runs a program (systemctl, loginctl, id, getent; Bun, for a new build's version) with `env` over this process's environment: one named without a path is found in the system's own folders, never through PATH. Ended after `timeoutMs` when that is given. */
  run(command: string, args: readonly string[], env?: Readonly<Record<string, string>>, timeoutMs?: number): Promise<Ran>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** The identifier of the extension a new runtime links to unless `--extension` names another: LumiAH's own. */
  extension: string;
  /** This build's id and the package's version. */
  build: string;
  version: string;
  /** The core's harness over a host, and where the core's settings name the writer's connection. */
  harness: Parameters<typeof createRuntime>[1]["harness"];
  writerConnection(values: JsonObject): string | null;
  /** The disk as an update needs it: the bytes of the extension's copy of the runtime, and lumiah's copy and unit written whole. */
  updateFiles: UpdateFiles;
  /** Hands this process to the runtime's successor once it has stopped serving (`handOver`): resolves only where that failed, by throwing words with the line that starts it. */
  handOver(next: Successor): Promise<void>;
  /** This process's id: a copy that waits for another to stop serving says which process it is. */
  pid: number;
}

interface Args {
  positionals: string[];
  values: Record<string, string>;
  flags: Record<string, true>;
}

const FLAGS: Readonly<Record<string, true>> = { "--systemd": true, "--allow-http": true, "--help": true, "--version": true };

/** The first and last port `up` tries when none is given: a small range beside Lumiverse's own 7860. `--port` names any other, so these are the default and not a limit. */
const DEFAULT_PORT = 7871;
const LAST_PORT = 7899;
const LISTEN = "127.0.0.1";
/** A directory's sticky bit: no one but an entry's owner, the directory's or root may rename or remove the entry (/tmp). */
const STICKY = 0o1000;
/** Write bits for the entry's group, and for everyone else. */
const GROUP_WRITE = 0o020;
const OTHERS_WRITE = 0o002;

export const USAGE = `lumiah: LumiAH's runtime, which answers Lumiverse's loopback connection.

  lumiah up --url <address> [--port <n>] [--name <name>] [--systemd]
                        Sign in, register with LumiAH, and serve on 127.0.0.1. --systemd installs it as
                        a service of your account instead, so it survives logout and reboot.
                        More: --listen <host>, --username <name>, --allow-http, --memory <size> (the
                        service's memory cap: ${DEFAULT_MEMORY} until you give one, then kept), --bun
                        <path>, --extension <identifier> (the extension LumiAH is built into, when it
                        isn't LumiAH's own: that runtime gets a name, a config, a service and a
                        connection of its own)
  lumiah serve --config <file> | --name <name>
                        Run the runtime from its config (what the service runs)
  lumiah login | status | down [--name <name>]
                        Sign the runtime in again; how it is; stop and remove its service
  lumiah --version
`;

class UsageError extends Error {}

function parse(argv: readonly string[]): Args {
  const args: Args = { positionals: [], values: {}, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? "";
    if (!word.startsWith("--")) {
      args.positionals.push(word);
      continue;
    }
    const eq = word.indexOf("=");
    const name = eq < 0 ? word : word.slice(0, eq);
    if (Object.hasOwn(FLAGS, name)) {
      args.flags[name] = true;
      continue;
    }
    const value = eq < 0 ? argv[++i] : word.slice(eq + 1);
    if (value === undefined) throw new UsageError(`${name} needs a value.\n\n${USAGE}`);
    args.values[name] = value;
  }
  return args;
}

function only(a: Args, sub: string, options: readonly string[], flags: readonly string[]): void {
  const stray = [...Object.keys(a.values).filter((o) => !options.includes(o)), ...Object.keys(a.flags).filter((f) => !flags.includes(f) && f !== "--help")];
  if (stray.length > 0) throw new UsageError(`lumiah ${sub} doesn't take ${stray.join(", ")}.\n\n${USAGE}`);
  if (a.positionals.length > 1) throw new UsageError(`lumiah ${sub} takes no argument (${a.positionals.slice(1).join(" ")}).\n\n${USAGE}`);
}

/** Runs `lumiah <argv>`; resolves with the exit code. */
export async function lumiah(argv: readonly string[], io: RuntimeIO): Promise<number> {
  try {
    const a = parse(argv);
    const sub = a.positionals[0];
    if (a.flags["--version"] === true) {
      io.out(`lumiah ${io.version} (build ${io.build})`);
      return 0;
    }
    if (sub === undefined || a.flags["--help"] === true) {
      io.out(USAGE);
      return sub === undefined && a.flags["--help"] !== true ? 2 : 0;
    }
    // Before anything it would do: it runs only what no other account can change.
    const refused = sub === "up" || sub === "serve" || sub === "login" || sub === "status" || sub === "down" ? await refusal(a, io) : null;
    if (refused !== null) throw new Error(refused);
    switch (sub) {
      case "up":
        only(a, "up", ["--url", "--port", "--listen", "--name", "--username", "--memory", "--bun", "--extension"], ["--systemd", "--allow-http"]);
        return await up(a, io);
      case "serve": {
        only(a, "serve", ["--config", "--name"], []);
        const path = configPath(a, io);
        return await serve(configOf(io.files.read(path), path), path, io);
      }
      case "login":
        only(a, "login", ["--config", "--name", "--username"], []);
        return await login(a, io);
      case "status":
        only(a, "status", ["--config", "--name"], []);
        return await status(a, io);
      case "down":
        only(a, "down", ["--name"], []);
        return await down(a, io);
      default:
        throw new UsageError(`There is no lumiah ${sub}: up, serve, login, status or down.\n\n${USAGE}`);
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError ? 2 : 1;
  }
}

// ---------------------------------------------------------------- where things go

/** Where a runtime's files go by its name: its config and its unit. Both the account's own (the XDG directories). */
interface Place {
  config: string;
  unit: string;
  unitName: string;
}

function placeOf(name: string, io: RuntimeIO): Place {
  const name_ = unitName(name);
  return { config: configPathOf(configDir(io.env, io.home), name), unit: unitPath(io.env, io.home, name_), unitName: name_ };
}

// ---------------------------------------------------------------- whose files it runs

/** A group's name, and the accounts in it (its listed members and every account whose primary group it is); null when they can't all be named. */
type GroupOf = (gid: number) => Promise<{ name: string; uids: number[] | null }>;

/** The groups `getent` names, each asked once. Where there is no getent (macOS), or a member it can't name, the group's accounts are unknown, so its write counts as another account's. */
function groupsOf(io: RuntimeIO): GroupOf {
  const asked = new Map<number, Promise<{ name: string; uids: number[] | null }>>();
  const ask = async (gid: number): Promise<{ name: string; uids: number[] | null }> => {
    const group = await io.run("getent", ["group", String(gid)]);
    const [name = "", , id, listed = ""] = (group.out.split("\n")[0] ?? "").trim().split(":");
    if (group.code !== 0 || name === "" || id !== String(gid)) return { name: String(gid), uids: null };
    const passwd = await io.run("getent", ["passwd"]);
    if (passwd.code !== 0) return { name, uids: null };
    const accounts = passwd.out.split("\n").flatMap((line) => {
      const [account = "", , uid = "", primary = ""] = line.trim().split(":");
      return account !== "" && /^\d+$/.test(uid) ? [{ account, uid: Number(uid), primary }] : [];
    });
    const uids = accounts.filter((x) => x.primary === String(gid)).map((x) => x.uid);
    for (const member of listed.split(",").filter((m) => m !== "")) {
      const found = accounts.find((x) => x.account === member);
      if (found === undefined) return { name, uids: null };
      uids.push(found.uid);
    }
    return { name, uids };
  };
  return (gid) => {
    let answer = asked.get(gid);
    if (answer === undefined) asked.set(gid, (answer = ask(gid)));
    return answer;
  };
}

/** No account but its owner is in its group: Lumiverse makes its directories under a umask of 0002, group-writable, in its account's own group. */
async function ownersGroup(entry: OwnedEntry, groupOf: GroupOf): Promise<boolean> {
  const { uids } = await groupOf(entry.gid);
  return uids !== null && uids.length > 0 && uids.every((u) => u === entry.uid);
}

/** Only `uid` or root can change it: one of theirs, writable by no one else, its group's write counting for nothing in its owner's own group. */
async function onlyTheirs(entry: OwnedEntry, uid: number, groupOf: GroupOf): Promise<boolean> {
  if ((entry.uid !== uid && entry.uid !== 0) || (entry.mode & OTHERS_WRITE) !== 0) return false;
  return (entry.mode & GROUP_WRITE) === 0 || (await ownersGroup(entry, groupOf));
}

/**
 * The entries, from the file at `path` (its symlinks resolved) up through every directory above it,
 * that someone other than `uid` or root can change: each of `uid`'s or root's its group or everyone
 * else can write, then the first of another account's, where it stops. A directory with its sticky
 * bit (/tmp), `uid`'s or root's, lets no one else rename or remove an entry of `uid`'s or root's in
 * it, so what is below it stays as safe as that entry.
 */
async function changeable(io: RuntimeIO, path: string, uid: number, groupOf: GroupOf): Promise<{ path: string; entry: OwnedEntry }[]> {
  const found: { path: string; entry: OwnedEntry }[] = [];
  let below: OwnedEntry | null = null;
  for (let at = io.files.real(path); ; at = at.slice(0, at.lastIndexOf("/")) || "/") {
    const entry = io.files.stat(at);
    const sticky = entry !== null && below !== null && (entry.mode & STICKY) !== 0 && (entry.uid === uid || entry.uid === 0) && (below.uid === uid || below.uid === 0);
    if (entry !== null && !sticky && !(await onlyTheirs(entry, uid, groupOf))) {
      found.push({ path: at, entry });
      if (entry.uid !== uid && entry.uid !== 0) return found;
    }
    if (at === "/") return found;
    below = entry;
  }
}

/** The folder the command's config is in (`--config`'s, else where configs live), or the nearest folder above it that is there yet: `up` makes the rest, as this account's own. */
function configFolder(a: Args, io: RuntimeIO): string {
  const given = a.values["--config"];
  let at = given === undefined ? configDir(io.env, io.home) : given.includes("/") ? given.slice(0, given.lastIndexOf("/")) || "/" : ".";
  for (;;) {
    try {
      io.files.real(at);
      return at;
    } catch {
      if (at === "/" || !at.includes("/")) return at;
      at = at.slice(0, at.lastIndexOf("/")) || "/";
    }
  }
}

/**
 * Why this account won't run this, or null when it may: this bundle, the Bun it runs on and the one
 * `--bun` names for its unit must be no one else's to change but root's, as must every directory
 * above them, or whoever else can change one would run code as this account through it. So must the
 * folder its config is in: the config names the files the runtime runs and updates from, and holds
 * its secret and its session. The refusal names each; for one of this account's or root's that its
 * group or everyone else can write, the `chmod` that takes that write away, and for one of another
 * account's, how to run the runtime as that account.
 */
async function refusal(a: Args, io: RuntimeIO): Promise<string | null> {
  const me = io.uid;
  if (me === null) return null;
  const groupOf = groupsOf(io);
  const unsafe: { path: string; uid: number | null; why: string | null; entry?: OwnedEntry }[] = [];
  for (const path of new Set([io.self, io.bun, a.values["--bun"], configFolder(a, io)])) {
    if (path === null || path === undefined) continue;
    let found: { path: string; entry: OwnedEntry }[];
    try {
      found = await changeable(io, path, me, groupOf);
    } catch (error) {
      unsafe.push({ path, uid: null, why: `can't be checked (${error instanceof Error ? error.message : String(error)})` });
      continue;
    }
    for (const f of found) if (!unsafe.some((u) => u.path === f.path)) unsafe.push({ path: f.path, uid: f.entry.uid, why: null, entry: f.entry });
  }
  if (unsafe.length === 0) return null;
  const names = new Map<number, string>();
  for (const { uid } of unsafe) if (uid !== null && uid !== 0 && uid !== me && !names.has(uid)) names.set(uid, (await io.run("id", ["-nu", String(uid)])).out.trim() || String(uid));
  // Of this account's or root's, who can write it: its group (unless no one but its owner is in it), everyone else, or both; and the chmod that stops them.
  const shared = new Map<string, { why: string; chmod: string }>();
  for (const { path, uid, entry } of unsafe) {
    if (entry === undefined || (uid !== me && uid !== 0)) continue;
    const group = (entry.mode & GROUP_WRITE) !== 0 && !(await ownersGroup(entry, groupOf)) ? (await groupOf(entry.gid)).name : null;
    const others = (entry.mode & OTHERS_WRITE) !== 0;
    const why = group !== null ? `its group, ${group}, ${others ? "and everyone else " : ""}can change it` : "everyone else can change it";
    shared.set(path, { why, chmod: `  ${uid === 0 && me !== 0 ? "sudo " : ""}chmod ${group !== null ? "g" : ""}${others ? "o" : ""}-w ${shellWord(path)}` });
  }
  const who = me === 0 ? "root" : (await io.run("id", ["-nu"])).out.trim() || String(me);
  const listed = unsafe.map(({ path, uid, why }) => `  ${path}: ${why ?? shared.get(path)?.why ?? `${names.get(uid ?? -1) ?? uid} can change it`}`);
  const chmods = unsafe.flatMap((u) => shared.get(u.path)?.chmod ?? []);
  const head = `Refusing to run as ${who}: another account can change these, and would then run code as ${who} through this command.`;
  // Only that write stands in the way: the chmods, then the same line again.
  if (unsafe.every((u) => shared.has(u.path))) return [head, ...listed, "Take that write away, then run it again:", ...chmods].join("\n");
  const account = names.values().next().value ?? null;
  const as = account !== null ? shellWord(account) : "<the account Lumiverse runs as>";
  return [head, ...listed, ...(chmods.length > 0 ? ["First take away the write that isn't its owner's:", ...chmods] : []), `Run the runtime as ${as} instead, the account its files belong to:`, `  sudo -u ${as} <the same line>`].join("\n");
}

// ---------------------------------------------------------------- the config

/** The runtime's name from a username: lowercase letters, digits, `_` and `-`. */
function nameFrom(username: string): string {
  const name = username.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, 40);
  return RUNTIME_NAME.test(name) ? name : "runtime";
}

/**
 * A runtime's default name: its account's, and for an extension other than LumiAH's own the
 * extension's identifier after it. So the runtime of an extension that has LumiAH built in never
 * shares a config, a unit or a registration's name with LumiAH's own on the same machine. The
 * identifier is kept whole, and as much of the account's name as a runtime's name has room for
 * (`RUNTIME_NAME`: 40 characters).
 */
function nameFor(username: string, extension: string): string {
  const account = nameFrom(username);
  if (extension === EXTENSION_IDENTIFIER) return account;
  const tail = `-${extension}`;
  return `${account.slice(0, Math.max(1, 40 - tail.length))}${tail}`.slice(0, 40);
}

function givenName(a: Args): string | undefined {
  const name = a.values["--name"];
  if (name !== undefined && !RUNTIME_NAME.test(name)) throw new UsageError(`--name is "${name}": use lowercase letters, digits, _ and -, up to 40.`);
  return name;
}

/** The names of the runtimes set up here. */
function configured(io: RuntimeIO): string[] {
  return io.files
    .list(configDir(io.env, io.home))
    .filter((f) => f.endsWith(".json") && RUNTIME_NAME.test(f.slice(0, -5)))
    .map((f) => f.slice(0, -5))
    .sort();
}

/** A runtime's config by its name; null when there is none here that this build reads. */
function configNamed(name: string, io: RuntimeIO): SavedConfig | null {
  try {
    const path = configPathOf(configDir(io.env, io.home), name);
    return configOf(io.files.read(path), path);
  } catch {
    return null;
  }
}

/** The one runtime set up here for an extension; null when there is none, or several. */
function onlyOf(extension: string, io: RuntimeIO): SavedConfig | null {
  const found = configured(io).flatMap((name) => {
    const config = configNamed(name, io);
    return config !== null && config.extension === extension ? [config] : [];
  });
  return found.length === 1 && found[0] !== undefined ? found[0] : null;
}

/**
 * A name is one runtime's: its config, its unit and its registration go by it. Setting a runtime up
 * under the name of one that links to another extension would take all three from that one, so it
 * is refused, with what to do instead.
 */
function refuseAnothers(previous: RuntimeConfig | null, extension: string, io: RuntimeIO): void {
  if (previous === null || previous.extension === extension) return;
  throw new Error(`There is a runtime "${previous.name}" here already, and it links to the extension ${previous.extension}: this line would make it ${extension}'s instead. Give this one a name of its own with --name, or remove that one first (lumiah down --name ${previous.name}, then delete ${placeOf(previous.name, io).config}).`);
}

/** `--config`, else the config of `--name`, else the only runtime configured here. */
function configPath(a: Args, io: RuntimeIO): string {
  const given = a.values["--config"];
  if (given !== undefined) return given;
  const dir = configDir(io.env, io.home);
  const name = givenName(a);
  if (name !== undefined) return configPathOf(dir, name);
  const found = configured(io);
  if (found.length === 1 && found[0] !== undefined) return configPathOf(dir, found[0]);
  throw new UsageError(found.length === 0 ? `No runtime is set up here (${dir}). Start one with: lumiah up --url <the address you open Lumiverse at>` : `Several runtimes are set up here (${found.join(", ")}): pick one with --name.`);
}

function writeConfig(path: string, config: SavedConfig, io: RuntimeIO): void {
  io.files.write(path, configText(config), 0o600, 0o700);
}

// ---------------------------------------------------------------- sign-in

/** A new session: the password from LUMIVERSE_PASSWORD or a hidden prompt, never kept. */
async function signInFor(base: string, io: RuntimeIO, username: string | undefined, allowHttp: boolean): Promise<StoredLogin> {
  const clear = inClear(base);
  if (clear && !allowHttp) throw new UsageError(`${base} is plain http to another machine: the password, and the runtime's session on every call after, would cross the network in clear. Use Lumiverse's https address, or accept that with --allow-http.`);
  // Asked as nobody first: a redirect, an untrusted host or a lockout stops here, before a password is sent.
  await sessionOf(io.http, base, null);
  const user = username ?? io.env.LUMIVERSE_USERNAME ?? (await io.ask("Lumiverse username for the runtime: ", false));
  if (user === null || user.trim() === "") throw new UsageError("The runtime needs your Lumiverse username: --username <name>, or LUMIVERSE_USERNAME.");
  const password = io.env.LUMIVERSE_PASSWORD ?? (await io.ask(`Password for ${user.trim()} at ${base}: `, true));
  if (password === null || password === "") throw new UsageError("No password: run this in a terminal and type it at the prompt, or set LUMIVERSE_PASSWORD.");
  const token = await signIn(io.http, base, user.trim(), password);
  return { username: user.trim(), token, savedAt: io.now(), ...(clear ? { allowHttp: true as const } : {}) };
}

/** The sign-in the runtime set up here before still holds, else a new one. */
async function sessionFor(base: string, a: Args, io: RuntimeIO, previous: RuntimeConfig | null): Promise<StoredLogin> {
  const asked = a.values["--username"];
  const saved = previous !== null && previous.base === base ? previous.session : null;
  if (saved !== null && (asked === undefined || asked === saved.username)) {
    const state = await sessionOf(io.http, base, saved.token).catch(() => null);
    if (state?.valid === true) {
      io.out(`Using the runtime's saved sign-in to ${base} as ${saved.username}.`);
      return saved;
    }
  }
  return signInFor(base, io, asked ?? saved?.username, a.flags["--allow-http"] === true || saved?.allowHttp === true);
}

// ---------------------------------------------------------------- up

/** Whether the port is free to serve on, by serving on it for a moment. */
function portFree(io: RuntimeIO, listen: string, port: number): boolean {
  const serve = io.serve;
  if (serve === null) return false;
  try {
    serve({ hostname: listen, port, fetch: async () => new Response(null, { status: 503 }) }).stop();
    return true;
  } catch {
    return false;
  }
}

/**
 * The port a runtime serves on: the one asked for, the one it had, else the first free one. A port
 * another runtime set up here holds is that one's though nothing serves on it now (a runtime that
 * is stopped), so the pick passes over it, and asking for it on the same address is refused.
 */
function portOf(a: Args, io: RuntimeIO, listen: string, previous: RuntimeConfig | null, name: string): number {
  const others = configured(io).flatMap((other) => (other === name ? [] : (configNamed(other, io) ?? [])));
  const given = a.values["--port"];
  if (given !== undefined) {
    const port = Number(given);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`--port is "${given}": give a port number.`);
    const holder = others.find((other) => other.port === port && other.listen === listen);
    if (holder !== undefined) throw new Error(`Port ${port} on ${listen} is the runtime "${holder.name}"'s, set up here too. Pick another with --port.`);
    // The runtime already set up there holds it: `up` restarts that one.
    if (previous?.port !== port && !portFree(io, listen, port)) throw new Error(`Port ${port} on ${listen} is taken. Pick another with --port.`);
    return port;
  }
  if (previous !== null && previous.listen === listen) return previous.port;
  for (let port = DEFAULT_PORT; port <= LAST_PORT; port++) if (!others.some((other) => other.port === port) && portFree(io, listen, port)) return port;
  throw new Error(`No port from ${DEFAULT_PORT} to ${LAST_PORT} is free on ${listen}: pick one with --port.`);
}

/** In a container (the official compose runs Lumiverse in one), where systemd isn't and 127.0.0.1 is the container's own. */
function inContainer(io: RuntimeIO): boolean {
  return io.files.exists("/.dockerenv") || io.files.exists("/run/.containerenv");
}

function containerGuide(bun: string, self: string, config: string, base: string, extension: string): string {
  return [
    "Lumiverse runs in a container here: there is no systemd, and Lumiverse's 127.0.0.1 is the container's own.",
    "Run the runtime inside Lumiverse's container, as a second process:",
    `  ${bun} ${self} up --url ${base}${extension === EXTENSION_IDENTIFIER ? "" : ` --extension ${extension}`}`,
    "or as a compose service that shares Lumiverse's network (127.0.0.1 is then the same for both):",
    "  lumiah:",
    "    image: <Lumiverse's image>",
    '    network_mode: "service:lumiverse"',
    "    volumes: [<Lumiverse's data volume, mounted where it is in Lumiverse's service>]",
    `    command: ["${bun}", "${self}", "serve", "--config", "${config}"]`,
    "    restart: always",
    "    mem_limit: 1g",
    `(run \`up\` once inside the container first, so ${config} exists).`,
  ].join("\n");
}

async function must(io: RuntimeIO, command: string, args: readonly string[], env?: Readonly<Record<string, string>>): Promise<string> {
  const r = await io.run(command, args, env);
  if (r.code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${r.code}): ${(r.err || r.out).trim()}`);
  return r.out.trim();
}

/** The address `up` reaches Lumiverse at: `--url`, LUMIVERSE_URL, the one the runtime it sets up again was set up with, else asked for. */
async function baseFor(a: Args, io: RuntimeIO, before: RuntimeConfig | null): Promise<string> {
  const given = a.values["--url"] ?? io.env.LUMIVERSE_URL;
  if (given !== undefined) return normalizeBase(given);
  if (before !== null) return before.base;
  const asked = await io.ask("Lumiverse address (as you open it in a browser): ", false);
  if (asked === null || asked.trim() === "") throw new UsageError("lumiah up needs Lumiverse's address: --url <address>, or LUMIVERSE_URL.");
  return normalizeBase(asked);
}

async function up(a: Args, io: RuntimeIO): Promise<number> {
  if (io.serve === null || io.bun === null) throw new UsageError("LumiAH's runtime runs on Bun (Bun.serve, idleTimeout 0): run this line with Bun, as LumiAH's Runtime page shows it.");
  const systemd = a.flags["--systemd"] === true;
  const asked = a.values["--extension"];
  if (asked !== undefined && !EXTENSION_FORM.test(asked)) throw new UsageError(`--extension is "${asked}": an extension's identifier is lowercase letters, digits and _.`);
  const named = givenName(a);
  // The runtime this line sets up again, as far as it says before anyone has signed in: the one it names, else the only one here of the extension it is for. That one's address and sign-in are this line's defaults.
  const before = named !== undefined ? configNamed(named, io) : onlyOf(asked ?? io.extension, io);
  // The extension it links to: the one named, else the one it linked to before, else LumiAH's own.
  const extension = asked ?? before?.extension ?? io.extension;
  if (named !== undefined) refuseAnothers(before, extension, io);
  const base = await baseFor(a, io, before);
  const listen = a.values["--listen"] ?? LISTEN;
  if (listen !== LISTEN && listen !== "localhost") io.err(`Warning: the runtime will listen on ${listen}, where other machines can reach it, not only this one. Your loopback key and every prompt cross to it in clear http, so keep it behind something that encrypts (a tunnel, a reverse proxy with HTTPS) or on a private network. Every call still needs the key and must be addressed to ${listen} itself, unless that is a wildcard address (0.0.0.0, ::), which answers any name; nothing else stands between them and it.`);
  const given = a.values["--bun"] ?? io.bun;
  if (!given.startsWith("/")) throw new UsageError(`--bun must be an absolute path (systemd searches no PATH that has Bun): ${given}`);
  // What the unit runs is the very file the check above passed: a link in the path could be pointed elsewhere later.
  let bun: string;
  try {
    bun = io.files.real(given);
  } catch (error) {
    throw new UsageError(`--bun names no Bun here (${given}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const memoryAsked = a.values["--memory"];
  const memoryWhy = memoryAsked === undefined ? null : memoryRefusal(memoryAsked);
  if (memoryWhy !== null) throw new UsageError(`--memory is "${memoryAsked}": ${memoryWhy}.`);
  if (systemd && io.platform !== "linux") throw new Error(`--systemd installs a systemd service, and this is ${io.platform}. Leave out --systemd: the runtime then runs in the foreground, and ${io.platform === "darwin" ? "launchd" : io.platform === "win32" ? "Task Scheduler" : "your system's service manager"} keeps it running (LumiAH's docs/RUNTIME.md, "Keep it running", has the steps).`);
  if (systemd && io.uid === 0) throw new Error("--systemd installs a service of your own account, and root's account has none on most systems. Run the runtime as the account Lumiverse runs as (sudo -u <account> …): it needs no more rights than that.");
  if (systemd && inContainer(io)) throw new Error(containerGuide(bun, io.self, placeOf(named ?? "runtime", io).config, base, extension));
  if (systemd && /\.ts$/.test(io.self)) throw new Error(`The service runs a built runtime, and this runs from source (${io.self}). Build first (bun run build), then run dist/lumiah.js.`);

  const session = await sessionFor(base, a, io, before);
  const name = named ?? nameFor(session.username, extension);
  const place = placeOf(name, io);
  // A runtime set up here before under this name keeps its port and the limits it last read.
  const previous = configNamed(name, io);
  refuseAnothers(previous, extension, io);
  const port = portOf(a, io, listen, previous, name);

  // The limits it last read here, else the defaults: its own settings aren't read until it has linked.
  const tuning = previous?.tuning ?? { ...RUNTIME_DEFAULTS };
  // The secret of the runtime set up here before, for this Lumiverse, extension and account. Shown with the registration, it stands while it is still the extension's: registering anew would replace it at once, and with it end the link of the runtime that is running with it and the replies it is writing. That runtime answers on with it until it is restarted below.
  const held = previous !== null && previous.base === base && previous.extension === extension && previous.session.username === session.username ? previous.secret : undefined;
  // Where there is none to show (the address or the account changed), registering replaces whatever this name holds there, which may be the secret of a runtime that is running now: that one first gets the time to finish its replies.
  if (held === undefined && previous !== null) await drain(previous, io, "registering it anew");
  const conn = new HostConnection({ base, identifier: extension, credentials: () => session, http: io.http, openSocket: io.openSocket, limits: () => tuning, now: io.now });
  let registered: LinkRequests["register"]["result"];
  try {
    await conn.ensureOpen();
    registered = await conn.request("register", { name, build: io.build, host: io.hostname, listen, port, ...(held !== undefined ? { secret: held } : {}) });
  } catch (error) {
    // Before it has registered, the runtime knows the extension only by the identifier it was given.
    const whom = extension === EXTENSION_IDENTIFIER ? "LumiAH" : `The extension "${extension}"`;
    if (error instanceof LinkError) throw new Error(`${whom} didn't register the runtime: ${error.message}`);
    if (error instanceof LiveError && error.problem === "timeout") throw new Error(`${whom} on ${base} didn't answer the runtime's registration. Check that it's running in Lumiverse's Extensions tab.`);
    throw error;
  } finally {
    conn.close();
  }
  const who = session.username;
  // Who it registered with: LumiAH, or the extension LumiAH is built into, whose pages and connection go by its own names.
  const linked = linkedBackendOf(registered.backend);
  const kept = held !== undefined && registered.secret === held;
  io.out(kept ? `The runtime "${name}" keeps its registration with ${linked.name}: it answers ${who}'s replies.` : `Registered the runtime "${name}" with ${linked.name}: it answers ${who}'s replies.`);

  const origins = runtimeOrigins(listen, port);
  const scheduler = await excludeOrigins(io.http, base, session.token, origins);
  // Lumiverse reads the scheduler's setting through a short cache: a reply begun within a few seconds may still be scheduled under the old one.
  if (scheduler === "excluded") io.out(`Its address (${origins.join(", ")}) is in ${who}'s local-inference scheduler exclusions, so a reply it answers never holds the scheduler while its agents work.`);
  else if (scheduler === "unavailable") io.out("This Lumiverse has no local-inference scheduler: nothing to exclude.");
  else io.err(`Couldn't put ${origins.join(" and ")} in ${who}'s local-inference scheduler exclusions. Before turning the scheduler on, add them under Settings → Inference scheduler → Excluded origins: a reply the runtime answers would otherwise hold the scheduler, and Lumiverse's local models wait, for as long as its agents work.`);

  // How it is kept: the limit it had (unless --memory gives another), its own choice of updating by itself, and the file this line runs, which it later takes its updates from. The unit it had stays its until `down` removes it; a unit installed below is recorded there instead.
  // The limit it had is its config's once the config names the unit holding it to one. A runtime set up before the limit was kept there has it only in its unit: read from there, setting it up again with this build doesn't quietly give it another.
  const had = previous?.service != null ? previous.memory : (unitMemory(io.files.read(place.unit)) ?? previous?.memory);
  const config: SavedConfig = { name, base, extension, listen, port, relay: registered.relay, secret: registered.secret, session, tuning, memory: memoryAsked ?? had ?? SETUP_DEFAULTS.memory, autoUpdate: previous?.autoUpdate ?? SETUP_DEFAULTS.autoUpdate, source: io.self, service: previous?.service ?? null };
  const connection = await loopbackConnection(io, base, session.token, runtimeBase(listen, port), registered.model || loopbackModel(extension), config.tuning.connectionsRead, linked);
  // Lumiverse's "always use the active connection" acts on Edit and Send only: there it overrides a chat's pin to the loopback.
  if ((await editAndSendPrefersActive(io.http, base, session.token)) === true) io.err(`${who} has "always use the active connection" on for Edit and Send: a message sent with Edit and Send goes on the active connection, not a chat's pin to the loopback, and ${linked.name} answers it only when the active connection is the loopback.`);

  if (!systemd) {
    writeConfig(place.config, config, io);
    io.out(`Saved the runtime's config in ${place.config} (readable only by you).`);
    io.out(connection);
    if (inContainer(io)) io.out(containerGuide(bun, io.self, place.config, base, extension));
    return serve(config, place.config, io);
  }

  // A stable copy the unit owns: an update of the extension removes and replaces its install.
  const script = installedPath(dataDir(io.env, io.home), extension);
  io.files.copy(io.self, script, 0o644);
  // The limit is the config's, so setting the runtime up again keeps the one it had.
  io.files.write(place.unit, unitText({ name, bun, script, config: place.config, memory: config.memory }), 0o644, 0o755);
  const service: SystemdService = { manager: "systemd", unit: place.unitName, file: place.unit, bun, script };
  const ctl = systemctlOf(io.env, io.uid);
  // Before the unit starts: lingering also starts the user's service manager, which `systemctl --user` needs.
  const user = await must(io, "id", ["-nu"]);
  const lingering = await linger(io, user);
  try {
    await must(io, "systemctl", [...ctl.args, "daemon-reload"], ctl.env);
  } catch (error) {
    // No user manager to reach: lingering is off, and the account has no session of its own (`sudo -u`).
    if (lingering) throw error;
    throw new Error(`${user}'s service manager isn't running (lingering is off, and ${user} isn't logged in), so the runtime's service can't start. Turn lingering on with: sudo loginctl enable-linger ${user}, then run this again.`);
  }
  await must(io, "systemctl", [...ctl.args, "enable", place.unitName], ctl.env);
  if (previous !== null) await drain(previous, io, "restarting it");
  // Written only now: until it is restarted, the runtime that ran through the wait writes its own config (the limits it reads, a secret rotated on the Runtime page), over whatever is there. A secret it was handed meanwhile is the registration's now.
  const latest = kept ? configNamed(name, io) : null;
  const installed: SavedConfig = { ...config, service };
  writeConfig(place.config, latest !== null && latest.relay === config.relay ? { ...installed, secret: latest.secret } : installed, io);
  await must(io, "systemctl", [...ctl.args, "restart", place.unitName], ctl.env);
  const when = lingering ? "it is started, and starts at boot and keeps running when you log out" : "it is started, but only runs while you are logged in (see above)";
  io.out(`Installed the runtime as ${script} and the unit ${place.unitName} (memory cap ${config.memory}); ${when}.`);
  io.out(connection);
  return 0;
}

/**
 * A user unit starts at boot and outlives a logout only with lingering on (systemd-logind): on
 * already, turned on now (logind lets a user do it for themself where its policy allows), or the
 * line that does it. Whether it is on in the end.
 */
async function linger(io: RuntimeIO, user: string): Promise<boolean> {
  const on = async (): Promise<boolean> => (await io.run("loginctl", ["show-user", user, "--property=Linger", "--value"])).out.trim() === "yes";
  if (await on()) return true;
  const asked = await io.run("loginctl", ["enable-linger", user]);
  if (asked.code === 0 && (await on())) {
    io.out(`Turned lingering on for ${user}, so the runtime's service starts at boot and keeps running after you log out.`);
    return true;
  }
  io.err(`Lingering is off for ${user} and couldn't be turned on from here${asked.err.trim() !== "" ? ` (${asked.err.trim()})` : ""}: the runtime's service won't start at boot and stops when you log out. Turn it on with: sudo loginctl enable-linger ${user}`);
  return false;
}

/**
 * The loopback's Custom connection: the user's own where one is already (Custom, naming the
 * extension's loopback model, or on the runtime's address and no other extension's), else added
 * for them with their own session, since Spindle gives an extension no way to add one. It is named
 * as the extension the runtime registered with says (`linked`), so the first link finds it and
 * makes no second one. It's added without a key: minting the key on the Runtime page puts it in,
 * through the running runtime. The line says what to do next.
 */
async function loopbackConnection(io: RuntimeIO, base: string, token: string, url: string, model: string, read: number, linked: LinkedBackend): Promise<string> {
  try {
    const found = loopbackProfile(await connectionProfiles(io.http, base, token, read), url, model);
    if (found !== null) return `Your connection "${found.name}" is the loopback (${url}, model ${model}). Its API key is your loopback key: mint one on ${linked.name}'s Runtime page and it is put in for you.`;
    const made = await addConnectionProfile(io.http, base, token, { name: linked.connection, provider: "custom", apiUrl: url, model });
    return `Added the connection "${made.name}" to Lumiverse: Custom (OpenAI-compatible), base URL ${url}, model ${model}. Mint your loopback key on ${linked.name}'s Runtime page next: it is put in the connection for you.`;
  } catch (error) {
    return `Couldn't add the loopback connection for you (${error instanceof Error ? error.message : String(error)}). In Lumiverse, the loopback is a Custom (OpenAI-compatible) connection: base URL ${url}, model ${model}, and as its API key your loopback key (${linked.name}'s Runtime page).`;
  }
}

// ---------------------------------------------------------------- serve

/** How often a copy of the runtime that waits for another to stop serving asks again, and renews its mark. */
const WAIT_MS = 5_000;
/** A waiting copy's mark in the runtime's own folder: `{ pid, since, seen }`. */
const WAITING = "waiting.json";

/** Whether a runtime answers `GET /healthz` on this config's address now: another copy of this one serves there, or another runtime does. */
async function answersThere(config: RuntimeConfig, io: RuntimeIO): Promise<boolean> {
  try {
    const body = await healthOf(config, io);
    return isRecord(body) && (body.up === true || typeof body.link === "string");
  } catch {
    return false;
  }
}

/**
 * Never two copies of one runtime on its port. Where a restart starts the runtime as a new process
 * (Windows, which can't replace one in place), the task or service wrapper that ran the old process
 * may start one too. Whichever copy comes second finds the first answering on the port: it serves
 * nothing and links to nothing, waits until that one stops, and meanwhile keeps a mark in the
 * runtime's folder, which the one that serves shows on the Runtime page. Resolves null once the
 * port is this one's to take; with the signal's name when it is asked to stop while it waits.
 */
async function waitForPort(config: RuntimeConfig, io: RuntimeIO, dir: string, log: (text: string) => void, stopping: Promise<string>): Promise<string | null> {
  const mark = `${dir}/${WAITING}`;
  let since: number | null = null;
  try {
    while (await answersThere(config, io)) {
      const now = io.now();
      if (since === null) {
        since = now;
        log(`another copy of this runtime serves on ${config.listen}:${config.port}: this one waits, and serves once that one stops (stop this one if it shouldn't)`);
      }
      io.files.write(mark, JSON.stringify({ pid: io.pid, since, seen: now }), 0o600, RUNTIME_DIR_MODE);
      const stopped = await Promise.race([io.sleep(WAIT_MS).then(() => null), stopping]);
      if (stopped !== null) return stopped;
    }
    return null;
  } finally {
    if (since !== null) io.files.remove(mark);
  }
}

/** The copy of this runtime that waits to serve while this one does, by the mark it renews; null when none does, or its mark is too old to be one's that still waits. */
function waitingCopy(io: RuntimeIO, dir: string): { pid: number; since: number } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(io.files.read(`${dir}/${WAITING}`) ?? "null");
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.pid !== "number" || typeof raw.since !== "number" || typeof raw.seen !== "number" || raw.pid === io.pid) return null;
  return io.now() - raw.seen <= 3 * WAIT_MS ? { pid: raw.pid, since: raw.since } : null;
}

/** Runs the runtime until the process is asked to stop, or an update restarts it. `path` is its config, read again for the session whenever the link opens, so `lumiah login` takes effect without a restart. */
export async function serve(config: SavedConfig, path: string, io: RuntimeIO): Promise<number> {
  const start = io.serve;
  if (start === null) throw new UsageError("LumiAH's runtime runs on Bun (Bun.serve, idleTimeout 0): run it with Bun.");
  const log = (text: string): void => io.err(`[lumiah ${config.name}] ${text}`);
  // The session is read from the file again whenever it is needed; the secret, the limits and how the runtime is kept are this process's own to change.
  let current = config;
  const session = (): StoredLogin => {
    try {
      current = { ...current, session: configOf(io.files.read(path), path).session };
    } catch {
      // The file went or broke under it: the sign-in it started with stands.
    }
    return current.session;
  };
  // The one writer of the config while the runtime runs: it writes the whole of `current`, so every change (a secret rotated, the limits, the Runtime page's settings) goes through it.
  const keep = (change: Partial<SavedConfig>): void => {
    session();
    current = { ...current, ...change };
    try {
      writeConfig(path, current, io);
    } catch (error) {
      log(`couldn't write ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // The unit that runs it, for the Runtime page's lines and for how it restarts: the one `up --systemd` installed, when this process is that unit's.
  const me = { env: io.env, home: io.home, bun: io.bun, self: io.self, real: (file: string) => io.files.real(file) };
  const service = unitRunning(config, me);
  // The runtime's own folder: its connections, its keys and its working store go in it, so no one but its owner may enter it.
  const dir = io.files.folder(runtimeDir(dataDir(io.env, io.home), config.name), RUNTIME_DIR_MODE);
  const stopping = io.stopped();
  const stoppedFirst = await waitForPort(config, io, dir, log, stopping);
  if (stoppedFirst !== null) {
    log(`stopping (${stoppedFirst}) before it served`);
    return 0;
  }
  // An update restarts the runtime by leaving: it stops serving as a stop does, then hands its process to its successor.
  const left = Promise.withResolvers<Successor>();
  const runtime = createRuntime(config, {
    http: io.http,
    openSocket: io.openSocket,
    now: io.now,
    log,
    build: io.build,
    ran: { bun: io.bun, script: io.self, unit: service?.unit ?? null },
    host: io.hostname,
    dir,
    credentials: session,
    secret: () => current.secret,
    rotated: (secret) => keep({ secret }),
    keepTuning: (tuning) => keep({ tuning }),
    harness: io.harness,
    writerConnection: io.writerConnection,
    models: createModelLayer,
    update: (busy) =>
      createUpdate({
        config: () => current,
        save: (change) => keep(change),
        configPath: path,
        build: io.build,
        bun: io.bun,
        self: io.self,
        installed: installedCopy(config, me),
        service,
        platform: io.platform,
        container: inContainer(io),
        env: io.env,
        uid: io.uid,
        files: io.updateFiles,
        run: io.run,
        leave: (next) => left.resolve(next),
        busy,
        now: io.now,
        log,
        name: () => runtime.link.backendName,
        handedOver: io.env[HANDED_OVER] !== undefined,
        waitingCopy: () => waitingCopy(io, dir),
      }),
  });
  let server: Served;
  try {
    server = start({ hostname: config.listen, port: config.port, fetch: runtime.fetch });
  } catch (error) {
    await runtime.close();
    throw new Error(`The runtime can't serve on ${config.listen}:${config.port}: ${error instanceof Error ? error.message : String(error)}. Is another runtime running there?`);
  }
  log(`serving ${runtimeBase(config.listen, config.port)} for ${config.base} as ${config.session.username} (build ${io.build})`);
  void runtime.link.fix();
  const timer = setInterval(() => runtime.tick(), 1_000);
  const ended = await Promise.race([stopping, left.promise]);
  log(`stopping (${typeof ended === "string" ? ended : "to restart on its new build"})`);
  clearInterval(timer);
  runtime.shutdown();
  // A moment for the error chunks and cancels to go out.
  await io.sleep(current.tuning.stopGraceMs);
  server.stop();
  await runtime.close();
  if (typeof ended === "string") return 0;
  try {
    await io.handOver(ended);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------- login, status, down

/**
 * How the runtime running with this config says it is (`GET /healthz`), asked as the holder of its
 * config (`healthProof`): so it answers in full wherever it listens, where a request that shows
 * nothing is told only that it is up. Rejects when nothing answers there.
 */
async function healthOf(config: RuntimeConfig, io: RuntimeIO): Promise<unknown> {
  const reply = await io.http({ method: "GET", url: `${runtimeBase(config.listen, config.port).replace(/\/v1$/, "")}/healthz`, headers: { Accept: "application/json", Authorization: `Bearer ${await healthProof(config.secret, io.now())}` } });
  return JSON.parse(reply.text) as unknown;
}

/** The requests the runtime running with this config has under way; 0 when it doesn't answer. */
async function turnsUnderWay(config: RuntimeConfig, io: RuntimeIO): Promise<number> {
  try {
    const body = await healthOf(config, io);
    return isRecord(body) && typeof body.requests === "number" ? body.requests : 0;
  } catch {
    return 0;
  }
}

/** Before `up` ends a running runtime's link (`then`: restarting it, or registering it anew): either cuts the replies it answers, so it waits for them to finish, up to `drainMs`. */
async function drain(config: RuntimeConfig, io: RuntimeIO, then: "restarting it" | "registering it anew"): Promise<void> {
  const { drainMs, drainPollMs } = config.tuning;
  let turns = await turnsUnderWay(config, io);
  if (turns === 0) return;
  io.out(`The running runtime has ${turns} request(s) under way: waiting up to ${Math.round(drainMs / 60_000)} minutes for them to finish before ${then}.`);
  for (let waited = 0; waited < drainMs && turns > 0; waited += drainPollMs) {
    await io.sleep(drainPollMs);
    turns = await turnsUnderWay(config, io);
  }
  if (turns > 0) io.err(`${turns} request(s) still under way after ${Math.round(drainMs / 60_000)} minutes: ${then} ends them.`);
}

async function login(a: Args, io: RuntimeIO): Promise<number> {
  const path = configPath(a, io);
  const config = configOf(io.files.read(path), path);
  const session = await signInFor(config.base, io, a.values["--username"] ?? config.session.username, config.session.allowHttp === true);
  writeConfig(path, { ...config, session }, io);
  io.out(`The runtime "${config.name}" is signed in to ${config.base} as ${session.username} again.`);
  const place = placeOf(config.name, io);
  if (!io.files.exists(place.unit)) io.out("A runtime running in the foreground takes the new sign-in when it next connects.");
  else {
    const ctl = systemctlOf(io.env, io.uid);
    await must(io, "systemctl", [...ctl.args, "restart", place.unitName], ctl.env);
    io.out(`Restarted ${place.unitName}.`);
  }
  return 0;
}

async function status(a: Args, io: RuntimeIO): Promise<number> {
  const path = configPath(a, io);
  const config = configOf(io.files.read(path), path);
  const place = placeOf(config.name, io);
  io.out(`Runtime "${config.name}" for ${config.base} as ${config.session.username}, at ${runtimeBase(config.listen, config.port)}.`);
  if (io.files.exists(place.unit)) {
    const ctl = systemctlOf(io.env, io.uid);
    const active = await io.run("systemctl", [...ctl.args, "is-active", place.unitName], ctl.env);
    io.out(`Service ${place.unitName}: ${active.out.trim() || "unknown"}.`);
  } else io.out("No systemd unit here: it runs while `lumiah up` or `lumiah serve` runs, or under the service you made for it (launchd on macOS, Task Scheduler on Windows).");
  let healthy = false;
  try {
    const body = await healthOf(config, io);
    if (isRecord(body) && typeof body.link === "string") {
      healthy = body.ok === true && body.link === "up";
      io.out(`It answers: link to ${typeof body.backend === "string" && body.backend !== "" ? body.backend : "LumiAH"} ${body.link}, ${String(body.turns)} turn(s) under way${typeof body.problem === "string" ? `. ${body.problem}` : ""}.`);
    } else io.out(`Something answers on ${config.listen}:${config.port}, but not as the runtime this config is for: another runtime serves there, or this one was set up again and hasn't been restarted since.`);
  } catch (error) {
    io.out(`It doesn't answer on ${config.listen}:${config.port} (${error instanceof Error ? error.message : String(error)}).`);
  }
  try {
    const session = await sessionOf(io.http, config.base, config.session.token);
    io.out(session.valid === false ? `Its Lumiverse session has ended: lumiah login --name ${config.name}` : `Its Lumiverse session holds${session.expiresAt !== null ? ` until ${session.expiresAt} unused (the runtime renews it daily)` : ""}.`);
    if (session.valid === false) healthy = false;
  } catch (error) {
    io.out(`Couldn't ask ${config.base} about its session: ${error instanceof Error ? error.message : String(error)}`);
  }
  return healthy ? 0 : 1;
}

async function down(a: Args, io: RuntimeIO): Promise<number> {
  const path = configPath(a, io);
  const name = givenName(a) ?? configOf(io.files.read(path), path).name;
  const place = placeOf(name, io);
  const installed = io.files.exists(place.unit);
  if (installed) {
    const ctl = systemctlOf(io.env, io.uid);
    await must(io, "systemctl", [...ctl.args, "disable", "--now", place.unitName], ctl.env);
    io.files.remove(place.unit);
    await must(io, "systemctl", [...ctl.args, "daemon-reload"], ctl.env);
  }
  // The config stays, and names no unit that keeps the runtime running any more.
  const config = configNamed(name, io);
  if (config !== null && config.service !== null) writeConfig(place.config, { ...config, service: null }, io);
  io.out(installed ? `Stopped and removed ${place.unitName}. Its config, with the runtime's session, stays in ${place.config}: delete it to forget the runtime here.` : `There is no unit ${place.unitName}: nothing to stop.`);
  return 0;
}
