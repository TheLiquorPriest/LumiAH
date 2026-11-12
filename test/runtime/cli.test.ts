// The `lumiah` command, as far as it can be run without systemd or a real disk (DESIGN §1; the
// runtime's own guide is docs/RUNTIME.md): what it takes and refuses on its command line, the port it
// picks, the config it writes and with which mode, the unit it would install, and what it does to a
// runtime that is already running. The machine is a fake (test/support/machine.ts): files in a map,
// programs that only record how they were run, and a made-up Lumiverse with LumiAH's backend behind
// it, so `up` signs in and registers for real.

import { describe, expect, test } from "bun:test";
import type { AgentUsage, HarnessHost } from "../../src/core/ports";
import { createBackend } from "../../src/extension/backend/backend";
import { isRecord } from "../../src/link/json";
import { PROBE_HEADER, roadProof } from "../../src/link/road";
import { lumiah, type RuntimeIO } from "../../src/runtime/cli";
import { configOf, configText, dataDir, installedPath, runtimeDir, SETUP_DEFAULTS } from "../../src/runtime/config";
import { unitText } from "../../src/runtime/update/service";
import { FakeHost } from "../support/fake-host";
import { FakeLumiverse } from "../support/fake-lumiverse";
import { BUN, HOME, type Machine, type MachineChange, machine as machineOn, SELF } from "../support/machine";
import { FAST, PORT, rig, runtimeFrom, until, USER } from "../support/rig";

/** Nothing these tests do waits on a backend's own timers, so it is given none. */
const ENV = { now: () => Date.now(), later: () => () => undefined, build: "test-build" };

/** A machine and the Lumiverse reached from it, as LumiAH's own extension sees that Lumiverse. */
type Installed = Machine & { host: FakeHost };

/** A machine with Lumiverse on it, LumiAH installed and running, and the account `mara` (uid 1000) at its terminal. */
function machine(change: MachineChange = {}): Installed {
  const host = new FakeHost();
  createBackend(host, ENV);
  return { ...machineOn(new FakeLumiverse(host, USER), change), host };
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
    expect(m.err.at(-1)).toBe('--memory is "12Q": give a size as systemd reads one, such as 768M or 2G, or infinity for no limit.');
    expect(await lumiah([...UP, "--memory", "128M"], m.io)).toBe(2);
    expect(m.err.at(-1)).toBe('--memory is "128M": the runtime needs at least 256M to start: give 256M or more.');
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

  test("records the file it runs from, which the runtime later takes its updates from, and keeps how the runtime is kept from one up to the next", async () => {
    const m = machine();
    const copy = `${HOME}/.local/share/lumiah/lumiah.js`;
    const unitFile = `${HOME}/.config/systemd/user/lumiah-mara.service`;
    const saved = () => configOf(m.files.get(CONFIG)?.text ?? null, CONFIG);
    expect(await lumiah(UP, m.io)).toBe(0);
    expect(saved()).toMatchObject({ memory: "1G", autoUpdate: true, source: SELF, service: null });

    expect(await lumiah([...UP, "--systemd", "--memory", "768M"], m.io)).toBe(0);
    const service = { manager: "systemd", unit: "lumiah-mara.service", file: unitFile, bun: BUN, script: copy };
    expect(saved()).toMatchObject({ memory: "768M", source: SELF, service });

    // Set up again without --memory: the limit it had stays, in its config and in its unit.
    expect(await lumiah(["up", "--systemd"], m.io)).toBe(0);
    expect(saved().memory).toBe("768M");
    expect(m.files.get(unitFile)?.text).toBe(unitText({ name: "mara", bun: BUN, script: copy, config: CONFIG, memory: "768M" }));

    // As the Runtime page leaves it: a limit changed there, updates taken only from its button.
    m.files.set(CONFIG, { text: configText({ ...saved(), memory: "2G", autoUpdate: false }), mode: 0o600, dirMode: 0o700 });
    expect(await lumiah(["up", "--systemd"], m.io)).toBe(0);
    expect(saved()).toMatchObject({ memory: "2G", autoUpdate: false, service });
    expect(m.files.get(unitFile)?.text).toContain("MemoryMax=2G");

    // In the foreground: the unit installed is still the runtime's until `lumiah down` removes it.
    expect(await lumiah(["up"], m.io)).toBe(0);
    expect(saved()).toMatchObject({ memory: "2G", autoUpdate: false, source: SELF, service });
  });

  test("keeps the limit its unit held it to when it was set up before the limit was kept in its config, unless --memory gives another", async () => {
    const m = machine();
    const unitFile = `${HOME}/.config/systemd/user/lumiah-mara.service`;
    const saved = () => configOf(m.files.get(CONFIG)?.text ?? null, CONFIG);
    // As a build before this one left it: the unit `up --systemd --memory 768M` wrote, and a config that says nothing of a limit or of a unit.
    const before = (): void => {
      const { name, base, extension, listen, port, relay, secret, session, tuning } = saved();
      m.files.set(CONFIG, { text: JSON.stringify({ lumiah: 1, runtime: { name, base, extension, listen, port, relay, secret, session, tuning } }), mode: 0o600, dirMode: 0o700 });
    };
    expect(await lumiah([...UP, "--systemd", "--memory", "768M"], m.io)).toBe(0);
    before();
    expect(saved()).toMatchObject({ memory: "1G", service: null });

    expect(await lumiah(["up", "--systemd"], m.io)).toBe(0);
    expect(saved().memory).toBe("768M");
    expect(m.files.get(unitFile)?.text).toContain("MemoryMax=768M");

    before();
    expect(await lumiah(["up", "--systemd", "--memory", "2G"], m.io)).toBe(0);
    expect(saved().memory).toBe("2G");
    expect(m.files.get(unitFile)?.text).toContain("MemoryMax=2G");

    // A unit holding a limit this build refuses (less than the runtime needs to start) gives it nothing to keep.
    before();
    m.files.set(unitFile, { text: (m.files.get(unitFile)?.text ?? "").replace("MemoryMax=2G", "MemoryMax=64M"), mode: 0o644, dirMode: 0o755 });
    expect(await lumiah(["up", "--systemd"], m.io)).toBe(0);
    expect(saved().memory).toBe("1G");
  });
});

describe("a runtime's config", () => {
  const BEFORE = { name: "mara", base: "http://127.0.0.1:7860", listen: "127.0.0.1", port: 7871, relay: "relay-1", secret: "a".repeat(64), session: { username: "mara", token: "session-token-mara", savedAt: 5 }, tuning: {} };
  const text = (runtime: object): string => JSON.stringify({ lumiah: 1, runtime });

  test("written before this build reads, with how a runtime is kept by default; so does one holding values this build refuses", () => {
    expect(configOf(text(BEFORE), CONFIG)).toMatchObject({ name: "mara", extension: "lumi_ah", memory: "1G", autoUpdate: true, source: null, service: null });
    expect(configOf(text({ ...BEFORE, memory: "12Q", autoUpdate: "yes", source: "dist/lumiah.js", service: { manager: "launchd", unit: "lumiah.mara" } }), CONFIG)).toMatchObject({ memory: "1G", autoUpdate: true, source: null, service: null });
    // What it keeps, it reads back as it was written.
    const kept = { ...configOf(text(BEFORE), CONFIG), memory: "2G", autoUpdate: false, source: SELF, service: { manager: "systemd" as const, unit: "lumiah-mara.service", file: `${HOME}/.config/systemd/user/lumiah-mara.service`, bun: BUN, script: `${HOME}/.local/share/lumiah/lumiah.js` } };
    expect(configOf(configText(kept), CONFIG)).toEqual(kept);
  });

  test("naming its runtime with a name no runtime can have is no config this lumiah reads: its own folder and unit go by that name", () => {
    expect(() => configOf(text({ ...BEFORE, name: "../../elsewhere" }), CONFIG)).toThrow(`${CONFIG} isn't a runtime config this lumiah reads. Set the runtime up again with: lumiah up`);
  });

  test("says where a runtime keeps its data: the account's data folder, a folder of its own there, and lumiah's installed copies", () => {
    expect(dataDir({}, HOME)).toBe(`${HOME}/.local/share/lumiah`);
    expect(dataDir({ XDG_DATA_HOME: "/data/mara" }, HOME)).toBe("/data/mara/lumiah");
    // The XDG spec says to ignore a relative one.
    expect(dataDir({ XDG_DATA_HOME: "data" }, HOME)).toBe(`${HOME}/.local/share/lumiah`);
    expect(runtimeDir(dataDir({}, HOME), "mara")).toBe(`${HOME}/.local/share/lumiah/runtimes/mara`);
    expect(installedPath(dataDir({}, HOME), "lumi_ah")).toBe(`${HOME}/.local/share/lumiah/lumiah.js`);
    expect(installedPath(dataDir({}, HOME), "other_ext")).toBe(`${HOME}/.local/share/lumiah/other_ext/lumiah.js`);
  });
});

describe("lumiah down", () => {
  test("stops and removes the unit; the config stays, and names no unit any more", async () => {
    const m = machine();
    expect(await lumiah([...UP, "--systemd"], m.io)).toBe(0);
    const before = configOf(m.files.get(CONFIG)?.text ?? null, CONFIG);
    m.ran.length = 0;

    expect(await lumiah(["down"], m.io)).toBe(0);
    expect(m.files.has(`${HOME}/.config/systemd/user/lumiah-mara.service`)).toBe(false);
    expect(configOf(m.files.get(CONFIG)?.text ?? null, CONFIG)).toEqual({ ...before, service: null });
    expect(m.ran.filter((line) => line.startsWith("systemctl"))).toEqual(["systemctl --user disable --now lumiah-mara.service", "systemctl --user daemon-reload"]);
    expect(m.out.at(-1)).toBe(`Stopped and removed lumiah-mara.service. Its config, with the runtime's session, stays in ${CONFIG}: delete it to forget the runtime here.`);
  });
});

describe("lumiah up --extension, for an extension that has LumiAH built in", () => {
  const OTHER_SELF = "/srv/lumiverse/extensions/other_ext/dist/lumiah.js";
  const OTHER_CONFIG = `${HOME}/.config/lumiah/mara-other_ext.json`;
  const signIns = (m: Machine): number => m.asked.filter((line) => line === "POST /api/auth/sign-in/username").length;

  /** LumiAH's machine with that extension installed beside it; `io` runs the extension's own copy of the runtime. */
  function both() {
    const m = machine();
    const other = new FakeHost("other_ext", m.host);
    createBackend(other, ENV, { identity: { name: "Lantern", connectionName: "Lantern loopback" } });
    return { m, other, io: { ...m.io, self: OTHER_SELF } };
  }

  /** What LumiAH's own runtime has on the machine and in Lumiverse. */
  const ownOf = (m: Installed) => ({
    config: m.files.get(CONFIG)?.text,
    unit: m.files.get(`${HOME}/.config/systemd/user/lumiah-mara.service`)?.text,
    copy: m.files.get(`${HOME}/.local/share/lumiah/lumiah.js`)?.text,
    registry: JSON.stringify(m.host.stored(USER, "registry.json")),
  });

  test("gives that runtime a name, a config, a port, a unit, an installed copy and a connection of its own, and leaves LumiAH's as they were", async () => {
    const { m, other, io } = both();
    expect(await lumiah([...UP, "--systemd"], m.io)).toBe(0);
    const own = ownOf(m);

    expect(await lumiah([...UP, "--extension", "other_ext", "--systemd"], io)).toBe(0);
    // Nothing serves on LumiAH's port while this runs (its service is the fake's to start), and the port is still LumiAH's.
    // It takes its updates from that extension's own file, and its unit is its own.
    expect(configOf(m.files.get(OTHER_CONFIG)?.text ?? null, OTHER_CONFIG)).toMatchObject({ name: "mara-other_ext", extension: "other_ext", port: 7872, source: OTHER_SELF, service: { unit: "lumiah-mara-other_ext.service", script: `${HOME}/.local/share/lumiah/other_ext/lumiah.js` } });
    expect(m.files.get(`${HOME}/.config/systemd/user/lumiah-mara-other_ext.service`)?.text).toBe(unitText({ name: "mara-other_ext", bun: BUN, script: `${HOME}/.local/share/lumiah/other_ext/lumiah.js`, config: OTHER_CONFIG, memory: "1G" }));
    expect(m.files.get(`${HOME}/.local/share/lumiah/other_ext/lumiah.js`)?.text).toBe(`copy of ${OTHER_SELF}`);
    expect(m.ran.filter((line) => line.startsWith("systemctl")).slice(-3)).toEqual(["systemctl --user daemon-reload", "systemctl --user enable lumiah-mara-other_ext.service", "systemctl --user restart lumiah-mara-other_ext.service"]);
    // It registered with that extension and no other, and goes by that extension's names.
    expect(JSON.stringify(other.stored(USER, "registry.json"))).toContain('"name":"mara-other_ext"');
    expect(m.out.join("\n")).toContain('Registered the runtime "mara-other_ext" with Lantern: it answers mara\'s replies.');
    expect(m.out.join("\n")).toContain("Mint your loopback key on Lantern's Runtime page next");
    expect(m.host.connectionList).toMatchObject([
      { name: "LumiAH", provider: "custom", url: "http://127.0.0.1:7871/v1", model: "lumiah" },
      { name: "Lantern loopback", provider: "custom", url: "http://127.0.0.1:7872/v1", model: "lumiah-other_ext" },
    ]);
    expect(ownOf(m)).toEqual(own);
  });

  test("set up again by the lines their pages show, each runtime keeps its own sign-in, name and port", async () => {
    const { m, io } = both();
    expect(await lumiah(UP, m.io)).toBe(0);
    expect(await lumiah([...UP, "--extension", "other_ext"], io)).toBe(0);
    expect(signIns(m)).toBe(2);

    // The update lines name the runtime; with no name, a line means the only runtime here of its extension.
    expect(await lumiah(["up", "--name", "mara"], m.io)).toBe(0);
    expect(await lumiah(["up", "--name", "mara-other_ext", "--extension", "other_ext"], io)).toBe(0);
    expect(await lumiah(["up"], m.io)).toBe(0);
    expect(await lumiah(["up", "--extension", "other_ext"], io)).toBe(0);
    expect(signIns(m)).toBe(2);
    expect(configOf(m.files.get(CONFIG)?.text ?? null, CONFIG)).toMatchObject({ name: "mara", extension: "lumi_ah", port: 7871 });
    expect(configOf(m.files.get(OTHER_CONFIG)?.text ?? null, OTHER_CONFIG)).toMatchObject({ name: "mara-other_ext", extension: "other_ext", port: 7872 });
    expect([...m.files.keys()].sort()).toEqual([OTHER_CONFIG, CONFIG]);
    // Each found its own connection again and made no other.
    expect(m.host.connectionList.map((c) => c.name)).toEqual(["LumiAH", "Lantern loopback"]);
  });

  test("refuses to take the name or the port of LumiAH's own runtime, and says what to do", async () => {
    const { m, other, io } = both();
    expect(await lumiah(UP, m.io)).toBe(0);
    const own = ownOf(m);

    expect(await lumiah([...UP, "--name", "mara", "--extension", "other_ext"], io)).toBe(1);
    expect(m.err.at(-1)).toBe(`There is a runtime "mara" here already, and it links to the extension lumi_ah: this line would make it other_ext's instead. Give this one a name of its own with --name, or remove that one first (lumiah down --name mara, then delete ${CONFIG}).`);
    expect(await lumiah([...UP, "--extension", "other_ext", "--port", "7871"], io)).toBe(1);
    expect(m.err.at(-1)).toBe(`Port 7871 on 127.0.0.1 is the runtime "mara"'s, set up here too. Pick another with --port.`);

    expect(ownOf(m)).toEqual(own);
    expect([...m.files.keys()]).toEqual([CONFIG]);
    expect(other.stored(USER, "registry.json")).toBeNull();
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

/** The machine's HTTP, with the runtime's own port answered by a runtime that runs in the test, as one serving there would. */
function reaching(m: Machine, runtime: { fetch(request: Request): Promise<Response> }, port: number): RuntimeIO["http"] {
  return async (request) => {
    const url = new URL(request.url);
    if (url.port !== String(port)) return m.io.http(request);
    const response = await runtime.fetch(new Request(request.url, { method: request.method, headers: { ...request.headers, host: url.host } }));
    const text = await response.text();
    return { status: response.status, header: (name) => response.headers.get(name), text };
  };
}

const USAGE: AgentUsage = { calls: 1, toolTurns: 0, in: 10, cachedIn: 0, out: 5, reasoningOut: 0, estimated: false, ms: 1 };

/**
 * A runtime set up on a machine before, running, with a reply under way: the reply waits, then asks
 * the model for its words over the link, with the secret the runtime started with. `io` is the
 * machine as `up` finds it: the runtime answers on its port, the reply goes on whenever `up` waits,
 * and `order` notes when the reply ended, when the runtime was registered anew, and when its
 * service was restarted. `linked` is whether the extension had the runtime's session to push to,
 * each time `up` began to wait.
 */
async function answering() {
  const gate = Promise.withResolvers<void>();
  const it = await rig({
    harness: (host) => ({
      answer: async (_turn, sink, signal) => {
        await gate.promise;
        const { content } = await host.models.call({ messages: [{ role: "user", content: "Who keeps the harbour light now?" }], maxTokens: 64, connectionId: null, model: null }, signal);
        sink.content(content);
        sink.done("stop", USAGE);
        return { status: "done", record: null, reply: content, usage: USAGE };
      },
    }),
  });
  const chatId = await it.setUp();
  // Its store open first: a runtime whose registration `up` replaces while its store still opens would wait the whole Storage wait as it stops, its link hearing of it only at its next ping.
  await it.mirrored();
  it.host.script = ["Okoro keeps it now."];
  // Its config, as `up` wrote it then: the registration the runtime runs with.
  const m = machineOn(it.lumiverse);
  m.files.set(CONFIG, { text: configText({ name: "mara", base: it.lumiverse.base, extension: it.host.identifier, listen: "127.0.0.1", port: PORT, relay: it.registration.relay, secret: it.registration.secret, session: { username: "mara", token: it.lumiverse.token, savedAt: 0 }, tuning: FAST, ...SETUP_DEFAULTS }), mode: 0o600, dirMode: 0o700 });
  const order: string[] = [];
  const linked: boolean[] = [];
  const generating = it.generate(chatId).then((out) => {
    order.push("the reply ended");
    return out;
  });
  await until(() => it.runtime.turns.count === 1, "the reply to be under way");
  const io: RuntimeIO = {
    ...m.io,
    out: (text) => {
      if (text.startsWith("Registered the runtime")) order.push("the runtime was registered anew");
      m.io.out(text);
    },
    http: reaching(m, it.runtime, PORT),
    sleep: async () => {
      linked.push(it.backend.relays.isLinked(USER, it.registration.relay));
      gate.resolve();
      await generating;
    },
    run: async (command, args, env) => {
      if (command === "systemctl" && args.includes("restart")) order.push("the service was restarted");
      return m.io.run(command, args, env);
    },
  };
  const close = async (): Promise<void> => {
    gate.resolve();
    await it.close();
  };
  return { it, m, io, order, linked, generating, close };
}

describe("lumiah up over a runtime set up before", () => {
  test("keeps the registration a running runtime answers with: a reply under way ends as it would have, and only then is the service restarted", async () => {
    const { it, m, io, order, linked, generating, close } = await answering();
    try {
      expect(await lumiah(["up", "--name", "mara", "--systemd"], io)).toBe(0);

      expect(await generating).toMatchObject({ status: 200, error: null, content: "Okoro keeps it now.", finish: "stop" });
      expect(order).toEqual(["the reply ended", "the service was restarted"]);
      expect(m.out).toContain('The runtime "mara" keeps its registration with LumiAH: it answers mara\'s replies.');
      expect(m.out).toContain("The running runtime has 1 request(s) under way: waiting up to 5 minutes for them to finish before restarting it.");
      // Registering left the runtime's link as it was: while `up` waited, the extension still had its session to push to.
      expect(linked).toEqual([true]);
      expect(it.runtime.link.refused).toBeNull();
      // And the service starts again with the registration the runtime ran with.
      const config = configOf(m.files.get(CONFIG)?.text ?? null, CONFIG);
      expect({ relay: config.relay, secret: config.secret }).toEqual(it.registration);
    } finally {
      await close();
    }
  });

  test("given another address for Lumiverse, where it must register anew, waits for the reply under way before it does", async () => {
    const { it, m, io, order, generating, close } = await answering();
    try {
      // Another name for the same Lumiverse: the saved secret isn't shown to an address it wasn't minted at, so the registration is replaced.
      expect(await lumiah(["up", "--name", "mara", "--url", "http://localhost:7860", "--username", "mara", "--systemd"], io)).toBe(0);

      expect(await generating).toMatchObject({ status: 200, error: null, content: "Okoro keeps it now.", finish: "stop" });
      expect(order).toEqual(["the reply ended", "the runtime was registered anew", "the service was restarted"]);
      expect(m.out).toContain("The running runtime has 1 request(s) under way: waiting up to 5 minutes for them to finish before registering it anew.");
      expect(configOf(m.files.get(CONFIG)?.text ?? null, CONFIG).secret).not.toBe(it.registration.secret);
    } finally {
      await close();
    }
  });

  test("keeps its registration while the secret it saved is still the extension's, and registers anew once it isn't", async () => {
    const host = new FakeHost();
    const backend = createBackend(host, ENV);
    const m = machineOn(new FakeLumiverse(host, USER));
    const saved = () => configOf(m.files.get(CONFIG)?.text ?? null, CONFIG);
    expect(await lumiah(UP, m.io)).toBe(0);
    const first = saved();
    expect(m.out).toContain('Registered the runtime "mara" with LumiAH: it answers mara\'s replies.');

    expect(await lumiah(UP, m.io)).toBe(0);
    expect({ relay: saved().relay, secret: saved().secret }).toEqual({ relay: first.relay, secret: first.secret });
    expect(m.out).toContain('The runtime "mara" keeps its registration with LumiAH: it answers mara\'s replies.');

    // Forgotten on the Runtime page: the secret it saved speaks for no runtime any more, so there is none to keep.
    await backend.relays.forget(USER, first.relay);
    m.out.length = 0;
    expect(await lumiah(UP, m.io)).toBe(0);
    expect(saved().secret).not.toBe(first.secret);
    expect(m.out).toContain('Registered the runtime "mara" with LumiAH: it answers mara\'s replies.');
    expect(Object.keys((await backend.registry.read(USER)).relays)).toEqual([saved().relay]);
  });
});

describe("lumiah status", () => {
  test("reads a runtime that listens beyond loopback, which tells a request that shows nothing only that it is up", async () => {
    const host = new FakeHost();
    createBackend(host, ENV);
    const lumiverse = new FakeLumiverse(host, USER);
    const m = machineOn(lumiverse);
    expect(await lumiah([...UP, "--listen", "0.0.0.0"], m.io)).toBe(0);
    expect(m.err.join("\n")).toContain("Your loopback key and every prompt cross to it in clear http");
    const config = configOf(m.files.get(CONFIG)?.text ?? null, CONFIG);
    // The runtime that config starts, serving where the config says.
    const runtime = runtimeFrom(config, lumiverse, [], { harness: m.io.harness });
    try {
      await runtime.link.connect();
      m.out.length = 0;

      expect(await lumiah(["status"], { ...m.io, http: reaching(m, runtime, config.port) })).toBe(0);

      expect(m.out).toContain("It answers: link to LumiAH up, 0 turn(s) under way.");
      const bare = await runtime.fetch(new Request(`http://192.0.2.7:${config.port}/healthz`, { headers: { host: `192.0.2.7:${config.port}` } }));
      expect(await bare.json()).toEqual({ up: true });
    } finally {
      await runtime.close();
    }
  });

  test("says that a runtime that is stopping is stopping, not that something else answers on its port", async () => {
    const host = new FakeHost();
    createBackend(host, ENV);
    const lumiverse = new FakeLumiverse(host, USER);
    const m = machineOn(lumiverse);
    expect(await lumiah(UP, m.io)).toBe(0);
    const config = configOf(m.files.get(CONFIG)?.text ?? null, CONFIG);
    const runtime = runtimeFrom(config, lumiverse, [], { harness: m.io.harness });
    try {
      await runtime.link.connect();
      // It has begun to stop, and holds its port until its link has closed.
      runtime.shutdown();
      m.out.length = 0;

      expect(await lumiah(["status"], { ...m.io, http: reaching(m, runtime, config.port) })).toBe(1);

      const said = m.out.join("\n");
      expect(said).toContain("stopping");
      expect(said).not.toContain("Something answers");
    } finally {
      await runtime.close();
    }
  });
});

describe("lumiah serve", () => {
  const OWN = runtimeDir(dataDir({}, HOME), "mara");

  test("makes the runtime's own folder, its owner's alone, and runs the runtime with it", async () => {
    const m = machine();
    expect(await lumiah(UP, m.io)).toBe(0);
    expect(m.folders.get(OWN)).toMatchObject({ mode: 0o700 });
  });

  test("where a copy of the runtime answers on its port already, serves nothing and waits, marking that it does; asked to stop, it leaves, and its mark with it", async () => {
    const host = new FakeHost();
    createBackend(host, ENV);
    const lumiverse = new FakeLumiverse(host, USER);
    const m = machineOn(lumiverse);
    expect(await lumiah(UP, m.io)).toBe(0);
    const config = configOf(m.files.get(CONFIG)?.text ?? null, CONFIG);
    // The copy started first, from the same config, answers on the runtime's port.
    const first = runtimeFrom(config, lumiverse, [], { harness: m.io.harness });
    try {
      const served = m.served.length;
      const marks: string[] = [];
      const io: RuntimeIO = {
        ...m.io,
        http: reaching(m, first, config.port),
        files: { ...m.io.files, write: (path, text, mode, dirMode) => (path.endsWith("/waiting.json") ? void marks.push(text) : m.io.files.write(path, text, mode, dirMode)) },
      };
      expect(await lumiah(["serve"], io)).toBe(0);
      expect(m.served).toHaveLength(served);
      expect(m.err.join("\n")).toContain("another copy of this runtime serves on 127.0.0.1:7871: this one waits, and serves once that one stops");
      expect(JSON.parse(marks[0] ?? "null")).toMatchObject({ pid: 4242 });
      expect(m.err.at(-1)).toContain("stopping (SIGTERM) before it served");
    } finally {
      await first.close();
    }
  });

  test("waits for a copy of itself whose secret the Runtime page rotated after this one read its config, and serves with the secret the config holds then", async () => {
    const host = new FakeHost();
    createBackend(host, ENV);
    const lumiverse = new FakeLumiverse(host, USER);
    const m = machineOn(lumiverse);
    expect(await lumiah(UP, m.io)).toBe(0);
    const config = configOf(m.files.get(CONFIG)?.text ?? null, CONFIG);
    const rotated = { ...config, secret: "b".repeat(64) };
    // The copy that serves, its secret rotated: it writes the new one to the config just after this copy read it.
    const first = runtimeFrom(rotated, lumiverse, [], { harness: m.io.harness });
    let firstServes = true;
    const port: { fetch: ((req: Request) => Promise<Response>) | null } = { fetch: null };
    const stop = Promise.withResolvers<string>();
    const io: RuntimeIO = {
      ...m.io,
      // While the first copy serves, the port is its own; once it has stopped, nothing answers there.
      http: (request) => (firstServes ? reaching(m, first, config.port)(request) : m.io.http(request)),
      stopped: () => {
        m.files.set(CONFIG, { text: configText(rotated), mode: 0o600, dirMode: 0o700 });
        return stop.promise;
      },
      // The first copy stops while this one waits.
      sleep: async () => {
        firstServes = false;
      },
      serve: (options) => {
        port.fetch = options.fetch;
        return { stop: () => undefined };
      },
    };
    try {
      const serving = lumiah(["serve"], io);
      await until(() => port.fetch !== null, "this copy to serve once the first has stopped");
      expect(m.err.join("\n")).toContain("another copy of this runtime serves on 127.0.0.1:7871");
      // Its own answer to the probe is made with the rotated secret: the one it links with too.
      const nonce = "0123456789abcdef0123456789abcdef";
      const probe = await port.fetch?.(new Request(`http://127.0.0.1:${config.port}/x/ask`, { method: "POST", headers: { host: `127.0.0.1:${config.port}`, "content-type": "application/json", [PROBE_HEADER]: nonce }, body: "{}" }));
      expect(await probe?.json()).toEqual({ proof: await roadProof(rotated.secret, config.relay, nonce) });
      stop.resolve("SIGTERM");
      expect(await serving).toBe(0);
    } finally {
      await first.close();
    }
  });

  test("where something else answers on its port, even as a runtime would, it doesn't wait for it: it stops at once, saying the port is held, and serves nothing", async () => {
    const m = machine();
    expect(await lumiah(UP, m.io)).toBe(0);
    const served = m.served.length;
    const marks: string[] = [];
    const io: RuntimeIO = {
      ...m.io,
      // Another program on the runtime's port says it is up, to whatever asks it anything.
      http: async (request) => (new URL(request.url).port === "7871" ? { status: 200, header: () => null, text: JSON.stringify({ up: true, ok: true, link: "up", backend: "LumiAH", turns: 0, requests: 0 }) } : m.io.http(request)),
      files: { ...m.io.files, write: (path, text, mode, dirMode) => (path.endsWith("/waiting.json") ? void marks.push(text) : m.io.files.write(path, text, mode, dirMode)) },
    };
    expect(await lumiah(["serve"], io)).toBe(1);
    expect(m.served).toHaveLength(served);
    expect(marks).toEqual([]);
    expect(m.err.at(-1)).toContain("127.0.0.1:7871");
  });

  test("where something holds its port and never answers, it gives up asking within 5 seconds, and serves nothing", async () => {
    const m = machine();
    expect(await lumiah(UP, m.io)).toBe(0);
    const served = m.served.length;
    const io: RuntimeIO = {
      ...m.io,
      // Whatever holds the runtime's port takes each request and answers none.
      http: (request) => {
        if (new URL(request.url).port !== "7871") return m.io.http(request);
        const { promise, reject } = Promise.withResolvers<never>();
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
        return promise;
      },
    };
    expect(await lumiah(["serve"], io)).toBe(1);
    expect(m.served).toHaveLength(served);
  }, 15_000);

  test("stopping, it keeps its port until its link has closed, and meanwhile answers nothing there but the road's probe and GET /healthz, which says it is stopping", async () => {
    const m = machine();
    expect(await lumiah(UP, m.io)).toBe(0);
    const config = configOf(m.files.get(CONFIG)?.text ?? null, CONFIG);
    // Its port: the handler on it, whether it is held, and whether the runtime's link was still open when it was let go.
    const port: { fetch: ((req: Request) => Promise<Response>) | null; held: boolean; freedWithLinkOpen: boolean | null } = { fetch: null, held: false, freedWithLinkOpen: null };
    // Its link's sockets open now; and what it saves, held on its way to the extension's storage while `holding`.
    let open = 0;
    let holding = false;
    const held: string[] = [];
    let send: (text: string) => void = () => undefined;
    const harness: { host: HarnessHost | null } = { host: null };
    const stop = Promise.withResolvers<string>();
    const io: RuntimeIO = {
      ...m.io,
      serve: (options) => {
        port.fetch = options.fetch;
        port.held = true;
        return {
          stop: () => {
            port.held = false;
            port.freedWithLinkOpen = open > 0;
          },
        };
      },
      stopped: () => stop.promise,
      openSocket: (url, events) => {
        const socket = m.io.openSocket(url, events);
        open++;
        send = (text) => socket.send(text);
        return {
          send: (text) => (holding && text.includes('"type":"doc.put"') ? void held.push(text) : socket.send(text)),
          close: () => {
            open--;
            socket.close();
          },
        };
      },
      harness: (host, settings, extension, place) => {
        harness.host = host;
        return m.io.harness(host, settings, extension, place);
      },
    };
    // A request on the road, as Lumiverse's proxy carries one to the runtime's port.
    const onRoad = (headers: Record<string, string>, body: string): Promise<Response> => {
      if (port.fetch === null) throw new Error("the runtime serves nothing");
      return port.fetch(new Request(`http://127.0.0.1:${config.port}/x/ask`, { method: "POST", headers: { host: `127.0.0.1:${config.port}`, "content-type": "application/json", ...headers }, body }));
    };
    // Any other request at the runtime's port, as Lumiverse or a program on the machine sends one.
    const at = (method: string, path: string): Promise<Response> => {
      if (port.fetch === null) throw new Error("the runtime serves nothing");
      return port.fetch(new Request(`http://127.0.0.1:${config.port}${path}`, { method, headers: { host: `127.0.0.1:${config.port}` } }));
    };
    let asks = 0;
    const storeState = (): Promise<Response> => onRoad({ authorization: `Bearer ${config.secret}` }, JSON.stringify({ ask: (asks++).toString(16).padStart(16, "0"), op: "store.state", args: {} }));
    // What `up` logged as it served and stopped is behind: what follows is this serve's.
    m.err.length = 0;
    const serving = lumiah(["serve"], io);
    // Linked, and keeping the extension's storage: what it saves goes to its own copy, then on to the storage.
    let mode: unknown = null;
    let asking = false;
    await until(() => {
      if (mode === "held") return true;
      if (!asking && port.fetch !== null) {
        asking = true;
        void storeState()
          .then((reply) => reply.json())
          .then((said: unknown) => {
            mode = isRecord(said) && isRecord(said.value) ? said.value.mode : null;
          })
          .finally(() => {
            asking = false;
          });
      }
      return false;
    }, "the runtime to keep the extension's storage");
    holding = true;
    await harness.host?.store.write("jobs/job-1.json", { state: "running" });
    await until(() => held.length > 0, "a save to be on its way to the storage");

    stop.resolve("SIGTERM");
    await until(() => m.err.some((line) => line.includes("stopping (SIGTERM)")), "the runtime to begin stopping");
    // It waits for the storage to take the save, its link open: the port is still its own, an ask with its secret is refused there (the road then asks over the link), and so is every other request but the probe, answered with the proof its secret makes, and `GET /healthz`, which says it is stopping.
    expect(port.held).toBe(true);
    expect(open).toBe(1);
    expect((await storeState()).status).toBe(503);
    const nonce = "0123456789abcdef0123456789abcdef";
    const probe = await onRoad({ [PROBE_HEADER]: nonce }, "{}");
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ proof: await roadProof(config.secret, config.relay, nonce) });
    expect((await at("GET", "/v1/models")).status).toBe(503);
    expect((await at("POST", "/healthz")).status).toBe(503);
    expect(await (await at("GET", "/healthz")).json()).toMatchObject({ stopping: true });

    holding = false;
    for (const text of held.splice(0)) send(text);
    expect(await serving).toBe(0);
    expect(port.held).toBe(false);
    expect(port.freedWithLinkOpen).toBe(false);
  });
});

describe("what lumiah checks before it runs anything", () => {
  test("--bun is written into the unit and the config as the file it leads to, the very one the check passed", async () => {
    const m = machine();
    m.links.set("/team/bin/bun", BUN);
    expect(await lumiah([...UP, "--systemd", "--bun", "/team/bin/bun"], m.io)).toBe(0);
    expect(m.files.get(`${HOME}/.config/systemd/user/lumiah-mara.service`)?.text).toContain(`ExecStart=${BUN} `);
    expect(configOf(m.files.get(CONFIG)?.text ?? null, CONFIG).service).toMatchObject({ bun: BUN });
  });

  test("refuses a config folder another account can change, as it refuses the files it runs", async () => {
    const m = machine();
    m.owners.set(`${HOME}/.config/lumiah`, { uid: 1000, gid: 1000, mode: 0o757 });
    expect(await lumiah(UP, m.io)).toBe(1);
    expect(m.err.at(-1)).toContain(`${HOME}/.config/lumiah: everyone else can change it`);
    expect(m.asked).toEqual([]);
  });

  test("a config naming an extension not of the form --extension takes, or a path with a control character, isn't read as it says", () => {
    const base = { name: "mara", base: "http://127.0.0.1:7860", listen: "127.0.0.1", port: 7871, relay: "relay-1", secret: "a".repeat(64), session: { username: "mara", token: "t", savedAt: 0 }, tuning: {} };
    const text = (runtime: object): string => JSON.stringify({ lumiah: 1, runtime });
    expect(() => configOf(text({ ...base, extension: "../other" }), CONFIG)).toThrow("isn't a runtime config this lumiah reads");
    const unit = { manager: "systemd", unit: "lumiah-mara.service", file: `${HOME}/.config/systemd/user/lumiah-mara.service`, bun: BUN, script: `${HOME}/.local/share/lumiah/lumiah.js\nExecStartPre=/bin/sh` };
    expect(configOf(text({ ...base, source: `${SELF}\u001b[2J`, service: unit }), CONFIG)).toMatchObject({ source: null, service: null });
    expect(() => unitText({ name: "mara", bun: BUN, script: `${HOME}/lumiah.js\nExecStartPre=/bin/sh`, config: CONFIG, memory: "1G" })).toThrow("holds a control character");
  });
});
