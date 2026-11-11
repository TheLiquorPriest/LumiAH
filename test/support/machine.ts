// A made-up machine for the `lumiah` command (src/runtime/cli.ts takes everything it does to one
// through `RuntimeIO`): files in a map, programs that only record how they were run, ports that are
// taken when a test says so, and the account `mara` (uid 1000) at its terminal, with a made-up
// Lumiverse within reach, so `up` signs in and registers for real.

import { isRecord } from "../../src/link/json";
import type { OwnedEntry, RuntimeIO } from "../../src/runtime/cli";
import type { FakeLumiverse } from "./fake-lumiverse";

export const HOME = "/home/mara";
export const BUN = "/opt/bun/bin/bun";
/** LumiAH's own copy of the runtime, which the command runs as. */
export const SELF = "/srv/lumiverse/extensions/lumi_ah/dist/lumiah.js";

export interface Machine {
  io: RuntimeIO;
  out: string[];
  err: string[];
  /** Every file written or copied, with the mode it was given and its directory's. */
  files: Map<string, { text: string; mode: number; dirMode: number | null }>;
  /** Who owns what, where it isn't the account's own. */
  owners: Map<string, OwnedEntry>;
  /** The ports something else already serves on. */
  taken: Set<number>;
  /** Every address served on, in order. */
  served: { hostname: string; port: number }[];
  /** Every program run, as one line. */
  ran: string[];
  /** Every request made of Lumiverse, as `METHOD path`. */
  asked: string[];
}

/** What a test's machine differs in: who runs the command, on what system, with what in its environment, under which Bun. */
export type MachineChange = Partial<Pick<RuntimeIO, "uid" | "platform" | "env" | "bun">>;

/** A machine Lumiverse is reached from. The command runs as LumiAH's own copy of the runtime; a test that runs another extension's gives `io` that copy's path as `self`. */
export function machine(lumiverse: FakeLumiverse, change: MachineChange = {}): Machine {
  const m: Omit<Machine, "io"> = { out: [], err: [], files: new Map(), owners: new Map(), taken: new Set(), served: [], ran: [], asked: [] };
  const uid = change.uid === undefined ? 1000 : change.uid;
  const io: RuntimeIO = {
    out: (text) => void m.out.push(text),
    err: (text) => void m.err.push(text),
    env: change.env ?? { LUMIVERSE_PASSWORD: "a made-up password" },
    ask: async () => null,
    http: async (request) => {
      const url = new URL(request.url);
      m.asked.push(`${request.method} ${url.pathname}`);
      // Signing in is Lumiverse's own; everything after it is the fake's routes, with the session it gave.
      if (url.pathname === "/api/auth/sign-in/username") return { status: 200, header: () => null, text: JSON.stringify({ token: lumiverse.token }) };
      return lumiverse.http(request);
    },
    openSocket: lumiverse.openSocket,
    serve: (options) => {
      if (m.taken.has(options.port)) throw new Error(`port ${options.port} in use`);
      m.served.push({ hostname: options.hostname, port: options.port });
      return { stop: () => undefined };
    },
    // Asked to stop at once: a foreground `up` returns as soon as it serves.
    stopped: async () => "SIGTERM",
    bun: change.bun === undefined ? BUN : change.bun,
    self: SELF,
    uid,
    hostname: "harbour-box",
    platform: change.platform ?? "linux",
    home: HOME,
    files: {
      read: (path) => m.files.get(path)?.text ?? null,
      write: (path, text, mode, dirMode) => void m.files.set(path, { text, mode, dirMode }),
      copy: (from, to, mode) => void m.files.set(to, { text: `copy of ${from}`, mode, dirMode: null }),
      exists: (path) => m.files.has(path),
      list: (dir) => [...m.files.keys()].filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/")).map((path) => path.slice(dir.length + 1)),
      remove: (path) => void m.files.delete(path),
      // Everything is the account's own, and no one else's to write, unless a test says otherwise.
      stat: (path) => m.owners.get(path) ?? { uid: uid ?? 1000, gid: uid ?? 1000, mode: 0o755 },
      real: (path) => path,
    },
    run: async (command, args) => {
      m.ran.push([command, ...args].join(" "));
      if (command === "id") return { code: 0, out: args.includes("-nu") && args.length === 1 ? "mara\n" : "brann\n", err: "" };
      if (command === "loginctl" && args[0] === "show-user") return { code: 0, out: "yes\n", err: "" };
      return { code: 0, out: "", err: "" };
    },
    sleep: async () => undefined,
    now: () => Date.now(),
    extension: "lumi_ah",
    build: "test-build",
    version: "0.0.1",
    // No reply is asked of a runtime set up on this machine, so its harness answers none: the command's tests need nothing of the core. A test that runs turns gives `io` a harness of its own.
    harness: () => ({
      answer: async () => {
        throw new Error("the runtime on this machine answers no turn");
      },
    }),
    writerConnection: (values) => {
      const writer = isRecord(values) && isRecord(values.core) && isRecord(values.core.agents) ? values.core.agents.writer : undefined;
      return isRecord(writer) && typeof writer.connectionId === "string" ? writer.connectionId : null;
    },
  };
  return { ...m, io };
}
