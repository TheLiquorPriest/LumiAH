// The systemd user unit that keeps a runtime running, where `up --systemd` installed one: its
// text, its file, how systemctl reaches the account's units, and whether this process is that
// unit's. Everywhere else (in the foreground, under launchd, Task Scheduler or a container) the
// runtime keeps itself, and restarts by handing its process to its successor (restart.ts).

import { unitName } from "../../link/contract";
import type { SavedConfig, SystemdService } from "../config";
import { dataDir, installedPath, xdgDir } from "../config";

type Env = Readonly<Record<string, string | undefined>>;

/** A word of a unit's ExecStart: quoted when it must be, `%` and `$` escaped (systemd.service(5)). */
function unitWord(word: string): string {
  const escaped = word.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_@%+=:,./$-]+$/.test(escaped) ? escaped : `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The unit's text: the runtime's installed copy, run by its Bun from its config, always restarted, held to its memory limit. */
export function unitText(u: { name: string; bun: string; script: string; config: string; memory: string }): string {
  return [
    `# Written by \`lumiah up --systemd\`: LumiAH's runtime. \`lumiah down --name ${u.name}\` removes it.`,
    "[Unit]",
    `Description=LumiAH runtime (${u.name})`,
    // It reconnects until Lumiverse answers, however long Lumiverse takes to start: never give up on it.
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${[u.bun, u.script, "serve", "--config", u.config].map(unitWord).join(" ")}`,
    "Restart=always",
    "RestartSec=2",
    // The cap: past it systemd stops the runtime (and starts it again) rather than let it take the machine's memory from Lumiverse.
    `MemoryMax=${u.memory}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Where a user unit's file is: `$XDG_CONFIG_HOME/systemd/user`, or `~/.config/systemd/user`. */
export function unitPath(env: Env, home: string, unit: string): string {
  return `${xdgDir(env, home, "XDG_CONFIG_HOME", ".config")}/systemd/user/${unit}`;
}

/** How systemctl reaches the account's units: `--user`, whose manager it finds by XDG_RUNTIME_DIR, which `sudo -u <account>` leaves unset (the account's is /run/user/<uid>). */
export function systemctlOf(env: Env, uid: number | null): { args: string[]; env: Record<string, string> } {
  const runtime = env.XDG_RUNTIME_DIR ?? (uid !== null ? `/run/user/${uid}` : undefined);
  return { args: ["--user"], env: runtime !== undefined ? { XDG_RUNTIME_DIR: runtime } : {} };
}

/** This process as the runtime knows it: its environment, its home, the Bun running it and the file it runs from. */
export interface ThisProcess {
  env: Env;
  home: string;
  bun: string | null;
  self: string;
  /** The path with every symlink in it resolved. */
  real(path: string): string;
}

/**
 * The unit that runs this process; null when no unit lumiah installed does. systemd marks what it
 * runs with INVOCATION_ID, but a terminal that runs as a user service hands its own mark on to every
 * command typed in it, so the mark alone isn't enough: this process must also run the file the
 * unit runs. That is the one in the config, where `up --systemd` records the unit. A config written
 * before it did names none: its unit is then the one `up --systemd` names for the runtime, running
 * the copy it installs.
 */
export function unitRunning(config: SavedConfig, me: ThisProcess): SystemdService | null {
  if (me.env.INVOCATION_ID === undefined || me.bun === null) return null;
  const runs = (script: string): boolean => {
    try {
      return me.real(script) === me.real(me.self);
    } catch {
      // A file that is gone resolves to nothing: only the very same path is this process's.
      return script === me.self;
    }
  };
  if (config.service !== null) return runs(config.service.script) ? config.service : null;
  const script = installedCopy(config, me);
  if (!runs(script)) return null;
  const unit = unitName(config.name);
  return { manager: "systemd", unit, file: unitPath(me.env, me.home, unit), bun: me.bun, script };
}

/**
 * lumiah's copy of the runtime, the one file an update replaces: the one its unit runs where `up
 * --systemd` recorded a unit (whatever data folder the unit's environment names now), else the one
 * `up --systemd` installs, where the guides for launchd and Task Scheduler copy it too.
 */
export function installedCopy(config: SavedConfig, me: Pick<ThisProcess, "env" | "home">): string {
  return config.service?.script ?? installedPath(dataDir(me.env, me.home), config.extension);
}
