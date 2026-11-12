// The settings of how the runtime is run that the Runtime page shows and changes (PI-BUILD-PLAN
// §4.8): its memory limit, taken only in a form systemd reads and not under the floor the runtime
// needs to start, kept in its config and written into its unit (where systemd then holds it once the
// runtime restarts); and whether it takes an update by itself. Where nothing holds the runtime to the
// limit, the page is told so in plain words, and what would.

import { afterEach, describe, expect, test } from "bun:test";
import { memoryRefusal } from "../../../src/runtime/update/memory";
import { unitText } from "../../../src/runtime/update/service";
import { createUpdate } from "../../../src/runtime/update/update";
import { BUN, type Installed, installed, NEW, offerOf, type Setting } from "./installed";

let open: Installed | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

function setUp(setting: Setting = {}): Installed {
  open = installed(setting);
  return open;
}

describe("the runtime's settings", () => {
  test("say how it is run: its build, its limit, whether it updates by itself, its unit, and the files it was set up from and runs from", () => {
    const at = setUp({ unit: true });
    expect(createUpdate(at.deps).get()).toEqual({
      build: "1111aaaa",
      memory: "1G",
      memoryNote: null,
      autoUpdate: true,
      runs: "systemd",
      unit: "lumiah-mara.service",
      source: at.source,
      installed: at.copy,
      waiting: null,
      busy: false,
      restartNeeded: false,
      updating: false,
      problem: null,
      line: null,
    });
  });

  test("a new limit under its unit is saved and written into the unit, which systemd reads again; it holds once the runtime restarts, which it does when asked", async () => {
    const at = setUp({ unit: true });
    const update = createUpdate(at.deps);

    const changed = await update.set({ memory: "2G" });
    expect(changed.restart).toBe("needed");
    expect(changed.view).toMatchObject({ memory: "2G", restartNeeded: true, updating: false, problem: null });
    expect(at.saved).toEqual([{ memory: "2G" }]);
    expect(at.text(at.unitFile)).toBe(unitText({ name: "mara", bun: BUN, script: at.copy, config: at.configPath, memory: "2G" }));
    expect(at.ran).toEqual(["systemctl --user daemon-reload"]);

    expect((await update.set({ restart: true })).restart).toBe("restarting");
    expect(at.ran).toEqual(["systemctl --user daemon-reload", "systemctl --user restart --no-block lumiah-mara.service"]);
  });

  test("a limit set back to the one the runtime started with needs no restart, and asking for one does none", async () => {
    const at = setUp({ unit: true });
    const update = createUpdate(at.deps);
    await update.set({ memory: "2G" });

    const back = await update.set({ memory: "1G", restart: true });
    expect(back.restart).toBe("none");
    expect(back.view.restartNeeded).toBe(false);
    expect(at.ran).toEqual(["systemctl --user daemon-reload", "systemctl --user daemon-reload"]);
  });

  test("a limit systemd didn't read again is saved, says what to run, and isn't restarted for", async () => {
    const at = setUp({ unit: true });
    at.answers.set("daemon-reload", { code: 1, out: "", err: "Failed to reload daemon: Access denied\n" });
    const update = createUpdate(at.deps);

    const changed = await update.set({ memory: "2G", restart: true });
    expect(changed.restart).toBe("needed");
    expect(changed.view).toMatchObject({ problem: "The limit is in the unit, but systemd didn't read the unit again (Failed to reload daemon: Access denied). Have it read it with:", line: "systemctl --user daemon-reload" });
    expect(at.config.memory).toBe("2G");
    expect(at.ran).toEqual(["systemctl --user daemon-reload"]);
  });

  test("a limit where no unit runs the runtime is kept, and the page is told that nothing holds the runtime to it there, and what would", async () => {
    const linux = setUp({ runs: "source" });
    const update = createUpdate(linux.deps);
    const kept = await update.set({ memory: "512M" });
    expect(kept.restart).toBe("none");
    expect(linux.config.memory).toBe("512M");
    expect(linux.ran).toEqual([]);
    expect(kept.view).toMatchObject({ runs: "itself", unit: null, memory: "512M", memoryNote: `Nothing holds the runtime to this limit now: only its systemd service does, and it runs without one. To make it one, stop it and run: ${BUN} ${linux.source} up --name mara --systemd` });
    linux.close();

    const elsewhere = (setting: Setting): string | null => {
      const at = installed(setting);
      try {
        return createUpdate(at.deps).get().memoryNote;
      } finally {
        at.close();
      }
    };
    expect(elsewhere({ platform: "darwin" })).toBe("Nothing holds the runtime to this limit on macOS: only a systemd service applies it, on Linux. The limit is kept for when the runtime runs as one.");
    expect(elsewhere({ platform: "win32" })).toBe("Nothing holds the runtime to this limit on Windows: only a systemd service applies it, on Linux. The limit is kept for when the runtime runs as one.");
    expect(elsewhere({ container: true })).toBe("Nothing in the runtime holds it to this limit: in a container, the container's own memory limit does (mem_limit in its compose service).");
    // The runtime of an extension LumiAH is built into is made a service by that extension's own line.
    const lantern = { identifier: "lantern", name: "Lantern" };
    expect(elsewhere({ runs: "source", extension: lantern })).toEndWith(`/extensions/lantern/dist/lumiah.js up --name mara-lantern --extension lantern --systemd`);
  });

  test("turning updates by themselves on takes the update that waited, once nothing is under way", async () => {
    const at = setUp({ unit: true, autoUpdate: false });
    const update = createUpdate(at.deps);
    expect(await update.offer(offerOf(at))).toEqual({ taken: "waiting" });

    const on = await update.set({ autoUpdate: true });
    expect(on.restart).toBe("none");
    expect(at.saved).toEqual([{ autoUpdate: true }]);
    await update.tick();
    expect(at.text(at.copy)).toBe(NEW);
    expect(at.ran).toEqual(["systemctl --user restart --no-block lumiah-mara.service"]);
  });

  test("refuses what it can't take, in words that say what it takes, and changes nothing", async () => {
    const at = setUp({ unit: true });
    const update = createUpdate(at.deps);
    const unit = at.text(at.unitFile);

    await expect(update.set("2G")).rejects.toMatchObject({ code: "bad_request", message: "Say what to change: memory, autoUpdate, restart." });
    await expect(update.set({ memory: 2048 })).rejects.toMatchObject({ code: "bad_request", message: "The memory limit is a size, such as 768M or 2G." });
    await expect(update.set({ memory: "128M" })).rejects.toMatchObject({ code: "bad_request", message: `The memory limit "128M" can't be used: the runtime needs at least 256M to start: give 256M or more.` });
    // Nothing but a size reaches the unit's text.
    await expect(update.set({ memory: "1G\nExecStartPre=/bin/sh -c id" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(update.set({ autoUpdate: "yes" })).rejects.toMatchObject({ code: "bad_request", message: "autoUpdate is true (updates are taken by themselves) or false (only from the button)." });
    await expect(update.set({ memory: "2G", restart: "now" })).rejects.toMatchObject({ code: "bad_request", message: "restart is true or false." });

    expect(at.saved).toEqual([]);
    expect(at.text(at.unitFile)).toBe(unit);
    expect(at.ran).toEqual([]);
  });
});

describe("a memory limit", () => {
  test("is a size systemd reads, from the floor the runtime needs to start up to the most systemd counts, or infinity", () => {
    for (const taken of ["256M", "268435456", "262144K", "0256M", "1G", "2T", "16777215T", "18446744073709551615", "infinity"]) expect(memoryRefusal(taken)).toBeNull();
    for (const small of ["255M", "268435455", "262143K", "0", "0G"]) expect(memoryRefusal(small)).toBe("the runtime needs at least 256M to start: give 256M or more");
    for (const large of ["18446744073709551616", "16777216T"]) expect(memoryRefusal(large)).toBe("that is more than systemd can count: give a size such as 2G, or infinity for no limit");
    for (const unread of ["12Q", "1.5G", "1g", "2GB", "50%", "", " 1G", "-1G", "1G\n", "Infinity"]) expect(memoryRefusal(unread)).toBe("give a size as systemd reads one, such as 768M or 2G, or infinity for no limit");
  });
});
