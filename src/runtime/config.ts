// A runtime's config: `~/.config/lumiah/<name>.json` (under `$XDG_CONFIG_HOME` when that is set),
// readable only by its owner, since it holds the runtime's Lumiverse session (a whole-account
// credential) and its relay secret. `up` writes it; `serve` reads it, and reads its session again
// whenever the link opens, so `lumiah login` takes effect without a restart. Its `tuning` is the
// runtime's limits and timings as it last read them from the user's settings: what it starts with
// before it has linked.

import { isRecord } from "../link/json";
import { EXTENSION_IDENTIFIER } from "../link/contract";
import type { RuntimeTuning } from "../link/settings";
import { RUNTIME_DEFAULTS, TRANSPORT_KEY, runtimeTuningOf } from "../link/settings";
import type { StoredLogin } from "./lumiverse";

export interface RuntimeConfig {
  name: string;
  /** Lumiverse's address, as the runtime reaches it. */
  base: string;
  /** The identifier of the extension it links to: LumiAH's own, or that of an extension LumiAH is built into. */
  extension: string;
  /** Where it serves the loopback endpoint. */
  listen: string;
  port: number;
  /** Its registration with the extension, and the secret only it holds. */
  relay: string;
  secret: string;
  session: StoredLogin;
  tuning: RuntimeTuning;
}

/** The file's format: a config of another one is set up again rather than guessed at. */
const FORMAT = 1;

/** Where configs live: `$XDG_CONFIG_HOME/lumiah`, or `~/.config/lumiah` when that is unset or not absolute (the XDG spec says to ignore a relative one). */
export function configDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  return `${xdg !== undefined && xdg.startsWith("/") ? xdg : `${home}/.config`}/lumiah`;
}

export function configPathOf(dir: string, name: string): string {
  return `${dir}/${name}.json`;
}

/** A config as its file holds it. */
export function configText(config: RuntimeConfig): string {
  return `${JSON.stringify({ lumiah: FORMAT, runtime: config }, null, 2)}\n`;
}

/** The config a file's text holds; throws, in words that say what to do, when it holds none this build reads. */
export function configOf(text: string | null, path: string): RuntimeConfig {
  if (text === null) throw new Error(`There is no runtime config at ${path}. Set the runtime up with: lumiah up --url <the address you open Lumiverse at>`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${path} isn't readable JSON. Set the runtime up again with: lumiah up`);
  }
  const c = isRecord(raw) && raw.lumiah === FORMAT && isRecord(raw.runtime) ? raw.runtime : null;
  const s = c !== null && isRecord(c.session) ? c.session : null;
  if (c === null || s === null || typeof c.name !== "string" || typeof c.base !== "string" || typeof c.listen !== "string" || typeof c.port !== "number" || typeof c.relay !== "string" || typeof c.secret !== "string" || typeof s.username !== "string" || typeof s.token !== "string") {
    throw new Error(`${path} isn't a runtime config this lumiah reads. Set the runtime up again with: lumiah up`);
  }
  // Read as the settings' own section is, so a value this build refuses falls back to its default.
  const tuning = isRecord(c.tuning) ? runtimeTuningOf({ [TRANSPORT_KEY]: { runtime: c.tuning } }) : { ...RUNTIME_DEFAULTS };
  // A config written before the extension could be named links to LumiAH's own.
  const extension = typeof c.extension === "string" && c.extension !== "" ? c.extension : EXTENSION_IDENTIFIER;
  return { name: c.name, base: c.base, extension, listen: c.listen, port: c.port, relay: c.relay, secret: c.secret, session: { username: s.username, token: s.token, savedAt: typeof s.savedAt === "number" ? s.savedAt : 0, ...(s.allowHttp === true ? { allowHttp: true } : {}) }, tuning };
}
