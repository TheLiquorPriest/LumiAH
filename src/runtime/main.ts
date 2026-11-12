#!/usr/bin/env bun
// LumiAH's runtime (DESIGN §1): the `lumiah` command, built to dist/lumiah.js and run under Bun
// beside Lumiverse. This is the only file of the runtime that touches the disk, the terminal, the
// network and the process: cli.ts and everything under it take those as RuntimeIO, so the tests run
// them against a fake machine. It also joins the runtime to the core: the harness that answers a
// turn, over the host the runtime implements on the link.

import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json";
import { AGENT, createHarness, settingsOf } from "../core/index";
import { EXTENSION_IDENTIFIER } from "../link/contract";
import { isRecord } from "../link/json";
import type { RuntimeIO } from "./cli";
import { lumiah } from "./cli";
import type { OpenSocket } from "./connection";
import type { Http } from "./lumiverse";

if (process.versions.bun === undefined) {
  process.stderr.write("LumiAH's runtime runs on Bun 1.4 or newer (its server is Bun.serve): run this file with bun, as LumiAH's Runtime page shows it.\n");
  process.exit(1);
}

/** The build this bundle came from: `bun run build` defines it into every bundle; "dev" run from source. */
const BUILD: string = process.env.LAH_BUILD_ID ?? "dev";

const http: Http = async (request) => {
  // Redirects aren't followed: one would drop the bearer (lumiverse.ts reads the Location itself).
  const response = await fetch(request.url, { method: request.method, headers: request.headers, ...(request.body !== undefined ? { body: request.body } : {}), redirect: "manual" });
  const text = await response.text();
  return { status: response.status, header: (name) => response.headers.get(name), text };
};

const openSocket: OpenSocket = (url, events) => {
  const ws = new WebSocket(url);
  ws.addEventListener("message", (event) => events.message(typeof event.data === "string" ? event.data : String(event.data)));
  ws.addEventListener("close", (event) => events.close(event.code, event.reason));
  // An error is followed by a close, which says what happened.
  ws.addEventListener("error", () => undefined);
  return { send: (text) => ws.send(text), close: () => ws.close() };
};

/** A question on the terminal, on stderr so stdout keeps only the command's own words; `hidden` echoes nothing. */
function ask(question: string, hidden: boolean): Promise<string | null> {
  const input = process.stdin;
  if (!input.isTTY) return Promise.resolve(null);
  const { promise, resolve } = Promise.withResolvers<string | null>();
  if (!hidden) {
    const rl = createInterface({ input, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on("SIGINT", () => {
      rl.close();
      resolve(null);
    });
    return promise;
  }
  process.stderr.write(question);
  const typed: string[] = [];
  const done = (value: string | null): void => {
    input.setRawMode(false);
    input.pause();
    input.off("data", key);
    process.stderr.write("\n");
    resolve(value);
  };
  const key = (chunk: string): void => {
    for (const ch of chunk) {
      if (ch === "\r" || ch === "\n") return done(typed.join(""));
      if (ch === "\u0003") return done(null);
      if (ch === "\u0004") return done(typed.length > 0 ? typed.join("") : null);
      if (ch === "\u007f" || ch === "\b") typed.pop();
      else typed.push(ch);
    }
  };
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();
  input.on("data", key);
  return promise;
}

const io: RuntimeIO = {
  out: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
  err: (text) => process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
  env: process.env,
  ask,
  http,
  openSocket,
  serve(options) {
    // No idle limit: a turn's stream can go quiet between keep-alives, and Bun's default closes it after 10 s.
    const server = Bun.serve({ hostname: options.hostname, port: options.port, idleTimeout: 0, fetch: options.fetch });
    return { stop: () => void server.stop(true) };
  },
  stopped() {
    const { promise, resolve } = Promise.withResolvers<string>();
    process.once("SIGTERM", () => resolve("SIGTERM"));
    process.once("SIGINT", () => resolve("SIGINT"));
    return promise;
  },
  bun: process.execPath,
  self: fileURLToPath(import.meta.url),
  uid: process.getuid?.() ?? null,
  hostname: hostname(),
  platform: process.platform,
  home: homedir(),
  files: {
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
    },
    write(path, text, mode, dirMode) {
      mkdirSync(dirname(path), { recursive: true, mode: dirMode });
      // Written whole and moved into place, with its mode before it holds anything: a config holds a session token.
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, text, { mode });
      chmodSync(temp, mode);
      renameSync(temp, path);
    },
    copy(from, to, mode) {
      mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
      const temp = `${to}.${process.pid}.tmp`;
      copyFileSync(from, temp);
      chmodSync(temp, mode);
      renameSync(temp, to);
    },
    exists: (path) => existsSync(path),
    list(dir) {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    remove: (path) => rmSync(path, { force: true }),
    // Owners and mode bits are POSIX's: Windows gives neither to check.
    stat(path) {
      if (process.platform === "win32") return null;
      const entry = statSync(path);
      return { uid: entry.uid, gid: entry.gid, mode: entry.mode };
    },
    real: (path) => realpathSync(path),
  },
  run(command, args, env) {
    const { promise, resolve } = Promise.withResolvers<{ code: number; out: string; err: string }>();
    execFile(command, [...args], { encoding: "utf8", ...(env !== undefined ? { env: { ...process.env, ...env } } : {}) }, (error, out, err) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 127;
      resolve({ code, out, err: err || (error !== null && typeof error.code !== "number" ? error.message : "") });
    });
    return promise;
  },
  sleep(ms) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  },
  now: Date.now,
  extension: EXTENSION_IDENTIFIER,
  build: BUILD,
  version: pkg.version,
  harness: (host, settings, extension) => createHarness(host, { settings, extension }),
  // The writer's connection is the writer agent's own setting, in the core's section of the settings.
  writerConnection: (values) => settingsOf(isRecord(values) ? values.core : undefined).agents[AGENT.writer]?.connectionId ?? null,
};

process.exitCode = await lumiah(process.argv.slice(2), io);
