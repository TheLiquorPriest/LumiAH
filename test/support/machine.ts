// A made-up machine for the `lumiah` command (src/runtime/cli.ts takes everything it does to one
// through `RuntimeIO`): files in a map, programs that only record how they were run, ports that are
// taken when a test says so, and the account `mara` (uid 1000) at its terminal, with a made-up
// Lumiverse within reach, so `up` signs in and registers for real.

import { isRecord } from "../../src/link/json";
import type { OwnedEntry, RuntimeIO } from "../../src/runtime/cli";
import type { Successor } from "../../src/runtime/update/restart";
import type { FakeLumiverse } from "./fake-lumiverse";
import { tempFolder } from "./folders";

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
  /** Every folder made, with the mode it was given and the real folder that stands in for it (the runtime keeps its own files on the disk). */
  folders: Map<string, { mode: number; at: string }>;
  /** Symbolic links, by the path that is one, to the path it leads to. */
  links: Map<string, string>;
  /** Every successor the runtime handed its process to, in order (nothing is started). */
  handedOver: Successor[];
}

/** What a test's machine differs in: who runs the command, on what system, with what in its environment, under which Bun. */
export type MachineChange = Partial<Pick<RuntimeIO, "uid" | "platform" | "env" | "bun">>;

/** A machine Lumiverse is reached from. The command runs as LumiAH's own copy of the runtime; a test that runs another extension's gives `io` that copy's path as `self`. */
export function machine(lumiverse: FakeLumiverse, change: MachineChange = {}): Machine {
  const m: Omit<Machine, "io"> = { out: [], err: [], files: new Map(), owners: new Map(), taken: new Set(), served: [], ran: [], asked: [], folders: new Map(), links: new Map(), handedOver: [] };
  const real = (path: string): string => m.links.get(path) ?? path;
  const uid = change.uid === undefined ? 1000 : change.uid;
  const io: RuntimeIO = {
    out: (text) => void m.out.push(text),
    err: (text) => void m.err.push(text),
    env: change.env ?? { LUMIVERSE_PASSWORD: "a made-up password" },
    ask: async () => null,
    http: async (request) => {
      const url = new URL(request.url);
      // Lumiverse's port, whatever name it is reached by, is the only one anything serves on here: a request to another (the runtime's own, while no test makes it answer) finds nobody, as a refused connection.
      if (url.port !== new URL(lumiverse.base).port) throw new Error(`Unable to connect: nothing listens on ${url.host}`);
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
      real,
      // A folder made here is a real one, made once for each path: what the runtime keeps in it stays there from one serve to the next.
      folder: (path, mode) => {
        const at = m.folders.get(path)?.at ?? tempFolder();
        m.folders.set(path, { mode, at });
        return at;
      },
    },
    run: async (command, args) => {
      m.ran.push([command, ...args].join(" "));
      if (command === "id") return { code: 0, out: args.includes("-nu") && args.length === 1 ? "mara\n" : "brann\n", err: "" };
      if (command === "loginctl" && args[0] === "show-user") return { code: 0, out: "yes\n", err: "" };
      // A build of the runtime says its version, as a whole one does; a test of one that can't start answers otherwise.
      if (args.at(-1) === "--version") return { code: 0, out: "lumiah 0.0.2 (build next-build)\n", err: "" };
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
    // The same files as the command's, as bytes.
    updateFiles: {
      read: (path) => {
        const file = m.files.get(path);
        return file === undefined ? null : new TextEncoder().encode(file.text);
      },
      write: (path, bytes, mode) => void m.files.set(path, { text: new TextDecoder().decode(bytes), mode, dirMode: null }),
      mode: (path) => m.files.get(path)?.mode ?? null,
      rename: (from, to) => {
        const file = m.files.get(from);
        if (file === undefined) throw new Error(`no such file: ${from}`);
        m.files.set(to, file);
        m.files.delete(from);
      },
      remove: (path) => void m.files.delete(path),
      real,
    },
    handOver: async (next) => void m.handedOver.push(next),
    pid: 4242,
  };
  return { ...m, io };
}
