// The runtime's update from the extension (PI-BUILD-PLAN §4.8), on a disk of its own: which offers
// it takes and which it refuses (and what it says instead), the installed copy it replaces and how
// (never part written, a crash included), how it restarts onto the new build, and when: by itself
// only once nothing is under way, or at once from the page's button.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nodeFiles } from "../../../src/runtime/update/files";
import { createUpdate } from "../../../src/runtime/update/update";
import { BUN, type Installed, installed, NEW, OLD, offerOf, type Setting, sha256 } from "./installed";

let open: Installed | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

function setUp(setting: Setting = {}): Installed {
  open = installed(setting);
  return open;
}

const RESTART = "systemctl --user restart --no-block lumiah-mara.service";

describe("an offer from the extension", () => {
  test("of the file the runtime was set up from, hashing as offered, is put in place of its installed copy, and its unit restarts it", async () => {
    const at = setUp({ unit: true });
    const update = createUpdate(at.deps);

    expect(await update.offer(offerOf(at))).toEqual({ taken: "updating" });

    expect(at.text(at.copy)).toBe(NEW);
    expect(statSync(at.copy).mode & 0o777).toBe(0o644);
    // Nothing of the write is left beside the copy.
    expect(readdirSync(dirname(at.copy))).toEqual(["lumiah.js"]);
    // Queued with the account's service manager, which outlives the process it then stops.
    expect(at.ran).toEqual([RESTART]);
    expect(at.envs).toEqual([{ XDG_RUNTIME_DIR: "/run/user/1000" }]);
    expect(at.left).toEqual([]);
    expect(update.get()).toMatchObject({ updating: true, waiting: null, problem: null });
  });

  test("is refused when it is unreadable, names another file, or the file's sha256 isn't the one offered, or the file isn't there; each says what to do, and nothing is written or run", async () => {
    const at = setUp({ unit: true });
    const update = createUpdate(at.deps);
    const elsewhere = join(at.dir, "elsewhere/lumiah.js");

    expect(await update.offer({ build: "2222bbbb", path: at.source, sha256: "not a sha256" })).toEqual({ refused: "LumiAH offered an update this runtime can't read: run the update line on LumiAH's Runtime page." });
    expect(await update.offer(offerOf(at, { path: elsewhere }))).toEqual({ refused: `LumiAH offers the runtime at ${elsewhere}, and this runtime was set up from ${at.source}. Run the update line on LumiAH's Runtime page once: from then on it updates from there.` });
    expect(await update.offer(offerOf(at, { sha256: sha256("// another build\n") }))).toEqual({ refused: `The runtime at ${at.source} isn't the build LumiAH offers (2222bbbb). When LumiAH has just been updated, it offers again once Lumiverse has loaded its new build; otherwise run the update line on LumiAH's Runtime page.` });
    rmSync(at.source);
    const missing = `There is no runtime at ${at.source}, where this runtime was set up from. Check that LumiAH is still installed in Lumiverse, then run the update line on LumiAH's Runtime page.`;
    expect(await update.offer(offerOf(at))).toEqual({ refused: missing });

    expect(at.text(at.copy)).toBe(OLD);
    expect(at.ran).toEqual([]);
    expect(at.left).toEqual([]);
    expect(update.get()).toMatchObject({ waiting: null, updating: false, problem: missing, line: null });
  });

  test("is refused by a runtime set up before it could update itself, which says to run its update line once", async () => {
    const at = setUp({ unit: true, source: null });
    const update = createUpdate(at.deps);

    expect(await update.offer(offerOf(at))).toEqual({ refused: "This runtime was set up before it could update itself. Run the update line on LumiAH's Runtime page once; from then on it updates by itself." });
    expect(at.text(at.copy)).toBe(OLD);
    expect(at.ran).toEqual([]);
  });

  test("of the build the runtime runs is nothing to do, whatever the offer calls it", async () => {
    // It runs the extension's file, which holds the build offered.
    const at = setUp({ runs: "source" });
    const update = createUpdate(at.deps);
    await update.offer(offerOf(at, { sha256: sha256("// another build\n") }));
    expect(update.get().problem).not.toBeNull();

    expect(await update.offer(offerOf(at, { build: "renamed-9999" }))).toEqual({ taken: "current" });
    expect(at.left).toEqual([]);
    expect(at.ran).toEqual([]);
    // What was wrong before is no longer so.
    expect(update.get()).toMatchObject({ waiting: null, updating: false, problem: null });
  });

  test("for a runtime that runs straight from the extension's file, copies nothing: restarting it onto the file is the update", async () => {
    const at = setUp({ runs: "source" });
    // It started on the build before; then the extension was updated, and its file holds the new one.
    writeFileSync(at.source, OLD);
    const update = createUpdate(at.deps);
    writeFileSync(at.source, NEW);

    expect(await update.offer(offerOf(at))).toEqual({ taken: "updating" });
    expect(at.left).toEqual([{ command: BUN, args: [at.source, "serve", "--config", at.configPath] }]);
    // lumiah's copy is no file this runtime runs: it is left as it was.
    expect(at.text(at.copy)).toBe(OLD);
    expect(at.ran).toEqual([]);
  });

  test("for a runtime no unit runs (launchd, Task Scheduler, a terminal), replaces lumiah's copy it runs and hands its process to its successor on it", async () => {
    const at = setUp({ runs: "copy", platform: "darwin" });
    const update = createUpdate(at.deps);

    expect(await update.offer(offerOf(at))).toEqual({ taken: "updating" });
    expect(at.text(at.copy)).toBe(NEW);
    expect(at.left).toEqual([{ command: BUN, args: [at.copy, "serve", "--config", at.configPath] }]);
    expect(at.ran).toEqual([]);
  });

  test("for a runtime that runs a file lumiah didn't install, writes nothing and says how to update it", async () => {
    const at = setUp({ unit: true });
    const own = join(at.dir, "opt/lumiah.js");
    const update = createUpdate({ ...at.deps, self: own });

    expect(await update.offer(offerOf(at))).toEqual({ refused: `This runtime runs from ${own}, a file it doesn't update: it updates only its own installed copy (${at.copy}), and nothing when it runs from ${at.source} itself. Copy ${at.source} over ${own} and restart the runtime, or run the update line on LumiAH's Runtime page.` });
    expect(at.text(at.copy)).toBe(OLD);
    expect(at.ran).toEqual([]);
  });

  test("for the runtime of an extension LumiAH is built into, comes from that extension's own file, and goes into that runtime's own copy alone", async () => {
    const at = setUp({ unit: true, extension: { identifier: "lantern", name: "Lantern" } });
    const update = createUpdate(at.deps);
    const lumiahs = join(at.dir, "extensions/lumi_ah/dist/lumiah.js");

    expect(await update.offer(offerOf(at, { path: lumiahs }))).toEqual({ refused: `Lantern offers the runtime at ${lumiahs}, and this runtime was set up from ${at.source}. Run the update line on Lantern's Runtime page once: from then on it updates from there.` });
    expect(await update.offer(offerOf(at))).toEqual({ taken: "updating" });
    expect(at.copy).toBe(join(at.dir, "home/.local/share/lumiah/lantern/lumiah.js"));
    expect(at.text(at.copy)).toBe(NEW);
    expect(at.ran).toEqual(["systemctl --user restart --no-block lumiah-mara-lantern.service"]);
  });
});

describe("when an update is taken", () => {
  test("by itself only once no turn and no job is under way: it waits, and is taken when the runtime falls idle", async () => {
    const at = setUp({ unit: true });
    const update = createUpdate(at.deps);
    at.busy = true;

    expect(await update.offer(offerOf(at))).toEqual({ taken: "waiting" });
    await update.tick();
    expect(update.get()).toMatchObject({ waiting: { build: "2222bbbb", since: 1_700_000_000_000 }, busy: true, updating: false });
    expect(at.text(at.copy)).toBe(OLD);
    expect(at.ran).toEqual([]);

    at.busy = false;
    await update.tick();
    expect(at.text(at.copy)).toBe(NEW);
    expect(at.ran).toEqual([RESTART]);
    expect(update.get()).toMatchObject({ waiting: null, updating: true });
  });

  test("with updates by themselves off, it waits for the button, which takes it whatever is under way", async () => {
    const at = setUp({ unit: true, autoUpdate: false });
    const update = createUpdate(at.deps);

    expect(await update.offer(offerOf(at))).toEqual({ taken: "waiting" });
    await update.tick();
    expect(at.ran).toEqual([]);

    at.busy = true;
    expect(await update.applyNow()).toMatchObject({ updating: true, waiting: null, busy: true });
    expect(at.text(at.copy)).toBe(NEW);
    expect(at.ran).toEqual([RESTART]);
  });

  test("the button with no update waiting says why", async () => {
    const at = setUp({ unit: true });
    const update = createUpdate(at.deps);

    await expect(update.applyNow()).rejects.toMatchObject({ code: "unavailable", message: "There is no update to take: this runtime is on the build LumiAH offered, or LumiAH hasn't offered one since it started." });
    await update.offer(offerOf(at, { sha256: sha256("// another build\n") }));
    await expect(update.applyNow()).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining(`The runtime at ${at.source} isn't the build LumiAH offers (2222bbbb).`) });
    expect(at.ran).toEqual([]);
  });

  test("by itself, a reply that begins while the new build is checked isn't cut: the update waits, and is taken once the runtime is idle again", async () => {
    for (const runs of ["copy", "source"] as const) {
      const at = setUp(runs === "copy" ? { unit: true } : { runs });
      // Running from the extension's own file, it started on the build before, which the extension's update then replaced.
      if (runs === "source") writeFileSync(at.source, OLD);
      const update = createUpdate(at.deps);
      if (runs === "source") writeFileSync(at.source, NEW);
      at.whileChecked = () => {
        at.busy = true;
      };

      expect(await update.offer(offerOf(at))).toEqual({ taken: "waiting" });
      expect(at.checked).toHaveLength(1);
      expect(at.text(at.copy)).toBe(OLD);
      // Nothing staged is left beside the copy, and nothing restarts.
      expect(readdirSync(dirname(at.copy))).toEqual(["lumiah.js"]);
      expect(at.ran).toEqual([]);
      expect(at.left).toEqual([]);
      expect(update.get()).toMatchObject({ waiting: { build: "2222bbbb" }, updating: false, problem: null });
      await update.tick();
      expect(at.checked).toHaveLength(1);

      at.whileChecked = null;
      at.busy = false;
      await update.tick();
      if (runs === "copy") {
        expect(at.text(at.copy)).toBe(NEW);
        expect(at.ran).toEqual([RESTART]);
      } else expect(at.left).toEqual([{ command: BUN, args: [at.source, "serve", "--config", at.configPath] }]);
      expect(update.get()).toMatchObject({ waiting: null, updating: true });
      open?.close();
    }
  });
});

describe("putting the new build in place", () => {
  test("a crash between writing the new build and renaming it over the copy leaves the copy whole, and the next offer after the restart finishes the update", async () => {
    // The machine stops right after the new build is written beside the copy: nothing after that runs.
    const lost = (): never => {
      throw new Error("the machine lost power");
    };
    const at = setUp({ unit: true, files: { rename: lost, remove: lost } });

    expect(await createUpdate(at.deps).offer(offerOf(at))).toEqual({ refused: `Couldn't put build 2222bbbb in place of ${at.copy} (the machine lost power). Copy it yourself, then restart the runtime:` });
    // The new build was written whole beside the copy; the copy itself is the old build, whole.
    expect(at.text(`${at.copy}.mara.tmp`)).toBe(NEW);
    expect(at.text(at.copy)).toBe(OLD);
    expect(at.ran).toEqual([]);

    // The runtime starts again on the build it had, and the extension offers the new one on its hello.
    const again = createUpdate({ ...at.deps, files: nodeFiles });
    expect(await again.offer(offerOf(at))).toEqual({ taken: "updating" });
    expect(at.text(at.copy)).toBe(NEW);
    // What the crash left beside the copy was written over and renamed into place.
    expect(readdirSync(dirname(at.copy))).toEqual(["lumiah.js"]);
    expect(at.ran).toEqual([RESTART]);
  });

  test("a copy it can't write is left as it was, and the runtime says how to copy it and restart", async () => {
    const at = setUp({
      unit: true,
      files: {
        write: () => {
          throw new Error("EACCES: permission denied");
        },
      },
    });
    const update = createUpdate(at.deps);

    expect(await update.offer(offerOf(at))).toEqual({ refused: `Couldn't put build 2222bbbb in place of ${at.copy} (EACCES: permission denied). Copy it yourself, then restart the runtime:` });
    expect(update.get()).toMatchObject({ updating: false, line: `cp ${at.source} ${at.copy} && systemctl --user restart lumiah-mara.service` });
    expect(at.text(at.copy)).toBe(OLD);
    expect(at.ran).toEqual([]);
  });
});

describe("restarting onto the new build", () => {
  test("where systemd won't restart it, the new build stays in place, with the line that restarts it", async () => {
    const at = setUp({ unit: true });
    at.answers.set("restart", { code: 1, out: "", err: "Failed to connect to bus: No medium found\n" });
    const update = createUpdate(at.deps);

    expect(await update.offer(offerOf(at))).toEqual({ refused: "Build 2222bbbb is in place, but systemd didn't restart the runtime (Failed to connect to bus: No medium found). Restart it with:" });
    expect(at.text(at.copy)).toBe(NEW);
    expect(update.get()).toMatchObject({ updating: false, line: "systemctl --user restart lumiah-mara.service" });
  });

  test("systemctl ended by the very stop it asked for had queued the restart: the update is on its way, and nothing is said to have failed", async () => {
    const at = setUp({ unit: true });
    // The stop reaches every process of the unit, and systemctl is one of them until it has gone.
    at.answers.set("restart", { code: 127, out: "", err: "Command failed: /usr/bin/systemctl --user restart --no-block lumiah-mara.service", signal: "SIGTERM" });
    const update = createUpdate(at.deps);

    expect(await update.offer(offerOf(at))).toEqual({ taken: "updating" });
    expect(at.text(at.copy)).toBe(NEW);
    expect(update.get().line).toBeNull();
  });

  test("where no Bun is known to run the new build with, it can't be checked, so the copy stays as it was and the page says why", async () => {
    const at = setUp({ runs: "copy", bun: null });
    const update = createUpdate(at.deps);

    expect(await update.offer(offerOf(at))).toEqual({ refused: "Build 2222bbbb can't start here (no Bun is known to run it with), so the runtime stays on build 1111aaaa. Update Bun, or the extension, and it is offered again." });
    expect(update.get()).toMatchObject({ updating: false, waiting: null, problem: expect.stringContaining("can't start here") });
    expect(at.text(at.copy)).toBe(OLD);
    expect(at.left).toEqual([]);
  });
});

describe("what the extension offers and how the runtime words it", () => {
  test("an offer naming a path with a control character is no offer, and no word the runtime logs or shows carries one", async () => {
    const at = setUp({ unit: true });
    const update = createUpdate(at.deps);
    for (const path of [`${at.source}\n[lumiah] forged line`, `${at.source}\u001b[2J`, `${at.source}\u009b31m`, `${at.source}\u2028`]) {
      expect(await update.offer(offerOf(at, { path }))).toEqual({ refused: "LumiAH offered an update this runtime can't read: run the update line on LumiAH's Runtime page." });
    }
    expect(at.text(at.copy)).toBe(OLD);
    expect(at.checked).toEqual([]);
    for (const words of [...at.logs, update.get().problem ?? ""]) expect(words).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  });

  test("a path of the runtime's own that holds a control character is shown escaped in its words", async () => {
    const at = setUp({ unit: true });
    const update = createUpdate({ ...at.deps, name: () => "Lantern\u001b[31m" });
    const elsewhere = join(at.dir, "elsewhere/lumiah.js");
    const outcome = await update.offer(offerOf(at, { path: elsewhere }));
    expect(outcome).toEqual({ refused: expect.stringContaining("Lantern\\u001b[31m offers the runtime at") });
    expect(JSON.stringify(outcome)).not.toContain("\u001b");
  });
});

describe("a new build that can't start here", () => {
  test("never takes the place of the copy that runs: the copy stays, nothing restarts, the offer is let go and the page says why", async () => {
    const at = setUp({ unit: true });
    at.version = { code: 1, out: "", err: "SyntaxError: Unexpected token '??='\n    at <parse> (lumiah.js:1:1)\n" };
    const update = createUpdate(at.deps);

    const outcome = await update.offer(offerOf(at));
    // Checked with the Bun its unit runs it with, where it was written beside the copy.
    expect(at.checked).toEqual([`${BUN} ${at.copy}.mara.tmp`]);
    expect(outcome).toEqual({ refused: `Build 2222bbbb can't start here (${BUN} ${at.copy}.mara.tmp --version ended with 1: SyntaxError: Unexpected token '??=' at <parse> (lumiah.js:1:1)), so the runtime stays on build 1111aaaa. Update Bun, or the extension, and it is offered again.` });
    expect(at.text(at.copy)).toBe(OLD);
    expect(readdirSync(dirname(at.copy))).toEqual(["lumiah.js"]);
    expect(at.ran).toEqual([]);
    expect(at.left).toEqual([]);
    expect(update.get()).toMatchObject({ waiting: null, updating: false, problem: expect.stringContaining("can't start here") });
    // The button has nothing to take; the next hello offers it again.
    await expect(update.applyNow()).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("can't start here") });
  });

  test("one that answers without a version is no runtime either", async () => {
    const at = setUp({ runs: "copy" });
    at.version = { code: 0, out: "Welcome to Bun\n", err: "" };
    const update = createUpdate(at.deps);
    expect(await update.offer(offerOf(at))).toEqual({ refused: expect.stringContaining("--version said no version: Welcome to Bun") });
    expect(at.text(at.copy)).toBe(OLD);
    expect(at.left).toEqual([]);
  });

  test("running from the extension's own file, it isn't restarted onto a new build there that can't start", async () => {
    const at = setUp({ runs: "source" });
    at.version = { code: 127, out: "", err: "error: Cannot find module" };
    // It started on the build before; then the extension was updated, and its file holds the new one.
    writeFileSync(at.source, OLD);
    const update = createUpdate(at.deps);
    writeFileSync(at.source, NEW);
    expect(await update.offer(offerOf(at))).toEqual({ refused: expect.stringContaining(`${BUN} ${at.source} --version ended with 127`) });
    expect(at.checked).toEqual([`${BUN} ${at.source}`]);
    expect(at.left).toEqual([]);
  });

  test("a build that starts is checked the same way before it is put in place", async () => {
    const at = setUp({ runs: "copy" });
    const update = createUpdate(at.deps);
    expect(await update.offer(offerOf(at))).toEqual({ taken: "updating" });
    expect(at.checked).toEqual([`${BUN} ${at.copy}.mara.tmp`]);
    expect(at.text(at.copy)).toBe(NEW);
    expect(at.left).toEqual([{ command: BUN, args: [at.copy, "serve", "--config", at.configPath] }]);
  });

  test("is given as long as New build's start check says to say its version; one that says none in that time is refused, in words that name that setting and where it is changed", async () => {
    const at = setUp({ unit: true });
    at.config = { ...at.config, tuning: { ...at.config.tuning, buildStartMs: 2_000 } };
    // Ended at its time limit, as `runProgram` reports it.
    at.version = { code: 127, out: "", err: "bun was ended after 2 seconds", late: true };
    const update = createUpdate(at.deps);

    const outcome = await update.offer(offerOf(at));
    expect(at.checkWaits).toEqual([2_000]);
    expect(outcome).toEqual({ refused: expect.stringContaining("can't start here") });
    expect(outcome).toEqual({ refused: expect.stringContaining("New build's start check (LumiAH's Settings → Timeouts → Waiting for the runtime)") });
    expect(outcome).toEqual({ refused: expect.stringContaining("2 seconds") });
    expect(at.text(at.copy)).toBe(OLD);
    expect(at.ran).toEqual([]);
  });
});
