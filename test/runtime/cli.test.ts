// The `lumiah` command, as far as it can be run without systemd or a real disk (DESIGN §1; the
// runtime's own guide is docs/RUNTIME.md): what it takes and refuses on its command line, the port it
// picks, the config it writes and with which mode, and the unit it would install. The machine is a
// fake: files in a map, programs that only record how they were run, and a made-up Lumiverse with
// LumiAH's backend behind it, so `up` signs in and registers for real.

import { describe, expect, test } from "bun:test";
import { AGENT, createHarness, isRecord, settingsOf } from "../../src/core/index";
import { startBackend } from "../../src/extension/backend/backend";
import { type OwnedEntry, type RuntimeIO, lumiah, unitText } from "../../src/runtime/cli";
import { configOf } from "../../src/runtime/config";
import { FakeHost } from "../support/fake-host";
import { FakeLumiverse } from "../support/fake-lumiverse";
import { USER } from "../support/rig";

const HOME = "/home/mara";
const SELF = "/srv/lumiverse/extensions/lumi_ah/dist/lumiah.js";
const BUN = "/opt/bun/bin/bun";

interface Machine {
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
  host: FakeHost;
}

/** A machine with Lumiverse on it, LumiAH installed and running, and the account `mara` (uid 1000) at its terminal. */
function machine(change: Partial<Pick<RuntimeIO, "uid" | "platform" | "env" | "bun">> = {}): Machine {
  const host = new FakeHost();
  const lumiverse = new FakeLumiverse(host, USER);
  // Nothing these tests do waits on the backend's own timers, so it is given none.
  startBackend(host, { now: () => Date.now(), later: () => () => undefined, build: "test-build" });
  const m: Omit<Machine, "io"> = { out: [], err: [], files: new Map(), owners: new Map(), taken: new Set(), served: [], ran: [], asked: [], host };
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
    build: "test-build",
    version: "0.0.1",
    harness: (harnessHost, settings) => createHarness(harnessHost, { settings }),
    writerConnection: (values) => settingsOf(isRecord(values) ? values.core : undefined).agents[AGENT.writer]?.connectionId ?? null,
  };
  return { ...m, io };
}

const UP = ["up", "--url", "http://127.0.0.1:7860", "--username", "mara"];
const CONFIG = `${HOME}/.config/lumiah/mara.json`;

describe("lumiah's command line", () => {
  test("says its version, and its usage when it is given nothing to do", async () => {
    const m = machine();
    expect(await lumiah(["--version"], m.io)).toBe(0);
    expect(m.out).toEqual(["lumiah 0.0.1 (build test-build)"]);
    expect(await lumiah([], m.io)).toBe(2);
    expect(m.out[1]).toContain("lumiah up --url <address>");
  });

  test("refuses a command it doesn't have, an option a command doesn't take, and a value it can't read, each by name", async () => {
    const m = machine();
    expect(await lumiah(["launch"], m.io)).toBe(2);
    expect(m.err.at(-1)).toContain("There is no lumiah launch: up, serve, login, status or down.");
    expect(await lumiah([...UP, "--frobnicate", "yes"], m.io)).toBe(2);
    expect(m.err.at(-1)).toContain("lumiah up doesn't take --frobnicate.");
    expect(await lumiah([...UP, "--port"], m.io)).toBe(2);
    expect(m.err.at(-1)).toContain("--port needs a value.");
    expect(await lumiah([...UP, "--port", "harbour"], m.io)).toBe(2);
    expect(m.err.at(-1)).toBe('--port is "harbour": give a port number.');
    expect(await lumiah([...UP, "--name", "Mara's Box"], m.io)).toBe(2);
    expect(m.err.at(-1)).toBe(`--name is "Mara's Box": use lowercase letters, digits, _ and -, up to 40.`);
    expect(await lumiah([...UP, "--memory", "12Q"], m.io)).toBe(2);
    expect(m.err.at(-1)).toBe('--memory is "12Q": give a size as systemd reads one, such as 768M or 2G.');
    // Nothing was served, written or run for any of them.
    expect(m.served).toEqual([]);
    expect([...m.files.keys()]).toEqual([]);
  });

  test("refuses plain http to another machine before a password is sent, unless --allow-http accepts it", async () => {
    const m = machine();
    expect(await lumiah(["up", "--url", "http://lumiverse.example:7860", "--username", "mara"], m.io)).toBe(2);
    expect(m.err.at(-1)).toBe("http://lumiverse.example:7860 is plain http to another machine: the password, and the runtime's session on every call after, would cross the network in clear. Use Lumiverse's https address, or accept that with --allow-http.");
    expect(m.asked).toEqual([]);
    expect([...m.files.keys()]).toEqual([]);

    const accepted = machine();
    expect(await lumiah(["up", "--url", "http://lumiverse.example:7860", "--username", "mara", "--allow-http"], accepted.io)).toBe(0);
    expect(accepted.asked).toContain("POST /api/auth/sign-in/username");
    // The consent is kept with the sign-in, so the session is sent there again later without asking.
    expect(configOf(accepted.files.get(CONFIG)?.text ?? null, CONFIG).session.allowHttp).toBe(true);
  });

  test("refuses --systemd as root, and where there is no systemd, with what to do instead", async () => {
    const root = machine({ uid: 0 });
    expect(await lumiah([...UP, "--systemd"], root.io)).toBe(1);
    expect(root.err.at(-1)).toBe("--systemd installs a service of your own account, and root's account has none on most systems. Run the runtime as the account Lumiverse runs as (sudo -u <account> …): it needs no more rights than that.");
    expect([...root.files.keys()]).toEqual([]);
    expect(root.ran.some((line) => line.startsWith("systemctl"))).toBe(false);

    const mac = machine({ platform: "darwin" });
    expect(await lumiah([...UP, "--systemd"], mac.io)).toBe(1);
    expect(mac.err.at(-1)).toContain("--systemd installs a systemd service, and this is darwin.");
  });

  test("refuses to run code another account can change, and names it", async () => {
    const m = machine();
    m.owners.set(SELF, { uid: 1001, gid: 1001, mode: 0o644 });
    expect(await lumiah(UP, m.io)).toBe(1);
    expect(m.err.at(-1)).toContain("Refusing to run as mara: another account can change these");
    expect(m.err.at(-1)).toContain(`${SELF}: brann can change it`);
    expect(m.asked).toEqual([]);
  });
});

describe("lumiah up", () => {
  test("signs in, registers, and writes a config only its account can read, without the password", async () => {
    const m = machine();
    expect(await lumiah(UP, m.io)).toBe(0);
    const written = m.files.get(CONFIG);
    // rw for the owner alone, in a directory only the owner enters.
    expect(written?.mode).toBe(0o600);
    expect(written?.dirMode).toBe(0o700);
    const config = configOf(written?.text ?? null, CONFIG);
    expect(config).toMatchObject({ name: "mara", base: "http://127.0.0.1:7860", listen: "127.0.0.1", port: 7871, session: { username: "mara", token: "session-token-mara" } });
    expect(config.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(written?.text).not.toContain("a made-up password");
    // The extension holds the runtime's registration, and only a hash of its secret.
    const registry = JSON.stringify(m.host.stored(USER, "registry.json"));
    expect(registry).toContain('"name":"mara"');
    expect(registry).not.toContain(config.secret);
    // It served where it said, and made the loopback connection for the user.
    expect(m.served.at(-1)).toEqual({ hostname: "127.0.0.1", port: 7871 });
    expect(m.host.connectionList).toMatchObject([{ name: "LumiAH", provider: "custom", url: "http://127.0.0.1:7871/v1", model: "lumiah" }]);
    expect(m.out.join("\n")).toContain(`Saved the runtime's config in ${CONFIG} (readable only by you).`);
  });

  test("takes the first free port from 7871, the port asked for when it is free, and the one it had before", async () => {
    const m = machine();
    m.taken.add(7871).add(7872);
    expect(await lumiah(UP, m.io)).toBe(0);
    expect(configOf(m.files.get(CONFIG)?.text ?? null, CONFIG).port).toBe(7873);
    // Set up again, it keeps its port, though by now that port is its own to be taken.
    m.taken.add(7873);
    m.served.length = 0;
    expect(await lumiah(UP, m.io)).toBe(1);
    expect(m.err.at(-1)).toContain("The runtime can't serve on 127.0.0.1:7873");
    m.taken.delete(7873);
    expect(await lumiah(UP, m.io)).toBe(0);
    expect(m.served.at(-1)).toEqual({ hostname: "127.0.0.1", port: 7873 });

    const asked = machine();
    expect(await lumiah([...UP, "--port", "9000"], asked.io)).toBe(0);
    expect(asked.served.at(-1)).toEqual({ hostname: "127.0.0.1", port: 9000 });
    const busy = machine();
    busy.taken.add(9000);
    expect(await lumiah([...UP, "--port", "9000"], busy.io)).toBe(1);
    expect(busy.err.at(-1)).toBe("Port 9000 on 127.0.0.1 is taken. Pick another with --port.");

    const full = machine();
    for (let port = 7871; port <= 7899; port++) full.taken.add(port);
    expect(await lumiah(UP, full.io)).toBe(1);
    expect(full.err.at(-1)).toBe("No port from 7871 to 7899 is free on 127.0.0.1: pick one with --port.");
  });

  test("with --systemd writes the unit and a stable copy of the runtime, and starts the service of the account", async () => {
    const m = machine();
    expect(await lumiah([...UP, "--systemd", "--memory", "768M"], m.io)).toBe(0);
    const unit = m.files.get(`${HOME}/.config/systemd/user/lumiah-mara.service`);
    expect(unit?.mode).toBe(0o644);
    expect(unit?.text).toBe(unitText({ name: "mara", bun: BUN, script: `${HOME}/.local/share/lumiah/lumiah.js`, config: CONFIG, memory: "768M" }));
    expect(m.files.get(`${HOME}/.local/share/lumiah/lumiah.js`)).toMatchObject({ text: `copy of ${SELF}`, mode: 0o644 });
    expect(m.files.get(CONFIG)?.mode).toBe(0o600);
    expect(m.ran.filter((line) => line.startsWith("systemctl"))).toEqual(["systemctl --user daemon-reload", "systemctl --user enable lumiah-mara.service", "systemctl --user restart lumiah-mara.service"]);
    // The service serves; this command doesn't.
    expect(m.served.filter((s) => s.port === 7871)).toHaveLength(1);
    expect(m.out.join("\n")).toContain("the unit lumiah-mara.service (memory cap 768M)");
  });
});

describe("the unit lumiah installs", () => {
  test("runs the runtime's stable copy from its config, restarts it always, and caps its memory", () => {
    expect(unitText({ name: "mara", bun: BUN, script: `${HOME}/.local/share/lumiah/lumiah.js`, config: CONFIG, memory: "1G" }).split("\n")).toEqual([
      "# Written by `lumiah up --systemd`: LumiAH's runtime. `lumiah down --name mara` removes it.",
      "[Unit]",
      "Description=LumiAH runtime (mara)",
      "StartLimitIntervalSec=0",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${BUN} ${HOME}/.local/share/lumiah/lumiah.js serve --config ${CONFIG}`,
      "Restart=always",
      "RestartSec=2",
      "MemoryMax=1G",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ]);
  });

  test("quotes a path systemd would split", () => {
    const unit = unitText({ name: "mara", bun: "/opt/my bun/bin/bun", script: "/home/mara/.local/share/lumiah/lumiah.js", config: CONFIG, memory: "2G" });
    expect(unit).toContain('ExecStart="/opt/my bun/bin/bun" /home/mara/.local/share/lumiah/lumiah.js serve');
    expect(unit).toContain("MemoryMax=2G");
  });
});
